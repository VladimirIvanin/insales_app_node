import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { InSalesSimulator } from '../support/insales-simulator.js';
import { closeDb, getDb } from '../../src/storage/database.js';
import { initDb, applyMigrations } from '../../src/storage/database.js';
import { getStore, findCandidate, decryptStorePassword } from '../../src/storage/installations.js';
import { installPassword, computeToken3 } from '../../src/insales/protocol.js';
import { createChallenge, createSession, getSession } from '../../src/storage/sessions.js';
import { randomId } from '../../src/storage/credentials.js';
import { syntheticConfig } from '../support/config.js';
import type { AppConfig } from '../../src/config.js';
import type { FastifyInstance } from 'fastify';

describe('HTTP lifecycle via buildApp', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'insales-http-'));
  const dbPath = join(tmpDir, 'test.sqlite3');
  const appId = 'demo-app';
  const appSecret = 'demo-secret';
  const sim = new InSalesSimulator();
  const simB = new InSalesSimulator();
  let fastify: FastifyInstance;
  let config: AppConfig;
  let shop = '';
  let shopB = '';

  beforeAll(async () => {
    sim.setAppId(appId);
    simB.setAppId(appId);
    await sim.start();
    await simB.start();
    shop = `127.0.0.1:${sim.port}`;
    shopB = `127.0.0.1:${simB.port}`;
    const instance = await buildApp(syntheticConfig({
      insalesAppId: appId,
      insalesAppSecret: appSecret,
      allowedShops: [shop, shopB],
      appRuntimeDir: tmpDir,
      appDb: dbPath,
      appBaseUrl: 'http://127.0.0.1:8765',
      localDemo: true,
      logLevel: 'silent',
    }));
    fastify = instance.fastify;
    config = instance.config;
  });

  afterAll(async () => {
    await fastify.close();
    closeDb();
    await sim.stop();
    await simB.stop();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM sessions; DELETE FROM login_challenges; DELETE FROM install_candidates; DELETE FROM stores;');
  });

  function candidateCount(storeId: string, domain: string): number {
    return (getDb().prepare(
      'SELECT COUNT(*) AS cnt FROM install_candidates WHERE store_id = ? AND shop = ?',
    ).get(storeId, domain) as { cnt: number }).cnt;
  }

  async function install(storeId: string, token: string, domain = shop): Promise<void> {
    const response = await fastify.inject({
      method: 'GET',
      url: `/install?shop=${encodeURIComponent(domain)}&insales_id=${storeId}&token=${encodeURIComponent(token)}`,
    });
    expect(response.statusCode).toBe(200);
  }

  async function openLogin(storeId: string, domain = shop) {
    return fastify.inject({
      method: 'GET',
      url: `/login?shop=${encodeURIComponent(domain)}&insales_id=${storeId}`,
    });
  }

  async function installAndActivate(storeId: string, token: string, domain = shop, target = sim): Promise<void> {
    target.setPassword(installPassword(token, appSecret));
    target.setAccount(Number(storeId));
    await install(storeId, token, domain);
    const response = await openLogin(storeId, domain);
    expect(response.statusCode).toBe(302);
  }

  it('rejects /install with missing params', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/install?shop=shop.example' });
    expect(response.statusCode).toBe(400);
  });

  it('activates a candidate that this test installed', async () => {
    const storeId = '1001';
    await installAndActivate(storeId, 'activate-token');
    const store = getStore(storeId);
    expect(store?.shop).toBe(shop);
    expect(findCandidate(storeId, shop)).toBeNull();
  });

  it('keeps a candidate and returns 503 when account JSON is invalid, then accepts a retry', async () => {
    const storeId = '1002';
    const token = 'json-token';
    sim.setPassword(installPassword(token, appSecret));
    sim.setAccount(Number(storeId));
    await install(storeId, token);
    sim.respondNext('GET', '/admin/account.json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });

    const failed = await openLogin(storeId);
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(findCandidate(storeId, shop)).not.toBeNull();

    const retried = await openLogin(storeId);
    expect(retried.statusCode).toBe(302);
    expect(getStore(storeId)?.shop).toBe(shop);
  });

  it('keeps a candidate when the API is temporarily unavailable', async () => {
    const storeId = '1003';
    const token = 'unavailable-token';
    sim.setPassword(installPassword(token, appSecret));
    sim.setAccount(Number(storeId));
    await install(storeId, token);
    sim.respondNext('GET', '/admin/account.json', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
      body: 'unavailable',
    });
    const failed = await openLogin(storeId);
    expect(failed.statusCode).toBe(503);
    expect(findCandidate(storeId, shop)).not.toBeNull();
    const retried = await openLogin(storeId);
    expect(retried.statusCode).toBe(302);
  });

  it('drops only the rejected credential and then activates the earlier one', async () => {
    const storeId = '1004';
    sim.setPassword(installPassword('real-token', appSecret));
    sim.setAccount(Number(storeId));
    await install(storeId, 'real-token');
    await install(storeId, 'forged-token');
    expect(candidateCount(storeId, shop)).toBe(2);

    const rejected = await openLogin(storeId);
    expect(rejected.statusCode).toBe(400);
    expect(getStore(storeId)).toBeNull();
    expect(candidateCount(storeId, shop)).toBe(1);

    const accepted = await openLogin(storeId);
    expect(accepted.statusCode).toBe(302);
    expect(getStore(storeId)).not.toBeNull();
  });

  it('does not revoke an active session when the same install is repeated or a forged one fails', async () => {
    const storeId = '1005';
    const token = 'stable-token';
    await installAndActivate(storeId, token);
    const store = getStore(storeId)!;
    const sessionId = createSession(store.id, '7', store.generation);

    await install(storeId, token);
    const repeated = await openLogin(storeId);
    expect(repeated.statusCode).toBe(302);
    expect(getStore(storeId)?.generation).toBe(store.generation);
    expect(getSession(sessionId)).not.toBeNull();

    await install(storeId, 'forged-token');
    const forged = await openLogin(storeId);
    expect(forged.statusCode).toBe(302);
    expect(getStore(storeId)?.generation).toBe(store.generation);
    expect(getSession(sessionId)).not.toBeNull();
    expect(candidateCount(storeId, shop)).toBe(0);
  });

  it('rejects a bad token3 for a live challenge and then accepts the real signature', async () => {
    const storeId = '1006';
    await installAndActivate(storeId, 'signature-token');
    const store = getStore(storeId)!;
    const before = (getDb().prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE store_id = ?').get(storeId) as { cnt: number }).cnt;
    const browserBinding = randomId(16);
    const { challengeId, nonce } = createChallenge(store.id, store.generation, browserBinding);
    const password = decryptStorePassword(config, store);
    const user = { email: 'user@example.invalid', name: 'Тест', id: '7', confirmed: 'false' };
    const bad = await fastify.inject({
      method: 'GET',
      url: `/autologin?token3=${'0'.repeat(32)}&user_email=${encodeURIComponent(user.email)}&user_name=${encodeURIComponent(user.name)}&user_id=${user.id}&email_confirmed=${user.confirmed}`,
      headers: { cookie: `demo_session=${browserBinding}` },
    });
    expect(bad.statusCode).toBe(401);
    expect((getDb().prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE store_id = ?').get(storeId) as { cnt: number }).cnt).toBe(before);
    expect(getDb().prepare('SELECT id FROM login_challenges WHERE id = ?').get(challengeId)).toBeTruthy();

    const token3 = computeToken3(nonce, user.email, user.name, user.id, user.confirmed, password);
    const good = await fastify.inject({
      method: 'GET',
      url: `/autologin?token3=${token3}&user_email=${encodeURIComponent(user.email)}&user_name=${encodeURIComponent(user.name)}&user_id=${user.id}&email_confirmed=${user.confirmed}`,
      headers: { cookie: `demo_session=${browserBinding}` },
    });
    expect(good.statusCode).toBe(302);
    expect(good.headers['cache-control']).toBe('no-store');
    expect((getDb().prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE store_id = ?').get(storeId) as { cnt: number }).cnt).toBe(before + 1);
  });

  it('serves the dashboard for a session created by this test', async () => {
    const storeId = '1007';
    await installAndActivate(storeId, 'dashboard-token');
    const store = getStore(storeId)!;
    const sessionId = createSession(store.id, '7', store.generation);
    const response = await fastify.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: `demo_session=${sessionId}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('Приложение InSales');
    expect(response.body).toContain('127.0.0.1');

    const anonymous = await fastify.inject({ method: 'GET', url: '/' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it('removes the local session only when uninstall presents the ready password', async () => {
    const storeId = '1008';
    const token = 'uninstall-token';
    await installAndActivate(storeId, token);
    const store = getStore(storeId)!;
    const sessionId = createSession(store.id, '7', store.generation);
    const password = installPassword(token, appSecret);

    const raw = await fastify.inject({
      method: 'GET',
      url: `/uninstall?shop=${encodeURIComponent(shop)}&insales_id=${storeId}&token=${encodeURIComponent(token)}`,
    });
    expect(raw.statusCode).toBe(200);
    expect(getStore(storeId)).not.toBeNull();
    expect(getSession(sessionId)).not.toBeNull();

    const pendingToken = 'later-token';
    await install(storeId, pendingToken);
    const pendingOnly = await fastify.inject({
      method: 'GET',
      url: `/uninstall?shop=${encodeURIComponent(shop)}&insales_id=${storeId}&token=${encodeURIComponent(installPassword(pendingToken, appSecret))}`,
    });
    expect(pendingOnly.statusCode).toBe(200);
    expect(getStore(storeId)?.generation).toBe(store.generation);
    expect(getSession(sessionId)).not.toBeNull();
    expect(candidateCount(storeId, shop)).toBe(0);

    const removed = await fastify.inject({
      method: 'GET',
      url: `/uninstall?shop=${encodeURIComponent(shop)}&insales_id=${storeId}&token=${encodeURIComponent(password)}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.headers['cache-control']).toBe('no-store');
    expect(getStore(storeId)).toBeNull();
    expect(getSession(sessionId)).toBeNull();
  });

  it('does not change another shop when one shop is uninstalled', async () => {
    const storeA = '1009';
    const storeB = '1010';
    await installAndActivate(storeA, 'tenant-a');
    simB.setPassword(installPassword('tenant-b', appSecret));
    simB.setAccount(Number(storeB));
    await install(storeB, 'tenant-b', shopB);
    const loginB = await openLogin(storeB, shopB);
    expect(loginB.statusCode).toBe(302);
    const sessionB = createSession(storeB, '9', getStore(storeB)!.generation);

    const removed = await fastify.inject({
      method: 'GET',
      url: `/uninstall?shop=${encodeURIComponent(shop)}&insales_id=${storeA}&token=${encodeURIComponent(installPassword('tenant-a', appSecret))}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(getStore(storeA)).toBeNull();
    expect(getStore(storeB)?.shop).toBe(shopB);
    expect(getSession(sessionB)?.store_id).toBe(storeB);
  });

  it('does not attach a second account id to a shop that already has a store', async () => {
    await installAndActivate('1201', 'owner-token');
    sim.setAccount(1202);
    sim.setPassword(installPassword('other-token', appSecret));
    await install('1202', 'other-token');
    const response = await openLogin('1202');
    expect(response.statusCode).toBe(400);
    expect(getStore('1201')).not.toBeNull();
    expect(getStore('1202')).toBeNull();
    expect(findCandidate('1202', shop)).toBeNull();
  });

  it('answers health and readiness', async () => {
    const health = await fastify.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const ready = await fastify.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });
});

describe('Challenge expiration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'insales-expire-'));
  const dbPath = join(tmpDir, 'test.sqlite3');

  beforeAll(() => {
    try { unlinkSync(dbPath); } catch { /* absent */ }
    const config = syntheticConfig({ appRuntimeDir: tmpDir, appDb: dbPath });
    initDb(config);
    applyMigrations(config);
  });

  afterAll(() => {
    closeDb();
  });

  it('should not consume an expired challenge', async () => {
    const { consumeChallenge } = await import('../../src/storage/sessions.js');
    const db = getDb();
    const binding = randomId(16);
    const challengeId = randomId(16);
    db.prepare(`
      INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
      VALUES (?, '42', 'test-nonce', 1, ?, datetime('now', '-1 minute'))
    `).run(challengeId, binding);
    expect(consumeChallenge(challengeId, binding, 1)).toBeNull();
  });

  it('should consume a non-expired challenge', async () => {
    const { consumeChallenge } = await import('../../src/storage/sessions.js');
    const db = getDb();
    const binding = randomId(16);
    const challengeId = randomId(16);
    db.prepare(`
      INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
      VALUES (?, '42', 'another-nonce', 1, ?, datetime('now', '+1 hour'))
    `).run(challengeId, binding);
    const consumed = consumeChallenge(challengeId, binding, 1);
    expect(consumed?.id).toBe(challengeId);
  });

  it('should not consume a session that expired', async () => {
    const { getSession: readSession } = await import('../../src/storage/sessions.js');
    const db = getDb();
    const sessionId = randomId(32);
    db.prepare(`
      INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
      VALUES (?, '42', '7', 1, datetime('now', '-1 minute'))
    `).run(sessionId);
    expect(readSession(sessionId)).toBeNull();
  });

  it('should get a non-expired session', async () => {
    const { getSession: readSession } = await import('../../src/storage/sessions.js');
    const db = getDb();
    const sessionId = randomId(32);
    db.prepare(`
      INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
      VALUES (?, '42', '7', 1, datetime('now', '+1 hour'))
    `).run(sessionId);
    expect(readSession(sessionId)?.id).toBe(sessionId);
  });
});
