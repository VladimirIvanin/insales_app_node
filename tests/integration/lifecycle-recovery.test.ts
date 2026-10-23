import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { getDb } from '../../src/storage/database.js';
import { findCandidate, getStore } from '../../src/storage/installations.js';
import { computeToken3, installPassword } from '../../src/insales/protocol.js';
import { InSalesSimulator } from '../support/insales-simulator.js';
import { syntheticConfig } from '../support/config.js';

describe('lifecycle recovery through HTTP', () => {
  let app: FastifyInstance;
  let dir: string;
  let sims: InSalesSimulator[];
  let shops: string[];
  let jar: Map<string, string>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'insales-recovery-'));
    sims = [new InSalesSimulator(), new InSalesSimulator()];
    for (const [index, sim] of sims.entries()) {
      sim.setAppId('demo-app');
      sim.setAccount(101 + index);
      sim.setPassword(installPassword('valid' + index, 'demo-secret'));
      await sim.start();
    }
    shops = sims.map((sim) => `127.0.0.1:${sim.port}`);
    app = (
      await buildApp(
        syntheticConfig({
          appDb: join(dir, 'app.sqlite'),
          appRuntimeDir: dir,
          allowedShops: shops,
        }),
      )
    ).fastify;
    jar = new Map();
  });
  afterEach(async () => {
    await app.close();
    for (const sim of sims) await sim.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(path: string, params: Record<string, string> = {}) {
    const response = await app.inject({
      url: path + '?' + new URLSearchParams(params),
      headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const cookie of response.cookies) {
      if (cookie.value) jar.set(cookie.name, cookie.value);
      else jar.delete(cookie.name);
    }
    return response;
  }
  const install = (index: number, id = String(101 + index), token = 'valid' + index) =>
    request('/install', { shop: shops[index], insales_id: id, token });
  const login = (index: number, id = String(101 + index)) =>
    request('/login', { shop: shops[index], insales_id: id });

  it('admits genuine credentials after five forged identities without manual cleanup', async () => {
    for (let i = 0; i < 5; i++)
      expect((await install(0, String(900 + i), 'forged' + i)).statusCode).toBe(200);
    expect((await install(0)).statusCode).toBe(200);
    expect((await login(0)).statusCode).toBe(302);
    expect(getStore('101')?.shop).toBe(shops[0]);
    expect(sims[0].recorded()).toHaveLength(2);
  });
  it('preserves a genuine pending candidate when forged callbacks arrive later', async () => {
    await install(0);
    const actual = findCandidate('101', shops[0])!;
    for (let i = 0; i < 5; i++)
      expect((await install(0, String(900 + i), 'forged' + i)).statusCode).toBe(200);
    expect(findCandidate('101', shops[0])?.id).toBe(actual.id);
    expect((await login(0)).statusCode).toBe(302);
  });
  it('honors Retry-After across login requests and then recovers', async () => {
    await install(0);
    sims[0].respondNext('GET', '/admin/account.json', {
      status: 429,
      headers: { 'retry-after': '60' },
      body: '{}',
    });
    expect((await login(0)).statusCode).toBe(503);
    expect((await login(0)).statusCode).toBe(503);
    expect(sims[0].recorded()).toHaveLength(1);
    expect(findCandidate('101', shops[0])).not.toBeNull();
    getDb().prepare('UPDATE verification_budgets SET next_attempt_at=0').run();
    expect((await login(0)).statusCode).toBe(302);
    expect(sims[0].recorded()).toHaveLength(2);
  });
  it('moves a verified identity and safely retires a previous domain owner', async () => {
    await install(0);
    expect((await login(0)).statusCode).toBe(302);
    sims[1].setAccount(101);
    await install(1, '101');
    expect((await login(1, '101')).statusCode).toBe(302);
    expect(getStore('101')?.shop).toBe(shops[1]);
    sims[1].setAccount(202);
    sims[1].setPassword(installPassword('new-owner', 'demo-secret'));
    await install(1, '202', 'new-owner');
    expect((await login(1, '202')).statusCode).toBe(302);
    expect(getStore('101')).toBeNull();
    expect(getStore('202')?.shop).toBe(shops[1]);
  });
  it('completes overlapping browser flows and refuses a stale tab context', async () => {
    await install(0);
    const a = await login(0);
    await install(1);
    const b = await login(1);
    for (const [index, response] of [a, b].entries()) {
      const target = new URL(response.headers.location as string);
      const callback = new URL(target.searchParams.get('login')!);
      const fields = {
        user_email: 'qa@example.invalid',
        user_name: 'QA',
        user_id: '7',
        email_confirmed: 'true',
      };
      Object.entries(fields).forEach(([key, value]) => callback.searchParams.set(key, value));
      callback.searchParams.set(
        'token3',
        computeToken3(
          target.searchParams.get('token')!,
          fields.user_email,
          fields.user_name,
          fields.user_id,
          fields.email_confirmed,
          installPassword('valid' + index, 'demo-secret'),
        ),
      );
      const completed = await request(callback.pathname, Object.fromEntries(callback.searchParams));
      expect(completed.statusCode).toBe(302);
      expect(completed.headers.location).toContain(`store_id=${101 + index}`);
    }
    const before = sims[1].recorded().length;
    expect((await request('/probe', { store_id: '101' })).statusCode).toBe(409);
    expect(sims[1].recorded()).toHaveLength(before);
  });
  it('keeps health probes outside the shared request limiter', async () => {
    for (let i = 0; i < 101; i++)
      expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/' })).statusCode).toBe(401);
  });
});
