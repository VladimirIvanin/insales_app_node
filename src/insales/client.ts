import { getAccount, type Account } from './resources/account.js';
import { createOrders } from './resources/orders.js';
import { createProducts } from './resources/products.js';
import type { TransportOptions } from './transport.js';

export interface ClientOptions {
  appId: string;
  shop: string;
  password: string;
  allowHttp?: boolean;
  timeout?: number;
  maxResponseSize?: number;
  lookup?: TransportOptions['lookup'];
}

export interface InsalesClient {
  readonly account: {
    get(): Promise<{ account: Account; usage?: string }>;
  };
  readonly orders: ReturnType<typeof createOrders>;
  readonly products: ReturnType<typeof createProducts>;
}

function toTransport(options: ClientOptions): TransportOptions {
  return {
    appId: options.appId,
    shop: options.shop,
    password: options.password,
    allowHttp: options.allowHttp,
    timeout: options.timeout,
    maxResponseSize: options.maxResponseSize,
    lookup: options.lookup,
  };
}

/**
 * Client bound to one shop. Options are copied and frozen; there is no shared mutable client.
 */
export function createClient(options: ClientOptions): InsalesClient {
  const fixed = Object.freeze({ ...options });
  const transport = toTransport(fixed);
  return Object.freeze({
    account: Object.freeze({
      get: () => getAccount(transport),
    }),
    orders: createOrders(transport),
    products: createProducts(transport),
  });
}
