import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, generateEncryptionKey, type AppConfig } from './config.js';
import { initDb, getDb, closeDb, applyMigrations } from './storage/database.js';
import { migrationStatus } from './storage/migrate.js';
import { decryptStorePassword, type StoreRow } from './storage/installations.js';
import { getAccount } from './insales/resources/account.js';
import { ApiError } from './insales/errors.js';

export async function runCli(args: string[]): Promise<number> {
  const command = args[0];
  switch (command) {
    case 'doctor':
      return cmdDoctor(args.includes('--api'));
    case 'cleanup':
      return cmdCleanup();
    case 'keygen':
      console.log(generateEncryptionKey());
      return 0;
    default:
      printUsage();
      return command ? 1 : 0;
  }
}

function printUsage(): void {
  console.log('Usage: tsx src/cli.ts <command>');
  console.log('');
  console.log('Commands:');
  console.log('  doctor          Проверить конфигурацию, ключ и БД');
  console.log('  doctor --api    Проверить account.json активных магазинов');
  console.log('  cleanup         Удалить просроченные временные записи');
  console.log('  keygen          Сгенерировать ключ шифрования (32 байта hex)');
}

async function cmdDoctor(checkApi: boolean): Promise<number> {
  console.log('Doctor check');
  let config: AppConfig;
  try {
    config = loadConfig();
    console.log('Конфигурация: OK');
    console.log(`   Режим: ${config.appEnv}`);
    console.log(`   БД: ${config.appDb}`);
    console.log(`   Разрешённые магазины: ${config.allowedShops.length}`);
    console.log(`   Базовый URL: ${config.appBaseUrl}`);
    console.log(config.appEncryptionKey.length === 32 ? 'Ключ шифрования: OK (32 байта)' : 'Ключ шифрования: ОШИБКА');
    if (!existsSync(config.appRuntimeDir)) {
      console.log('Директория runtime не существует (будет создана при запуске)');
    } else {
      console.log(`Runtime: ${config.appRuntimeDir}`);
    }
  } catch (err: unknown) {
    console.log('Конфигурация: ОШИБКА');
    if (err instanceof Error) console.log(`   ${err.message}`);
    return 1;
  }

  try {
    openDatabase(config);
    const migrations = migrationStatus(getDb());
    console.log(`База данных: OK (${migrations.length} миграций применено)`);
    for (const migration of migrations) {
      console.log(`   - Версия ${migration.version}: ${migration.appliedAt}`);
    }
  } catch (err: unknown) {
    console.log('База данных: ОШИБКА');
    if (err instanceof Error) console.log(`   ${err.message}`);
    closeDb();
    return 1;
  }

  if (!checkApi) {
    closeDb();
    return 0;
  }

  try {
    return await checkStoreApis(config);
  } finally {
    closeDb();
  }
}

async function checkStoreApis(config: AppConfig): Promise<number> {
  console.log('Проверка API магазинов (только чтение)');
  const stores = getDb().prepare('SELECT * FROM stores ORDER BY shop').all() as StoreRow[];
  if (stores.length === 0) {
    console.log('   Активных магазинов нет');
    return 0;
  }

  let failed = 0;
  for (const store of stores) {
    try {
      const password = decryptStorePassword(config, store);
      const { account } = await getAccount({
        appId: config.insalesAppId,
        shop: store.shop,
        password,
        allowHttp: config.localDemo,
        timeout: 5_000,
      });
      if (account.id !== store.id) {
        failed += 1;
        console.log(`   ${store.shop}: account.id не совпадает с установкой`);
      } else {
        console.log(`   ${store.shop}: OK, account.id совпадает`);
      }
    } catch (err: unknown) {
      failed += 1;
      if (err instanceof ApiError && err.status > 0) {
        console.log(`   ${store.shop}: HTTP ${err.status}`);
      } else {
        console.log(`   ${store.shop}: временная ошибка API`);
      }
    }
  }
  return failed === 0 ? 0 : 1;
}

async function cmdCleanup(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
    openDatabase(config);
    const db = getDb();
    const expiredChallenges = db.prepare(`DELETE FROM login_challenges WHERE expires_at <= datetime('now')`).run();
    const expiredSessions = db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
    const expiredCandidates = db.prepare(`DELETE FROM install_candidates WHERE CAST(expires_at AS INTEGER) <= unixepoch()`).run();
    console.log('Очистка завершена:');
    console.log(`   - Удалено истекших challenge: ${expiredChallenges.changes}`);
    console.log(`   - Удалено истекших сессий: ${expiredSessions.changes}`);
    console.log(`   - Удалено истекших кандидатов: ${expiredCandidates.changes}`);
    return 0;
  } catch (err: unknown) {
    console.log('Очистка: ОШИБКА');
    if (err instanceof Error) console.log(`   ${err.message}`);
    return 1;
  } finally {
    closeDb();
  }
}

function openDatabase(config: AppConfig): void {
  if (!existsSync(config.appRuntimeDir)) {
    mkdirSync(config.appRuntimeDir, { recursive: true, mode: 0o700 });
  }
  initDb(config);
  applyMigrations(config);
}

function isDirectRun(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return fileURLToPath(import.meta.url) === resolve(argvPath);
}

if (isDirectRun()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((err: unknown) => {
    console.error('CLI error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
