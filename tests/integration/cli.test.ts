import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { initDb, applyMigrations, closeDb } from '../../src/storage/database.js';
import { createCandidate, activateCandidate } from '../../src/storage/installations.js';
import { installPassword } from '../../src/insales/protocol.js';
import { InSalesSimulator } from '../support/insales-simulator.js';
import { TEST_KEY_HEX } from '../support/config.js';

const ENV_KEYS = [
  'APP_ENV',
  'INSALES_APP_ID',
  'INSALES_APP_SECRET',
  'APP_BASE_URL',
  'APP_ENCRYPTION_KEY',
  'ALLOWED_SHOPS',
  'APP_RUNTIME_DIR',
  'APP_DB',
  'LOCAL_DEMO',
  'LOG_LEVEL',
  'TRUST_PROXY',
];

describe('CLI exit codes', () => {
  const previous = new Map<string, string | undefined>();
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    for (const key of ENV_KEYS) {
      if (!previous.has(key)) continue;
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    closeDb();
  });

  function rememberEnv(): void {
    for (const key of ENV_KEYS) {
      if (!previous.has(key)) previous.set(key, process.env[key]);
    }
  }

  function captureLog(): string[] {
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    return lines;
  }

  it('returns non-zero when doctor or cleanup cannot read configuration', async () => {
    rememberEnv();
    process.env.APP_ENCRYPTION_KEY = 'bad';
    expect(await runCli(['doctor'])).toBe(1);
    expect(await runCli(['cleanup'])).toBe(1);
    expect(await runCli(['unknown'])).toBe(1);
  });

  it('prints a key and checks account.json without printing the password', async () => {
    rememberEnv();
    const lines = captureLog();
    expect(await runCli(['keygen'])).toBe(0);
    expect(lines.join('\n')).toMatch(/[0-9a-f]{64}/);

    const sim = new InSalesSimulator();
    sim.setAppId('demo-app');
    await sim.start();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'insales-cli-'));
      const shop = `127.0.0.1:${sim.port}`;
      const password = installPassword('install-token', 'demo-secret');
      sim.setPassword(password);
      sim.setAccount(42, 'Hidden title');
      Object.assign(process.env, {
        APP_ENV: 'test',
        INSALES_APP_ID: 'demo-app',
        INSALES_APP_SECRET: 'demo-secret',
        APP_BASE_URL: 'http://127.0.0.1:8765',
        APP_ENCRYPTION_KEY: TEST_KEY_HEX,
        ALLOWED_SHOPS: shop,
        APP_RUNTIME_DIR: dir,
        APP_DB: join(dir, 'app.sqlite3'),
        LOCAL_DEMO: 'true',
        LOG_LEVEL: 'silent',
      });
      const config = loadConfig({ env: process.env, readEnvFile: false, baseDir: dir });
      initDb(config);
      applyMigrations(config);
      const created = createCandidate(config, '42', shop, password);
      expect(created.status).toBe('created');
      if (created.status !== 'created') return;
      activateCandidate(config, created.id);
      closeDb();

      const okLines = captureLog();
      expect(await runCli(['doctor', '--api'])).toBe(0);
      const okOutput = okLines.join('\n');
      expect(okOutput).toContain(`${shop}: OK, account.id совпадает`);
      expect(okOutput).not.toContain(password);
      expect(okOutput).not.toContain('Hidden title');

      sim.setPassword('revoked');
      const badLines = captureLog();
      expect(await runCli(['doctor', '--api'])).toBe(1);
      const badOutput = badLines.join('\n');
      expect(badOutput).toContain(`${shop}: HTTP 401`);
      expect(badOutput).not.toContain(password);

      const cleanupLines = captureLog();
      expect(await runCli(['cleanup'])).toBe(0);
      expect(cleanupLines.join('\n')).toContain('Очистка завершена');
    } finally {
      await sim.stop();
    }
  });
});
