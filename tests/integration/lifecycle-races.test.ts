import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { initDb, closeDb, applyMigrations, getDb } from '../../src/storage/database.js';
import {
  activateCandidate,
  candidateHooks,
  createCandidate,
  decryptStorePassword,
  findCandidate,
  getStore,
  updateStoreTitle,
} from '../../src/storage/installations.js';
import { createChallenge, createSession, getSession } from '../../src/storage/sessions.js';
import { verifyCandidate, handleUninstall } from '../../src/application/installation.js';
import { authorize, clientForContext, completeAutologin } from '../../src/http/auth.js';
import { lifecycleHooks, resetLifecycleHooks } from '../../src/application/hooks.js';
import { computeToken3 } from '../../src/insales/protocol.js';
import { InSalesSimulator } from '../support/insales-simulator.js';
import { syntheticConfig } from '../support/config.js';
import type { AppConfig } from '../../src/config.js';
import type { FastifyRequest } from 'fastify';

describe('installation order and session generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'insales-race-'));
  const dbPath = join(dir, 'app.sqlite3');
  const config: AppConfig = syntheticConfig({
    appRuntimeDir: dir,
    appDb: dbPath,
    allowedShops: ['shop.example', '127.0.0.1'],
  });
  const sim = new InSalesSimulator();

  afterEach(async () => {
    resetLifecycleHooks();
    candidateHooks.afterReserve = null;
    config.allowedShops = ['shop.example'];
    closeDb();
    if (sim.port !== 0) await sim.stop();
  });

  function openDb(): void {
    initDb(config);
    applyMigrations(config);
    getDb().exec(
      'DELETE FROM sessions; DELETE FROM login_challenges; DELETE FROM install_candidates; DELETE FROM stores;',
    );
  }

  function requestWithCookie(cookie: string): FastifyRequest {
    return { cookies: { demo_session: cookie } } as unknown as FastifyRequest;
  }

  it('reserves a different ordinal for each candidate under the write lock', () => {
    openDb();
    const ordinals: number[] = [];
    candidateHooks.afterReserve = () => {
      const other = new Database(dbPath);
      other.pragma('busy_timeout = 0');
      expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      other.close();
    };
    const first = createCandidate(config, '1', 'shop.example', 'password-a');
    const second = createCandidate(config, '1', 'shop.example', 'password-b');
    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    if (first.status === 'created') ordinals.push(first.ordinal);
    if (second.status === 'created') ordinals.push(second.ordinal);
    expect(new Set(ordinals).size).toBe(2);
    expect(ordinals[1]).toBeGreaterThan(ordinals[0]);

    activateCandidate(config, first.status === 'created' ? first.id : '');
    uninstallStoreSafe();
    const afterDelete = createCandidate(config, '1', 'shop.example', 'password-c');
    expect(afterDelete.status).toBe('created');
    if (afterDelete.status === 'created') expect(afterDelete.ordinal).toBeGreaterThan(ordinals[1]);
  });

  function uninstallStoreSafe(): void {
    const store = getStore('1');
    if (!store) return;
    const password = decryptStorePassword(config, store);
    handleUninstall(config, 'shop.example', '1', password);
  }

  it('keeps the newer confirmed connection when an older account response continues', async () => {
    openDb();
    await sim.start();
    sim.setAppId(config.insalesAppId);
    const shop = `127.0.0.1:${sim.port}`;
    config.allowedShops = [shop];
    const passwordA = 'password-a';
    const passwordB = 'password-b';
    sim.setPassword(passwordA);
    sim.setAccount(7, 'title-a');
    const candidateA = createCandidate(config, '7', shop, passwordA);
    expect(candidateA.status).toBe('created');
    if (candidateA.status !== 'created') return;

    lifecycleHooks.afterAccountRead = () => {
      sim.setPassword(passwordB);
      sim.setAccount(7, 'title-b');
      const candidateB = createCandidate(config, '7', shop, passwordB);
      expect(candidateB.status).toBe('created');
      if (candidateB.status !== 'created') return;
      const generation = activateCandidate(config, candidateB.id);
      expect(generation).not.toBeNull();
      updateStoreTitle('7', 'title-b', generation!);
    };

    const result = await verifyCandidate(config, '7', shop, {
      appId: config.insalesAppId,
      allowHttp: true,
      timeout: 5_000,
    });
    expect(result.diagnostic).toBe('stale_candidate');
    const store = getStore('7');
    expect(store?.title).toBe('title-b');
    expect(decryptStorePassword(config, store!)).toBe(passwordB);
    expect(findCandidate('7', shop)?.id).toBe(candidateA.id);

    const repeated = createCandidate(config, '7', shop, passwordA);
    expect(repeated).toEqual({ status: 'duplicate', id: candidateA.id });
    expect(decryptStorePassword(config, getStore('7')!)).toBe(passwordB);
  });

  it('does not activate a candidate that was uninstalled after account.json', async () => {
    openDb();
    await sim.start();
    sim.setAppId(config.insalesAppId);
    const shop = `127.0.0.1:${sim.port}`;
    config.allowedShops = [shop];
    const password = 'password-a';
    sim.setPassword(password);
    sim.setAccount(8, 'gone');
    const created = createCandidate(config, '8', shop, password);
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    lifecycleHooks.afterAccountRead = () => {
      handleUninstall(config, shop, '8', password);
    };
    const result = await verifyCandidate(config, '8', shop, {
      appId: config.insalesAppId,
      allowHttp: true,
      timeout: 5_000,
    });
    expect(result.generation).toBeNull();
    expect(getStore('8')).toBeNull();
  });

  it('leaves the active sessions in place when a newer candidate is not confirmed', async () => {
    openDb();
    await sim.start();
    sim.setAppId(config.insalesAppId);
    const shop = `127.0.0.1:${sim.port}`;
    config.allowedShops = [shop];
    sim.setPassword('password-b');
    sim.setAccount(9, 'shop-b');
    const active = createCandidate(config, '9', shop, 'password-b');
    expect(active.status).toBe('created');
    if (active.status !== 'created') return;
    const generation = activateCandidate(config, active.id)!;
    updateStoreTitle('9', 'shop-b', generation);
    const sessionId = createSession('9', '4', generation);

    const pending = createCandidate(config, '9', shop, 'password-c');
    expect(pending.status).toBe('created');
    expect(getSession(sessionId)).not.toBeNull();
    expect(decryptStorePassword(config, getStore('9')!)).toBe('password-b');

    lifecycleHooks.afterAccountRead = () => {
      createCandidate(config, '9', shop, 'password-d');
    };
    sim.setPassword('password-e');
    const allowed = createCandidate(config, '9', shop, 'password-e');
    expect(allowed.status).toBe('created');
    if (allowed.status !== 'created') return;
    const verified = await verifyCandidate(config, '9', shop, {
      appId: config.insalesAppId,
      allowHttp: true,
      timeout: 5_000,
    });
    expect(verified.diagnostic).toBe('activated');
    expect(getStore('9')?.generation).toBe(allowed.ordinal);
    expect(findCandidate('9', shop)?.id).not.toBe(allowed.id);
  });

  it('does not apply an older title after a newer generation is stored', async () => {
    openDb();
    await sim.start();
    sim.setAppId(config.insalesAppId);
    const shop = `127.0.0.1:${sim.port}`;
    config.allowedShops = [shop];
    sim.setPassword('password-a');
    sim.setAccount(10, 'title-a');
    const first = createCandidate(config, '10', shop, 'password-a');
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;
    lifecycleHooks.afterActivate = () => {
      const second = createCandidate(config, '10', shop, 'password-b');
      expect(second.status).toBe('created');
      if (second.status !== 'created') return;
      const generation = activateCandidate(config, second.id)!;
      updateStoreTitle('10', 'title-b', generation);
    };
    const result = await verifyCandidate(config, '10', shop, {
      appId: config.insalesAppId,
      allowHttp: true,
      timeout: 5_000,
    });
    expect(result.diagnostic).toBe('activated');
    expect(getStore('10')?.title).toBe('title-b');
    expect(decryptStorePassword(config, getStore('10')!)).toBe('password-b');
  });

  it('keeps the credential captured with the session', async () => {
    openDb();
    await sim.start();
    sim.setAppId(config.insalesAppId);
    const shop = `127.0.0.1:${sim.port}`;
    config.allowedShops = [shop];
    sim.setPassword('password-old');
    sim.setAccount(11, 'Old');
    const created = createCandidate(config, '11', shop, 'password-old');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const generation = activateCandidate(config, created.id)!;
    const sessionId = createSession('11', '3', generation);
    const auth = authorize(config, requestWithCookie(sessionId));
    expect(auth?.password).toBe('password-old');
    expect(JSON.stringify(auth)).not.toContain('password-old');
    expect(inspect(auth)).not.toContain('password-old');

    const replacement = createCandidate(config, '11', shop, 'password-new');
    expect(replacement.status).toBe('created');
    if (replacement.status !== 'created') return;
    activateCandidate(config, replacement.id);
    sim.clearRecorded();
    sim.setPassword('password-old');
    const client = clientForContext(config, auth!);
    const account = await client.account.get();
    expect(account.account.id).toBe('11');
    const expected = `Basic ${Buffer.from(`${config.insalesAppId}:password-old`).toString('base64')}`;
    expect(sim.recorded()[0]?.authorization).toBe(expected);
    expect(decryptStorePassword(config, getStore('11')!)).toBe('password-new');
  });

  it('creates one session when two callbacks pass the same token3', async () => {
    openDb();
    const created = createCandidate(config, '12', 'shop.example', 'password-a');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const generation = activateCandidate(config, created.id)!;
    const binding = 'browser-binding';
    const { nonce } = createChallenge('12', generation, binding);
    const token3 = computeToken3(nonce, 'a@example.invalid', 'Name', '9', 'false', 'password-a');
    let arrived = 0;
    let release: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    lifecycleHooks.afterSignatureVerified = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await opened;
    };
    const input = {
      signature: token3,
      userEmail: 'a@example.invalid',
      userName: 'Name',
      userId: '9',
      emailConfirmed: 'false',
      browserBinding: binding,
    };
    const [left, right] = await Promise.all([
      completeAutologin(config, input),
      completeAutologin(config, input),
    ]);
    const wins = [left, right].filter((item) => item.ok);
    expect(wins).toHaveLength(1);
    const count = getDb().prepare('SELECT COUNT(*) AS cnt FROM sessions').get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('does not create a session after the connection is replaced', async () => {
    openDb();
    const created = createCandidate(config, '13', 'shop.example', 'password-a');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const generation = activateCandidate(config, created.id)!;
    const binding = 'bound-browser';
    const { nonce } = createChallenge('13', generation, binding);
    const token3 = computeToken3(nonce, 'a@example.invalid', 'Name', '9', 'false', 'password-a');
    lifecycleHooks.afterSignatureVerified = () => {
      const next = createCandidate(config, '13', 'shop.example', 'password-b');
      expect(next.status).toBe('created');
      if (next.status === 'created') activateCandidate(config, next.id);
    };
    const opened = await completeAutologin(config, {
      signature: token3,
      userEmail: 'a@example.invalid',
      userName: 'Name',
      userId: '9',
      emailConfirmed: 'false',
      browserBinding: binding,
    });
    expect(opened.ok).toBe(false);
    const count = getDb().prepare('SELECT COUNT(*) AS cnt FROM sessions').get() as { cnt: number };
    expect(count.cnt).toBe(0);
    expect(authorize(config, requestWithCookie('missing'))).toBeNull();
  });

  it('cancels only the credential presented to uninstall', () => {
    openDb();
    const active = createCandidate(config, '14', 'shop.example', 'active-password');
    const pending = createCandidate(config, '14', 'shop.example', 'pending-password');
    expect(active.status).toBe('created');
    expect(pending.status).toBe('created');
    if (active.status !== 'created' || pending.status !== 'created') return;
    const generation = activateCandidate(config, active.id)!;
    const sessionId = createSession('14', '1', generation);
    expect(handleUninstall(config, 'shop.example', '14', 'pending-password')).toBe(true);
    expect(getStore('14')?.generation).toBe(generation);
    expect(getSession(sessionId)).not.toBeNull();
    expect(findCandidate('14', 'shop.example')).toBeNull();
  });
});
