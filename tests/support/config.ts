import type { AppConfig } from '../../src/config.js';

export const TEST_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function syntheticConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appEnv: 'test',
    insalesAppId: 'demo-app',
    insalesAppSecret: 'demo-secret',
    appBaseUrl: 'http://127.0.0.1:8765',
    appEncryptionKey: Buffer.from(TEST_KEY_HEX, 'hex'),
    allowedShops: ['shop.example'],
    appRuntimeDir: overrides.appRuntimeDir ?? '',
    appDb: overrides.appDb ?? '',
    bindHost: '127.0.0.1',
    port: 8765,
    logLevel: 'silent',
    trustProxy: false,
    localDemo: true,
    ...overrides,
  };
}
