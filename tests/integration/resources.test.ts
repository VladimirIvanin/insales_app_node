import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '../../src/insales/client.js';
import { apiRequest, resolveApiPath } from '../../src/insales/transport.js';
import { ApiError, ResponseError, TransportError } from '../../src/insales/errors.js';
import { InSalesSimulator } from '../support/insales-simulator.js';

describe('orders and products client', () => {
  const sim = new InSalesSimulator();
  const appId = 'demo-app';
  let shop = '';

  beforeAll(async () => {
    sim.setAppId(appId);
    sim.setPassword('unused');
    await sim.start();
    shop = `127.0.0.1:${sim.port}`;
  });

  afterAll(async () => {
    await sim.stop();
  });

  function client(password: string) {
    return createClient({
      appId,
      shop,
      password,
      allowHttp: true,
      timeout: 1_000,
    });
  }

  it('lists, reads, counts and updates orders and products on the simulator', async () => {
    sim.clearRecorded();
    sim.setResponse('GET', '/admin/orders.json?page=2&per_page=1&fulfillment_status%5B%5D=new', {
      status: 200,
      headers: { 'content-type': 'application/json', 'api-usage-limit': '3/500' },
      body: JSON.stringify([
        { id: 15, number: 1001, fulfillment_status: 'new', financial_status: 'pending' },
      ]),
    });
    sim.setResponse('GET', '/admin/orders/15.json', {
      status: 200,
      headers: { 'content-type': 'application/json', 'api-usage-limit': '4/500' },
      body: JSON.stringify({
        id: '15',
        number: 1001,
        fulfillment_status: 'new',
        financial_status: 'paid',
      }),
    });
    sim.setResponse('GET', '/admin/orders/count.json', {
      status: 200,
      headers: { 'content-type': 'application/json', 'api-usage-limit': '5/500' },
      body: JSON.stringify({ count: 0 }),
    });
    sim.setResponse('PUT', '/admin/orders/15.json', {
      status: 200,
      headers: { 'content-type': 'application/json', 'api-usage-limit': '6/500' },
      body: JSON.stringify({
        id: 15,
        number: 1001,
        fulfillment_status: 'delivered',
        financial_status: 'paid',
      }),
    });
    sim.setResponse('GET', '/admin/products.json?page=1&per_page=25', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    sim.setResponse('GET', '/admin/products/4.json', {
      status: 200,
      headers: { 'content-type': 'application/json', 'api-usage-limit': '7/500' },
      body: JSON.stringify({ id: 4, title: 'Shirt' }),
    });
    sim.setResponse('GET', '/admin/products/count.json?updated_since=2009-01-04+14%3A44%3A43', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 5 }),
    });
    sim.setResponse('PUT', '/admin/products/4.json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 4, title: 'Updated shirt' }),
    });

    const api = client('password-a');
    const listed = await api.orders.list({
      page: 2,
      perPage: 1,
      query: { 'fulfillment_status[]': ['new'] },
    });
    expect(listed.orders).toEqual([
      {
        id: '15',
        number: 1001,
        fulfillmentStatus: 'new',
        financialStatus: 'pending',
      },
    ]);
    expect(listed.usage).toBe('3/500');
    const one = await api.orders.get('15');
    expect(one.order.financialStatus).toBe('paid');
    expect(await api.orders.count()).toEqual({ count: 0, usage: '5/500' });
    const updated = await api.orders.update('15', { manager_comment: 'note' });
    expect(updated.order.fulfillmentStatus).toBe('delivered');

    expect(await api.products.list({ page: 1, perPage: 25 })).toEqual({
      products: [],
      usage: undefined,
    });
    expect((await api.products.get('4')).product).toEqual({ id: '4', title: 'Shirt' });
    expect((await api.products.count({ updated_since: '2009-01-04 14:44:43' })).count).toBe(5);
    expect((await api.products.update('4', { title: 'Updated shirt' })).product.title).toBe(
      'Updated shirt',
    );

    const calls = sim.recorded();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /admin/orders.json?page=2&per_page=1&fulfillment_status%5B%5D=new',
      'GET /admin/orders/15.json',
      'GET /admin/orders/count.json',
      'PUT /admin/orders/15.json',
      'GET /admin/products.json?page=1&per_page=25',
      'GET /admin/products/4.json',
      'GET /admin/products/count.json?updated_since=2009-01-04+14%3A44%3A43',
      'PUT /admin/products/4.json',
    ]);
    expect(JSON.parse(calls[3].body)).toEqual({ order: { manager_comment: 'note' } });
    expect(JSON.parse(calls[7].body)).toEqual({ product: { title: 'Updated shirt' } });
    const expectedAuth = `Basic ${Buffer.from(`${appId}:password-a`).toString('base64')}`;
    expect(calls.every((call) => call.authorization === expectedAuth)).toBe(true);
  });

  it('does not mix credentials of two shops', async () => {
    sim.clearRecorded();
    sim.setResponse('GET', '/admin/orders/count.json', {
      status: 200,
      headers: { 'api-usage-limit': '1/500' },
      body: '{"count":1}',
    });
    await client('alpha-secret').orders.count();
    await client('beta-secret').orders.count();
    const auths = sim.recorded().map((call) => call.authorization);
    expect(auths[0]).toBe(`Basic ${Buffer.from(`${appId}:alpha-secret`).toString('base64')}`);
    expect(auths[1]).toBe(`Basic ${Buffer.from(`${appId}:beta-secret`).toString('base64')}`);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it('reports http, response and transport failures without the payload or a retry', async () => {
    const api = client('password-a');
    const personal = '{"errors":{"email":"hidden-person@example.invalid"}}';
    const cases: Array<[string, string, number, string | undefined]> = [
      ['GET', '/admin/orders/9.json', 401, undefined],
      ['GET', '/admin/orders/9.json', 403, undefined],
      ['GET', '/admin/orders/9.json', 404, undefined],
      ['PUT', '/admin/orders/9.json', 422, '30'],
      ['GET', '/admin/orders.json', 429, '15'],
      ['GET', '/admin/products.json', 503, undefined],
    ];
    for (const [method, path, status, retryAfter] of cases) {
      sim.clearRecorded();
      sim.setResponse(method, path, {
        status,
        headers: {
          'api-usage-limit': '9/500',
          ...(retryAfter ? { 'retry-after': retryAfter } : {}),
        },
        body: personal,
      });
      const action =
        method === 'PUT'
          ? api.orders.update('9', { comment: 'x' })
          : path.includes('products')
            ? api.products.list()
            : path.includes('/9.')
              ? api.orders.get('9')
              : api.orders.list();
      let caught: unknown;
      try {
        await action;
      } catch (err: unknown) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiError = caught as ApiError;
      expect(apiError.kind).toBe('http');
      expect(apiError.status).toBe(status);
      expect(apiError.usage).toBe('9/500');
      expect(apiError.body).toBe(personal);
      expect(apiError.data).toEqual(JSON.parse(personal));
      expect(apiError.retryAfter).toBe(retryAfter);
      expect(apiError.message).not.toContain('hidden-person');
      expect(apiError.message).not.toContain('password-a');
      expect(sim.recorded()).toHaveLength(1);
    }

    sim.clearRecorded();
    sim.setResponse('GET', '/admin/orders.json', { status: 200, body: '{"orders":[]}' });
    await expect(api.orders.list()).rejects.toBeInstanceOf(ResponseError);
    sim.setResponse('GET', '/admin/orders/count.json', { status: 200, body: 'not-json' });
    await expect(api.orders.count()).rejects.toThrow(/Invalid JSON/);
    sim.setResponse('GET', '/admin/products/count.json', { status: 200, body: '{"count":"5"}' });
    await expect(api.products.count()).rejects.toBeInstanceOf(ResponseError);
    await expect(api.orders.get('abc')).rejects.toThrow(/Resource id/);
    await expect(api.products.update('../4', { title: 'x' })).rejects.toThrow(/Resource id/);
    expect(sim.recorded().some((call) => call.url.includes('..'))).toBe(false);

    sim.clearRecorded();
    sim.setResponse('PUT', '/admin/orders/9.json', {
      status: 200,
      body: '{"id":9}',
      delayMs: 1_000,
    });
    await expect(api.orders.update('9', { comment: 'late' })).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(sim.recorded().filter((call) => call.method === 'PUT')).toHaveLength(1);

    expect(() => resolveApiPath('https://evil.example/admin/orders.json')).toThrow(TransportError);
    expect(() => resolveApiPath('//evil.example/admin/orders.json')).toThrow(TransportError);
    expect(() => resolveApiPath('/admin/../orders.json')).toThrow(TransportError);
    await expect(
      apiRequest(
        {
          appId,
          shop,
          password: 'password-a',
          allowHttp: true,
        },
        { method: 'GET', path: '/admin/orders.json?page=1' },
      ),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
