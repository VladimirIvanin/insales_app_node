import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildApp, locateAssets } from '../../src/app.js';
import { closeDb } from '../../src/storage/database.js';
import { createCandidate, activateCandidate, getStore } from '../../src/storage/installations.js';
import { createSession, getSession } from '../../src/storage/sessions.js';
import { syntheticConfig } from '../support/config.js';
import type { FastifyInstance } from 'fastify';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const apps: FastifyInstance[] = [];

async function listenApp(options: Parameters<typeof syntheticConfig>[0] = {}, buildOptions: Parameters<typeof buildApp>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'insales-security-'));
  const instance = await buildApp(syntheticConfig({
    appRuntimeDir: dir,
    appDb: join(dir, 'app.sqlite3'),
    ...options,
  }), buildOptions);
  apps.push(instance.fastify);
  return instance;
}

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
  closeDb();
});

function cookiePairs(setCookie: string | string[] | undefined): string {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return list.map((item) => item.split(';')[0]).join('; ');
}

describe('logout CSRF', () => {
  it('rejects a missing or invalid token and accepts the dashboard token', async () => {
    const { fastify, config } = await listenApp();
    const created = createCandidate(config, '42', 'shop.example', 'password');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const generation = activateCandidate(config, created.id)!;
    const sessionId = createSession('42', '7', generation);
    const dashboard = await fastify.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: `demo_session=${sessionId}` },
    });
    expect(dashboard.statusCode).toBe(200);
    const token = dashboard.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    const csrfCookie = cookiePairs(dashboard.headers['set-cookie']);
    expect(csrfCookie).toContain('_csrf=');

    const missing = await fastify.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        cookie: `demo_session=${sessionId}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    });
    expect(missing.statusCode).toBe(403);
    expect(getSession(sessionId)).not.toBeNull();

    const invalid = await fastify.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        cookie: `demo_session=${sessionId}; ${csrfCookie}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '_csrf=not-the-token',
    });
    expect(invalid.statusCode).toBe(403);
    expect(getSession(sessionId)).not.toBeNull();

    const valid = await fastify.inject({
      method: 'POST',
      url: '/logout',
      headers: {
        cookie: `demo_session=${sessionId}; ${csrfCookie}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `_csrf=${encodeURIComponent(token!)}`,
    });
    expect(valid.statusCode).toBe(303);
    expect(valid.headers['cache-control']).toBe('no-store');
    expect(getSession(sessionId)).toBeNull();
    expect(getStore('42')).not.toBeNull();
  });
});

describe('private response headers', () => {
  it('sets no-store on auth pages and callbacks', async () => {
    const { fastify } = await listenApp();
    const paths = ['/', '/probe', '/login', '/autologin', '/install?shop=shop.example&insales_id=42&token=marker', '/uninstall?shop=shop.example&insales_id=42&token=marker'];
    for (const path of paths) {
      const response = await fastify.inject({ method: 'GET', url: path });
      expect(response.headers['cache-control'], path).toBe('no-store');
      expect(response.headers['referrer-policy'], path).toBe('no-referrer');
    }
  });
});

describe('callback logs', () => {
  it('does not write install or autologin secrets', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const { fastify } = await listenApp({ logLevel: 'info' }, { logStream });
    await fastify.inject({
      method: 'GET',
      url: '/install?shop=shop.example&insales_id=42&token=REVIEW_LOG_SENTINEL_install',
    });
    await fastify.inject({
      method: 'GET',
      url: '/autologin?token3=REVIEW_LOG_SENTINEL_token3&user_id=7&user_email=person@example.invalid',
    });
    const output = lines.join('\n');
    expect(output).toContain('/install');
    expect(output).toContain('/autologin');
    expect(output).not.toContain('REVIEW_LOG_SENTINEL');
    expect(output).not.toContain('person@example.invalid');
  });
});

describe('TRUST_PROXY and rate limit', () => {
  async function statuses(trustProxy: false | string[], forwarded: string[]): Promise<number[]> {
    const { fastify } = await listenApp({ trustProxy }, { rateLimitMax: 1 });
    const codes: number[] = [];
    for (const address of forwarded) {
      const response = await fastify.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-forwarded-for': address },
      });
      codes.push(response.statusCode);
    }
    await fastify.close();
    closeDb();
    apps.pop();
    return codes;
  }

  it('counts trusted forwarded clients separately and ignores an untrusted proxy', async () => {
    expect(await statuses(['127.0.0.1'], ['203.0.113.10', '203.0.113.11', '203.0.113.10'])).toEqual([200, 200, 429]);
    expect(await statuses(['10.0.0.1'], ['203.0.113.20', '203.0.113.21'])).toEqual([200, 429]);
  });
});

describe('dist asset layout', () => {
  it('renders the 401 page from dist templates when cwd has a different copy', async () => {
    const artifact = mkdtempSync(join(tmpdir(), 'insales-dist-'));
    const distDir = join(artifact, 'dist');
    const elsewhere = mkdtempSync(join(tmpdir(), 'insales-cwd-'));
    mkdirSync(join(distDir, 'templates'), { recursive: true });
    mkdirSync(join(elsewhere, 'templates'), { recursive: true });
    cpSync(join(projectRoot, 'templates', '401.ejs'), join(distDir, 'templates', '401.ejs'));
    writeFileSync(join(elsewhere, 'templates', '401.ejs'), 'DECOY');
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(locateAssets(distDir).templatesDir).toBe(join(distDir, 'templates'));
      const { fastify } = await listenApp({}, { moduleDir: distDir });
      const response = await fastify.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain('Требуется вход');
      expect(response.body).not.toContain('DECOY');
    } finally {
      process.chdir(previous);
    }
  });
});
