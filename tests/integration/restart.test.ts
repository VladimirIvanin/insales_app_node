import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, applyMigrations, closeDb, getDb } from '../../src/storage/database.js';
import { handleInstall } from '../../src/application/installation.js';
import { createSession, createChallenge } from '../../src/storage/sessions.js';
import { getStore, uninstallStore } from '../../src/storage/installations.js';
import { installPassword, computeToken3 } from '../../src/insales/protocol.js';
import { InSalesSimulator } from '../support/insales-simulator.js';
import { syntheticConfig, TEST_KEY_HEX } from '../support/config.js';
import { spawnWorker } from '../support/restart-worker.js';
import type { AppConfig } from '../../src/config.js';

function workerEnv(config: AppConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    APP_ENV: 'test',
    INSALES_APP_ID: config.insalesAppId,
    INSALES_APP_SECRET: config.insalesAppSecret,
    APP_BASE_URL: config.appBaseUrl,
    APP_ENCRYPTION_KEY: TEST_KEY_HEX,
    ALLOWED_SHOPS: config.allowedShops.join(','),
    APP_RUNTIME_DIR: config.appRuntimeDir,
    APP_DB: config.appDb,
    LOCAL_DEMO: 'true',
    LOG_LEVEL: 'silent',
    ...extra,
  };
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .trim()
    .split('\n')
    .filter((item) => item.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`worker produced no JSON: ${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe('restart with the same database and key', () => {
  const sim = new InSalesSimulator();

  afterEach(async () => {
    closeDb();
    if (sim.port !== 0) {
      await sim.stop().catch(() => undefined);
    }
  });

  it('verifies a saved candidate and keeps the session in a new process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-restart-'));
    await sim.start();
    sim.setAppId('demo-app');
    const shop = `127.0.0.1:${sim.port}`;
    const config = syntheticConfig({
      appRuntimeDir: dir,
      appDb: join(dir, 'app.sqlite3'),
      allowedShops: [shop],
      localDemo: true,
    });
    const password = installPassword('install-token', config.insalesAppSecret);
    sim.setPassword(password);
    sim.setAccount(21, 'Restarted');
    initDb(config);
    applyMigrations(config);
    handleInstall(config, shop, '21', 'install-token');
    closeDb();

    const verified = await spawnWorker('verify', workerEnv(config, { STORE_ID: '21', SHOP: shop }));
    expect(verified.code).toBe(0);
    const verifyBody = lastJson(verified.stdout);
    expect(verifyBody.diagnostic).toBe('activated');
    expect(verifyBody.title).toBe('Restarted');
    expect(verified.stdout).not.toContain(password);
    expect(verified.stderr).not.toContain(password);

    initDb(config);
    const store = getStore('21');
    expect(store?.title).toBe('Restarted');
    const binding = 'browser-1';
    const { nonce } = createChallenge('21', store!.generation, binding);
    const token3 = computeToken3(nonce, 'user@example.invalid', 'User', '4', 'false', password);
    closeDb();

    const loggedIn = await spawnWorker(
      'finish-login',
      workerEnv(config, {
        TOKEN3: token3,
        USER_EMAIL: 'user@example.invalid',
        USER_NAME: 'User',
        USER_ID: '4',
        EMAIL_CONFIRMED: 'false',
        BROWSER_BINDING: binding,
      }),
    );
    expect(loggedIn.code).toBe(0);
    const loginBody = lastJson(loggedIn.stdout);
    expect(loginBody.ok).toBe(true);
    const sessionId = String(loginBody.sessionId);
    closeDb();

    const stillThere = await spawnWorker('session', workerEnv(config, { SESSION_ID: sessionId }));
    expect(lastJson(stillThere.stdout)).toMatchObject({ ok: true });

    initDb(config);
    const expiredBinding = 'browser-expired';
    getDb()
      .prepare(
        `
      INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
      VALUES ('expired-challenge', '21', 'old-nonce', ?, ?, datetime('now', '-1 minute'))
    `,
      )
      .run(store!.generation, expiredBinding);
    closeDb();
    const expired = await spawnWorker(
      'finish-login',
      workerEnv(config, {
        TOKEN3: 'a'.repeat(32),
        USER_EMAIL: 'user@example.invalid',
        USER_NAME: 'User',
        USER_ID: '4',
        EMAIL_CONFIRMED: 'false',
        BROWSER_BINDING: expiredBinding,
      }),
    );
    expect(lastJson(expired.stdout)).toMatchObject({ ok: false });

    initDb(config);
    uninstallStore(config, '21', shop, password);
    const oldSession = sessionId;
    closeDb();
    const gone = await spawnWorker('session', workerEnv(config, { SESSION_ID: oldSession }));
    expect(lastJson(gone.stdout)).toMatchObject({ ok: false });

    initDb(config);
    handleInstall(config, shop, '21', 'second-token');
    const previousGeneration = store!.generation;
    closeDb();
    sim.setPassword(installPassword('second-token', config.insalesAppSecret));
    const again = await spawnWorker('verify', workerEnv(config, { STORE_ID: '21', SHOP: shop }));
    const againBody = lastJson(again.stdout);
    expect(againBody.diagnostic).toBe('activated');
    expect(Number(againBody.generation)).toBeGreaterThan(previousGeneration);

    const broken = await spawnWorker(
      'verify',
      workerEnv(config, {
        STORE_ID: '21',
        SHOP: shop,
        APP_ENCRYPTION_KEY: 'ff'.repeat(32),
      }),
    );
    expect(broken.code).not.toBe(0);
    const brokenBody = lastJson(broken.stdout);
    expect(brokenBody.ok).toBe(false);
    expect(broken.stdout).not.toContain(password);
    expect(broken.stderr).not.toContain(password);
    expect(JSON.stringify(brokenBody)).not.toContain('ciphertext');
  });

  it('rejects an expired challenge that was stored before the new process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-restart-expire-'));
    const config = syntheticConfig({
      appRuntimeDir: dir,
      appDb: join(dir, 'app.sqlite3'),
      allowedShops: ['shop.example'],
    });
    initDb(config);
    applyMigrations(config);
    getDb()
      .prepare(
        `
      INSERT INTO stores (id, shop, password, title, generation)
      VALUES ('3', 'shop.example', 'ciphertext', '', 1)
    `,
      )
      .run();
    createSession('3', '1', 1);
    getDb()
      .prepare(
        `
      INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
      VALUES ('late', '3', 'nonce', 1, 'binding', datetime('now', '-2 minutes'))
    `,
      )
      .run();
    const sessionId = getDb().prepare(`SELECT id FROM sessions LIMIT 1`).get() as { id: string };
    closeDb();
    const session = await spawnWorker('session', workerEnv(config, { SESSION_ID: sessionId.id }));
    expect(lastJson(session.stdout).ok).toBe(true);
    const login = await spawnWorker(
      'finish-login',
      workerEnv(config, {
        TOKEN3: 'ab'.repeat(16),
        USER_ID: '1',
        BROWSER_BINDING: 'binding',
      }),
    );
    expect(lastJson(login.stdout).ok).toBe(false);
  });
});
