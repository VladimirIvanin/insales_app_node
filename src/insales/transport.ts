import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, request, type Dispatcher } from 'undici';
import { ApiError } from './errors.js';
import { normalizeShop } from './protocol.js';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type AddressLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportOptions {
  appId: string;
  shop: string;
  password: string;
  basePath?: string;
  timeout?: number;
  maxResponseSize?: number;
  allowHttp?: boolean;
  /** Test seam. Production resolves through the system resolver at connect time. */
  lookup?: AddressLookup;
}

const DEFAULT_TIMEOUT = 5_000;
const DEFAULT_MAX_RESPONSE_SIZE = 2_000_000;

const specialAddresses = new BlockList();
specialAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
specialAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
specialAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
specialAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
specialAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
specialAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
specialAddresses.addSubnet('192.0.0.0', 24, 'ipv4');
specialAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
specialAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
specialAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
specialAddresses.addSubnet('240.0.0.0', 4, 'ipv4');
specialAddresses.addAddress('::', 'ipv6');
specialAddresses.addAddress('::1', 'ipv6');
specialAddresses.addSubnet('fc00::', 7, 'ipv6');
specialAddresses.addSubnet('fe80::', 10, 'ipv6');
specialAddresses.addSubnet('fec0::', 10, 'ipv6');
specialAddresses.addSubnet('ff00::', 8, 'ipv6');

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');

interface CanonicalIp {
  address: string;
  family: 'ipv4' | 'ipv6';
}

function canonicalIp(ip: string): CanonicalIp | null {
  let value = ip.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  const mappedDotted = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted && isIP(mappedDotted[1]) === 4) {
    return { address: mappedDotted[1], family: 'ipv4' };
  }

  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    return {
      address: `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
      family: 'ipv4',
    };
  }

  if (isIP(value) === 4) return { address: value, family: 'ipv4' };
  if (isIP(value) === 6) return { address: value, family: 'ipv6' };
  return null;
}

function isLoopback(ip: CanonicalIp): boolean {
  return loopbackAddresses.check(ip.address, ip.family);
}

/**
 * HTTP to a non-loopback address is rejected. HTTPS to loopback, private,
 * link-local, mapped IPv4 and other special ranges is rejected.
 */
export function isDisallowedAddress(ip: string, allowLoopbackHttp: boolean): boolean {
  const parsed = canonicalIp(ip);
  if (!parsed) return true;
  if (allowLoopbackHttp) return !isLoopback(parsed);
  return isLoopback(parsed) || specialAddresses.check(parsed.address, parsed.family);
}

async function systemLookup(hostname: string): Promise<ResolvedAddress[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
}

async function selectConnectAddress(hostname: string, allowLoopbackHttp: boolean, lookup: AddressLookup): Promise<string> {
  const literal = canonicalIp(hostname);
  const records = literal
    ? [{ address: literal.address, family: literal.family === 'ipv4' ? 4 : 6 }]
    : await lookup(hostname);
  if (records.length === 0) {
    throw new ApiError(0, undefined, undefined, 'Network error: ENOTFOUND');
  }

  for (const record of records) {
    const parsed = canonicalIp(record.address);
    if (!parsed || isDisallowedAddress(parsed.address, allowLoopbackHttp)) continue;
    return parsed.address;
  }
  throw new ApiError(0, undefined, undefined, 'SSRF protection: resolved address is not allowed');
}

function secureConnector(allowLoopbackHttp: boolean, lookup: AddressLookup): buildConnector.connector {
  const connect = buildConnector({ rejectUnauthorized: true });
  return (options, callback) => {
    selectConnectAddress(options.hostname, allowLoopbackHttp, lookup).then((address) => {
      const hostnameIsIp = isIP(options.hostname) !== 0;
      connect({
        ...options,
        hostname: address,
        host: address,
        servername: hostnameIsIp ? options.servername : options.hostname,
      }, callback);
    }).catch((err: unknown) => {
      callback(err instanceof Error ? err : new Error(String(err)), null);
    });
  };
}

export async function readCappedBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (received + buf.length > maxBytes) {
      throw new ApiError(0, undefined, undefined, `API response too large: ${received + buf.length} bytes`);
    }
    received += buf.length;
    chunks.push(buf);
  }
  return received === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, received);
}

function destroyBody(body: Dispatcher.ResponseData['body']): void {
  if (body && typeof body.destroy === 'function') body.destroy();
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function asApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) return err;
  if (err instanceof Error && err.cause instanceof Error) return asApiError(err.cause);
  if (err instanceof Error && err.message.includes('SSRF protection')) {
    return new ApiError(0, undefined, undefined, err.message);
  }
  return null;
}

function isAbort(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = 'code' in err ? String(err.code) : '';
  return err.name === 'AbortError'
    || code === 'UND_ERR_ABORTED'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT';
}

/**
 * Execute an API request to InSales.
 * The total deadline covers headers and the body. The response is counted
 * while it is read and discarded once it exceeds the cap.
 */
export async function apiGet<T>(options: TransportOptions, path: string): Promise<{ data: T; status: number; usage?: string }> {
  const {
    appId,
    shop,
    password,
    timeout = DEFAULT_TIMEOUT,
    maxResponseSize = DEFAULT_MAX_RESPONSE_SIZE,
    allowHttp = false,
    lookup = systemLookup,
  } = options;

  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new ApiError(0, undefined, undefined, 'API path must be a relative path');
  }

  const normalizedShop = normalizeShop(shop);
  const protocol = allowHttp ? 'http' : 'https';
  const url = `${protocol}://${normalizedShop}${path}`;
  const auth = Buffer.from(`${appId}:${password}`).toString('base64');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const dispatcher = new Agent({
    connect: secureConnector(allowHttp, lookup),
    connectTimeout: timeout,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });

  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      dispatcher,
    });

    const { statusCode, headers } = response;
    let text: string;
    try {
      const body = await readCappedBody(response.body, maxResponseSize);
      text = body.toString('utf8');
    } catch (err) {
      destroyBody(response.body);
      throw err;
    }

    if (statusCode !== 200) {
      throw new ApiError(
        statusCode,
        headerString(headers['api-usage-limit']),
        headerString(headers['retry-after']),
      );
    }

    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new ApiError(0, undefined, undefined, 'Invalid JSON in API response');
    }

    return {
      data: parsed,
      status: statusCode,
      usage: headerString(headers['api-usage-limit']),
    };
  } catch (err: unknown) {
    const apiError = asApiError(err);
    if (apiError) throw apiError;
    if (isAbort(err) || controller.signal.aborted) {
      throw new ApiError(0, undefined, undefined, 'API request timed out');
    }
    if (err instanceof Error && 'code' in err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ECONNREFUSED' || nodeErr.code === 'ENOTFOUND' || nodeErr.code === 'ECONNRESET') {
        throw new ApiError(0, undefined, undefined, `Network error: ${nodeErr.code}`);
      }
    }
    throw new ApiError(0, undefined, undefined, `Request failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
    await dispatcher.close();
  }
}
