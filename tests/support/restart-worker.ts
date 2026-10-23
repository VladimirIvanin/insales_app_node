import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { initDb, applyMigrations, closeDb, getDb } from '../../src/storage/database.js';
import { verifyCandidate } from '../../src/application/installation.js';
import { completeAutologin } from '../../src/http/auth.js';
import { getSession } from '../../src/storage/sessions.js';
import { decryptStorePassword, getStore } from '../../src/storage/installations.js';

function isDirectRun(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return pathToFileURL(resolve(argvPath)).href === import.meta.url;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const config = loadConfig({ env: process.env, readEnvFile: false });
  initDb(config);
  applyMigrations(config);

  const emit = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  try {
    if (command === 'verify') {
      const storeId = process.env.STORE_ID ?? '';
      const result = await verifyCandidate(config, storeId, process.env.SHOP ?? '', {
        appId: config.insalesAppId,
        allowHttp: config.localDemo,
        timeout: 5_000,
      });
      const store = getStore(storeId);
      if (store) decryptStorePassword(config, store);
      emit({
        ok: true,
        diagnostic: result.diagnostic,
        generation: result.generation,
        activeGeneration: store?.generation ?? null,
        title: store?.title ?? null,
      });
    } else if (command === 'session') {
      const row = getSession(process.env.SESSION_ID ?? '');
      emit({ ok: row !== null, generation: row?.generation ?? null });
    } else if (command === 'finish-login') {
      const opened = await completeAutologin(config, {
        signature: process.env.TOKEN3 ?? '',
        userEmail: process.env.USER_EMAIL ?? '',
        userName: process.env.USER_NAME ?? '',
        userId: process.env.USER_ID ?? '',
        emailConfirmed: process.env.EMAIL_CONFIRMED ?? 'false',
        browserBinding: process.env.BROWSER_BINDING ?? '',
      });
      emit({ ok: opened.ok, sessionId: opened.ok ? opened.sessionId : null });
    } else if (command === 'migrations') {
      const rows = getDb().prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      emit({ ok: true, versions: rows });
    } else {
      emit({ ok: false, error: 'unknown-command' });
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    emit({ ok: false, error: err instanceof Error ? err.name : 'error' });
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

export function spawnWorker(
  commandName: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const worker = fileURLToPath(import.meta.url);
  const repoRoot = resolve(worker, '../../..');
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, commandName], {
      cwd: repoRoot,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

if (isDirectRun()) {
  await main();
}
