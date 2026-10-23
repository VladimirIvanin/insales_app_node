import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import { apiGet, isDisallowedAddress, readCappedBody } from '../../src/insales/transport.js';

describe('address policy', () => {
  it('blocks private, loopback, mapped and local ranges used by the connector', () => {
    expect(isDisallowedAddress('10.1.2.3', true)).toBe(true);
    expect(isDisallowedAddress('10.1.2.3', false)).toBe(true);
    expect(isDisallowedAddress('172.16.0.0', false)).toBe(true);
    expect(isDisallowedAddress('172.15.255.255', false)).toBe(false);
    expect(isDisallowedAddress('192.168.1.1', false)).toBe(true);
    expect(isDisallowedAddress('169.254.169.254', false)).toBe(true);
    expect(isDisallowedAddress('127.0.0.1', false)).toBe(true);
    expect(isDisallowedAddress('127.0.0.1', true)).toBe(false);
    expect(isDisallowedAddress('::1', true)).toBe(false);
    expect(isDisallowedAddress('::1', false)).toBe(true);
    expect(isDisallowedAddress('::ffff:192.168.0.5', false)).toBe(true);
    expect(isDisallowedAddress('::ffff:7f00:1', true)).toBe(false);
    expect(isDisallowedAddress('::ffff:7f00:1', false)).toBe(true);
    expect(isDisallowedAddress('fd00::1', false)).toBe(true);
    expect(isDisallowedAddress('fe80::1', false)).toBe(true);
    expect(isDisallowedAddress('8.8.8.8', false)).toBe(false);
    expect(isDisallowedAddress('8.8.8.8', true)).toBe(true);
    expect(isDisallowedAddress('not-an-ip', false)).toBe(true);
  });
});

describe('response limits', () => {
  it('stops reading once the cap is exceeded', async () => {
    let pulls = 0;
    async function* chunks() {
      while (pulls < 10) {
        pulls += 1;
        yield Buffer.alloc(1000, 1);
      }
    }
    await expect(readCappedBody(chunks(), 2500)).rejects.toThrow(/too large/);
    expect(pulls).toBe(3);
  });
});

describe('connector policy', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function listen(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ server: Server; port: number; connections: () => number }> {
    let connections = 0;
    const server = createServer((request, response) => {
      connections += 1;
      handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { server, port: address.port, connections: () => connections };
  }

  it('connects to the looked-up loopback address and rejects the next private address', async () => {
    const seen: string[] = [];
    const { port, connections } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":1,"title":"loop"}');
    });
    let calls = 0;
    const lookup = async (hostname: string) => {
      seen.push(hostname);
      calls += 1;
      if (calls === 1) return [{ address: '127.0.0.1', family: 4 }];
      return [{ address: '10.0.0.8', family: 4 }];
    };
    const first = await apiGet<{ id: number }>(
      {
        appId: 'demo-app',
        shop: `rebind.example:${port}`,
        password: 'pw',
        allowHttp: true,
        lookup,
        timeout: 1000,
      },
      '/admin/account.json',
    );
    expect(first.data.id).toBe(1);
    expect(connections()).toBe(1);

    await expect(
      apiGet(
        {
          appId: 'demo-app',
          shop: `rebind.example:${port}`,
          password: 'pw',
          allowHttp: true,
          lookup,
          timeout: 1000,
        },
        '/admin/account.json',
      ),
    ).rejects.toThrow(/SSRF protection/);
    expect(connections()).toBe(1);
    expect(seen).toEqual(['rebind.example', 'rebind.example']);
  });

  it('rejects a mapped private address before opening a connection', async () => {
    const { port, connections } = await listen((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await expect(
      apiGet(
        {
          appId: 'demo-app',
          shop: `mapped.example:${port}`,
          password: 'pw',
          allowHttp: true,
          lookup: async () => [{ address: '::ffff:192.168.1.9', family: 6 }],
          timeout: 1000,
        },
        '/admin/account.json',
      ),
    ).rejects.toThrow(/SSRF protection/);
    expect(connections()).toBe(0);
  });

  it('aborts a slow body within the total deadline', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"id":');
      setTimeout(() => response.end('1}'), 1000);
    });
    const started = Date.now();
    await expect(
      apiGet(
        {
          appId: 'demo-app',
          shop: `127.0.0.1:${port}`,
          password: 'pw',
          allowHttp: true,
          timeout: 200,
        },
        '/slow',
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(800);
  });

  it('rejects an oversized body before the server finishes sending it', async () => {
    let written = 0;
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(200, 1);
      const write = () => {
        if (response.destroyed || written >= 40_000) {
          response.end();
          return;
        }
        written += chunk.length;
        if (!response.write(chunk)) response.once('drain', write);
        else setTimeout(write, 20);
      };
      write();
    });
    const started = Date.now();
    await expect(
      apiGet(
        {
          appId: 'demo-app',
          shop: `127.0.0.1:${port}`,
          password: 'pw',
          allowHttp: true,
          timeout: 3000,
          maxResponseSize: 500,
        },
        '/big',
      ),
    ).rejects.toThrow(/too large/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(written).toBeLessThan(40_000);
  });
});
