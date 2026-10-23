import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export interface AppConfig {
  appEnv: 'development' | 'test' | 'production';
  insalesAppId: string;
  insalesAppSecret: string;
  appBaseUrl: string;
  appEncryptionKey: Buffer;
  allowedShops: string[];
  appRuntimeDir: string;
  appDb: string;
  bindHost: string;
  port: number;
  logLevel: string;
  trustProxy: TrustProxy;
  localDemo: boolean;
}

export type TrustProxy = false | string[];

export interface LoadConfigOptions {
  baseDir?: string;
  env?: Record<string, string | undefined>;
  readEnvFile?: boolean;
}

function readEnvFile(baseDir: string): Record<string, string> {
  const envPath = resolve(baseDir, '.env');
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

function readSetting(
  key: string,
  source: Record<string, string | undefined>,
  envFiles: Record<string, string>,
  defaultValue?: string,
): string {
  const val = source[key] ?? envFiles[key] ?? defaultValue;
  if (val === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function readOptionalSetting(
  key: string,
  source: Record<string, string | undefined>,
  envFiles: Record<string, string>,
): string | undefined {
  return source[key] ?? envFiles[key];
}

export function loadConfig(arg?: string | LoadConfigOptions): AppConfig {
  const options: LoadConfigOptions =
    typeof arg === 'string' || arg === undefined ? { baseDir: arg, readEnvFile: true } : arg;
  const dir = options.baseDir ?? process.cwd();
  const source = options.env ?? process.env;
  const envFiles = (options.readEnvFile ?? options.env === undefined) ? readEnvFile(dir) : {};
  const getEnv = (key: string, defaultValue?: string) =>
    readSetting(key, source, envFiles, defaultValue);
  const getOptionalEnv = (key: string) => readOptionalSetting(key, source, envFiles);

  const appEnv = getEnv('APP_ENV', 'development');
  if (!['development', 'test', 'production'].includes(appEnv)) {
    throw new Error(`APP_ENV must be one of: development, test, production, got: ${appEnv}`);
  }

  const insalesAppId = getEnv('INSALES_APP_ID');
  const insalesAppSecret = getEnv('INSALES_APP_SECRET');

  const appBaseUrlRaw = getEnv('APP_BASE_URL');
  let appBaseUrl: string;
  try {
    const url = new URL(appBaseUrlRaw);
    if (appEnv === 'production' && url.protocol !== 'https:') {
      throw new Error('APP_BASE_URL must use HTTPS in production mode');
    }
    if (url.hash || url.search) {
      throw new Error('APP_BASE_URL must not contain query string or fragment');
    }
    appBaseUrl = url.origin;
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes('HTTPS') || err.message.includes('query')))
      throw err;
    throw new Error(`APP_BASE_URL is not a valid URL: ${appBaseUrlRaw}`, { cause: err });
  }

  const encKeyHex = getEnv('APP_ENCRYPTION_KEY');
  let appEncryptionKey: Buffer;
  try {
    appEncryptionKey = Buffer.from(encKeyHex, 'hex');
    if (appEncryptionKey.length !== 32) throw new Error();
  } catch {
    throw new Error('APP_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }

  const allowedShopsRaw = getEnv('ALLOWED_SHOPS');
  const allowedShops = allowedShopsRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (allowedShops.length === 0) {
    throw new Error('ALLOWED_SHOPS must be a non-empty comma-separated list of shop domains');
  }

  const appRuntimeDir = resolve(dir, getEnv('APP_RUNTIME_DIR', 'runtime'));

  const appDbRaw = getEnv('APP_DB', 'app.sqlite3');
  const appDb = isAbsolute(appDbRaw) ? appDbRaw : resolve(appRuntimeDir, appDbRaw);

  const bindHost = getEnv('BIND_HOST', '127.0.0.1');
  const portStr = getEnv('PORT', '8765');
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a number between 1 and 65535, got: ${portStr}`);
  }

  const logLevel = getEnv('LOG_LEVEL', 'info');
  const trustProxy = parseTrustProxy(getOptionalEnv('TRUST_PROXY'));

  const localDemoRaw = getEnv('LOCAL_DEMO', 'false').toLowerCase();
  const localDemo = localDemoRaw === 'true' || localDemoRaw === '1';

  if (localDemo && appEnv === 'production') {
    throw new Error('LOCAL_DEMO is not allowed in production mode');
  }

  return {
    appEnv: appEnv as AppConfig['appEnv'],
    insalesAppId,
    insalesAppSecret,
    appBaseUrl,
    appEncryptionKey,
    allowedShops,
    appRuntimeDir,
    appDb,
    bindHost,
    port,
    logLevel,
    trustProxy,
    localDemo,
  };
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}

function parseTrustProxy(raw: string | undefined): TrustProxy {
  if (!raw || raw.trim() === '') return false;
  const value = raw.trim();
  if (/^(true|yes|\*|all)$/i.test(value) || /^\d+$/.test(value)) {
    throw new Error('TRUST_PROXY must list proxy addresses or CIDR ranges');
  }

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  for (const part of parts) {
    if (!isProxyAddress(part)) throw new Error(`TRUST_PROXY has an invalid address: ${part}`);
  }
  return parts;
}

function isProxyAddress(part: string): boolean {
  const slash = part.indexOf('/');
  if (slash === -1) return isIP(part) !== 0;
  const address = part.slice(0, slash);
  const prefix = Number(part.slice(slash + 1));
  const family = isIP(address);
  if (!Number.isInteger(prefix) || prefix < 1) return false;
  if (family === 4) return prefix <= 32;
  if (family === 6) return prefix <= 128;
  return false;
}
