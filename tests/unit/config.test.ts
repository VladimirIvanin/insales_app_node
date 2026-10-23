import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
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
  'TRUST_PROXY',
  'LOG_LEVEL',
];

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'test',
    INSALES_APP_ID: 'explicit-app',
    INSALES_APP_SECRET: 'explicit-secret',
    APP_BASE_URL: 'http://127.0.0.1:8765',
    APP_ENCRYPTION_KEY: TEST_KEY_HEX,
    ALLOWED_SHOPS: 'shop.example',
    LOCAL_DEMO: 'false',
    ...extra,
  };
}

describe('loadConfig isolation', () => {
  const previous = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
  });

  function overlayProcess(values: Record<string, string>): void {
    for (const key of ENV_KEYS) {
      if (!previous.has(key)) previous.set(key, process.env[key]);
    }
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }

  it('uses the supplied env and ignores process env and .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-config-'));
    writeFileSync(join(dir, '.env'), 'INSALES_APP_ID=from-file\nINSALES_APP_SECRET=file-secret\n');
    overlayProcess({ INSALES_APP_ID: 'from-process', INSALES_APP_SECRET: 'process-secret' });
    const config = loadConfig({
      baseDir: dir,
      env: baseEnv(),
      readEnvFile: false,
    });
    expect(config.insalesAppId).toBe('explicit-app');
    expect(config.insalesAppSecret).toBe('explicit-secret');
    expect(config.trustProxy).toBe(false);
  });

  it('parses proxy addresses and rejects trust-all or hop-count values', () => {
    const addresses = loadConfig({
      env: baseEnv({ TRUST_PROXY: '127.0.0.1, 10.0.0.0/8' }),
      readEnvFile: false,
    });
    expect(addresses.trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(() => loadConfig({ env: baseEnv({ TRUST_PROXY: 'true' }), readEnvFile: false })).toThrow(
      /TRUST_PROXY/,
    );
    expect(() => loadConfig({ env: baseEnv({ TRUST_PROXY: '1' }), readEnvFile: false })).toThrow(
      /TRUST_PROXY/,
    );
    expect(() =>
      loadConfig({ env: baseEnv({ TRUST_PROXY: '0.0.0.0/0' }), readEnvFile: false }),
    ).toThrow(/TRUST_PROXY/);
  });
});
