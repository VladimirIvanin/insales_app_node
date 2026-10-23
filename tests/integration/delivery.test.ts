import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/app.js';
import { closeDb } from '../../src/storage/database.js';
import { runCli } from '../../src/cli.js';
import { syntheticConfig } from '../support/config.js';
import { TEST_KEY_HEX } from '../support/config.js';

describe('process listeners and compiled CLI commands', () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    closeDb();
  });

  function remember(key: string): void {
    if (!previous.has(key)) previous.set(key, process.env[key]);
  }

  it('does not register signal handlers when the factory is called twice', async () => {
    const beforeTerm = process.listenerCount('SIGTERM');
    const beforeInt = process.listenerCount('SIGINT');
    const dir = mkdtempSync(join(tmpdir(), 'insales-factory-'));
    const config = syntheticConfig({ appRuntimeDir: dir, appDb: join(dir, 'app.sqlite3') });
    const first = await buildApp(config);
    const second = await buildApp(config);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    await first.fastify.close();
    await second.fastify.close();
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  });

  it('migrates from the CLI without the shop secret in the output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-cli-db-'));
    for (const key of [
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
    ]) {
      remember(key);
    }
    Object.assign(process.env, {
      APP_ENV: 'test',
      INSALES_APP_ID: 'demo-app',
      INSALES_APP_SECRET: 'demo-secret-value',
      APP_BASE_URL: 'http://127.0.0.1:8765',
      APP_ENCRYPTION_KEY: TEST_KEY_HEX,
      ALLOWED_SHOPS: 'shop.example',
      APP_RUNTIME_DIR: dir,
      APP_DB: join(dir, 'app.sqlite3'),
      LOCAL_DEMO: 'true',
      LOG_LEVEL: 'silent',
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      expect(await runCli(['keygen'])).toBe(0);
      expect(await runCli(['db:migrate'])).toBe(0);
      expect(await runCli(['db:status'])).toBe(0);
    } finally {
      console.log = original;
    }
    const output = lines.join('\n');
    expect(output).toContain('Версия 1');
    expect(output).toContain('Версия 2');
    expect(output).not.toContain('demo-secret-value');
    expect(output).not.toContain(TEST_KEY_HEX);
  });
});
