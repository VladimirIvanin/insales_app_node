import { ResponseError } from '../errors.js';
import type { QueryParams } from '../transport.js';

export function assertResourceId(id: string): string {
  if (!/^[1-9]\d*$/.test(id)) {
    throw new ResponseError('Resource id must be a positive integer');
  }
  return id;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponseError(`Expected ${label} object`);
  }
  return value as Record<string, unknown>;
}

export function requireId(raw: Record<string, unknown>, label: string): string {
  const rawId = raw.id;
  if (typeof rawId === 'number') {
    if (!Number.isSafeInteger(rawId) || rawId < 0) {
      throw new ResponseError(`${label} id is outside safe integer range`);
    }
    return String(rawId);
  }
  if (typeof rawId === 'string' && /^\d+$/.test(rawId)) return rawId;
  throw new ResponseError(`${label} id is missing or invalid`);
}

export function requireCount(value: unknown): number {
  const record = requireRecord(value, 'count');
  const count = record.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new ResponseError('Count is missing or invalid');
  }
  return count;
}

export function paginationQuery(
  page: number | undefined,
  perPage: number | undefined,
  extra: QueryParams | undefined,
): QueryParams {
  if (extra && ('page' in extra || 'per_page' in extra)) {
    throw new ResponseError('page and per_page are set by the list arguments');
  }
  const query: QueryParams = {};
  if (page !== undefined) {
    if (!Number.isInteger(page) || page < 1)
      throw new ResponseError('page must be a positive integer');
    query.page = page;
  }
  if (perPage !== undefined) {
    if (!Number.isInteger(perPage) || perPage < 0 || perPage > 100) {
      throw new ResponseError('per_page must be an integer from 0 to 100');
    }
    query.per_page = perPage;
  }
  if (extra) Object.assign(query, extra);
  return query;
}
