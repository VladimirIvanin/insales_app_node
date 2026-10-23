import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiGet } from '../../src/insales/transport.js';
import {
  InSalesSimulator,
  rateLimitResponse,
  serverErrorResponse,
} from '../support/insales-simulator.js';

describe('InSales HTTP transport', () => {
  const sim = new InSalesSimulator();
  const appId = 'demo-app';
  const password = 'test-password';
  let shop: string;

  beforeAll(async () => {
    sim.setAppId(appId);
    sim.setPassword(password);
    await sim.start();
    shop = `127.0.0.1:${sim.port}`;
  });

  afterAll(async () => {
    await sim.stop();
  });

  it('performs a successful API GET to account.json', async () => {
    const result = await apiGet<{ id: number; title: string }>(
      {
        appId,
        shop,
        password,
        allowHttp: true,
      },
      '/admin/account.json',
    );
    expect(result.status).toBe(200);
    expect(result.data.id).toBe(42);
    expect(result.data.title).toBe('Test shop');
    expect(result.usage).toBe('1/500');
  });

  it('handles 401 Unauthorized', async () => {
    try {
      await apiGet(
        {
          appId,
          shop,
          password: 'wrong-password',
          allowHttp: true,
        },
        '/admin/account.json',
      );
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const apiErr = err as { status: number };
      expect(apiErr.status).toBe(401);
    }
  });

  it('handles 429 rate limit', async () => {
    sim.respondNext('GET', '/admin/account.json', rateLimitResponse('120'));
    try {
      await apiGet(
        {
          appId,
          shop,
          password,
          allowHttp: true,
        },
        '/admin/account.json',
      );
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const apiErr = err as { status: number; retryAfter?: string };
      expect(apiErr.status).toBe(429);
      expect(apiErr.retryAfter).toBe('120');
    }
  });

  it('handles 5xx server errors', async () => {
    sim.respondNext('GET', '/admin/account.json', serverErrorResponse());
    try {
      await apiGet(
        {
          appId,
          shop,
          password,
          allowHttp: true,
        },
        '/admin/account.json',
      );
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const apiErr = err as { status: number };
      expect(apiErr.status).toBe(503);
    }
  });

  it('handles malformed JSON response', async () => {
    sim.respondNext('GET', '/admin/account.json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    try {
      await apiGet(
        {
          appId,
          shop,
          password,
          allowHttp: true,
        },
        '/admin/account.json',
      );
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Invalid JSON');
    }
  });

  it('does not follow redirects', async () => {
    sim.respondNext('GET', '/admin/account.json', {
      status: 302,
      headers: { location: 'http://evil.example.com/admin/account.json' },
      body: '',
    });
    try {
      await apiGet(
        {
          appId,
          shop,
          password,
          allowHttp: true,
        },
        '/admin/account.json',
      );
      expect.fail('Should have thrown');
    } catch (err: unknown) {
      const apiErr = err as { status: number };
      expect(apiErr.status).toBe(302);
    }
  });
});
