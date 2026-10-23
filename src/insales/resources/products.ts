import { apiRequest, type QueryParams, type TransportOptions } from '../transport.js';
import { ResponseError } from '../errors.js';
import {
  assertResourceId,
  paginationQuery,
  requireCount,
  requireId,
  requireRecord,
} from './shape.js';

/** Fields this client checks. An InSales product object contains many more. */
export interface Product {
  id: string;
  title: string;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  /**
   * Additional documented query parameters, encoded as given.
   * Example: `{ updated_since: '2009-01-04 14:44:43 +0300', from_id: 10 }`.
   */
  query?: QueryParams;
}

export function normalizeProduct(raw: unknown): Product {
  const record = requireRecord(raw, 'product');
  const title = typeof record.title === 'string' ? record.title : '';
  return { id: requireId(record, 'Product'), title };
}

function normalizeProductList(raw: unknown): Product[] {
  if (!Array.isArray(raw)) throw new ResponseError('Expected product list');
  return raw.map((item) => normalizeProduct(item));
}

export function createProducts(options: TransportOptions) {
  return {
    async list(list: ListOptions = {}): Promise<{ products: Product[]; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: '/admin/products.json',
        query: paginationQuery(list.page, list.perPage, list.query),
      });
      return { products: normalizeProductList(result.data), usage: result.usage };
    },

    async get(id: string): Promise<{ product: Product; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: `/admin/products/${assertResourceId(id)}.json`,
      });
      return { product: normalizeProduct(result.data), usage: result.usage };
    },

    async count(query?: QueryParams): Promise<{ count: number; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'GET',
        path: '/admin/products/count.json',
        query,
      });
      return { count: requireCount(result.data), usage: result.usage };
    },

    /**
     * PUT /admin/products/:id.json with `{ product: patch }`.
     * A timeout means the result is unknown. Do not retry the PUT blindly.
     */
    async update(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<{ product: Product; usage?: string }> {
      const result = await apiRequest<unknown>(options, {
        method: 'PUT',
        path: `/admin/products/${assertResourceId(id)}.json`,
        body: { product: patch },
        successStatuses: [200],
      });
      return { product: normalizeProduct(result.data), usage: result.usage };
    },
  };
}
