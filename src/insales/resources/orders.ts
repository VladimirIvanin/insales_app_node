import { apiRequest, type QueryParams, type TransportOptions } from '../transport.js';
import { ResponseError } from '../errors.js';
import {
  assertResourceId,
  paginationQuery,
  requireCount,
  requireId,
  requireRecord,
} from './shape.js';

/** Fields this client checks. An InSales order object contains many more. */
export interface Order {
  id: string;
  number: number | null;
  fulfillmentStatus: string | null;
  financialStatus: string | null;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  /**
   * Additional documented query parameters, encoded as given.
   * Array values are repeated. `page` and `per_page` belong to the fields above.
   * Example: `{ 'fulfillment_status[]': ['new', 'delivered'] }`.
   */
  query?: QueryParams;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeOrder(raw: unknown): Order {
  const record = requireRecord(raw, 'order');
  return {
    id: requireId(record, 'Order'),
    number: optionalNumber(record.number),
    fulfillmentStatus: optionalString(record.fulfillment_status),
    financialStatus: optionalString(record.financial_status),
  };
}

function normalizeOrderList(raw: unknown): Order[] {
  if (!Array.isArray(raw)) throw new ResponseError('Expected order list');
  return raw.map((item) => normalizeOrder(item));
}

export function createOrders(options: TransportOptions) {
  return {
    async list(list: ListOptions = {}): Promise<{ orders: Order[]; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: '/admin/orders.json',
        query: paginationQuery(list.page, list.perPage, list.query),
      });
      return { orders: normalizeOrderList(result.data), usage: result.usage };
    },

    async get(id: string): Promise<{ order: Order; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: `/admin/orders/${assertResourceId(id)}.json`,
      });
      return { order: normalizeOrder(result.data), usage: result.usage };
    },

    async count(query?: QueryParams): Promise<{ count: number; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: '/admin/orders/count.json',
        query,
      });
      return { count: requireCount(result.data), usage: result.usage };
    },

    /**
     * PUT /admin/orders/:id.json with `{ order: patch }`.
     * A timeout means the result is unknown. Do not retry the PUT blindly.
     */
    async update(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<{ order: Order; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'PUT',
        path: `/admin/orders/${assertResourceId(id)}.json`,
        body: { order: patch },
        successStatuses: [200],
      });
      return { order: normalizeOrder(result.data), usage: result.usage };
    },
  };
}
