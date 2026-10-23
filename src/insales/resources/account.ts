import { apiGet, type TransportOptions } from '../transport.js';
import { ResponseError } from '../errors.js';
import { requireId, requireRecord } from './shape.js';

export interface Account {
  /** InSales account/store ID, normalized to string */
  id: string;
  /** Store title — may be empty */
  title: string;
}

function normalizeAccount(raw: unknown): Account {
  const record = requireRecord(raw, 'account');
  const id = requireId(record, 'Account');
  if (!/^\d+$/.test(id)) throw new ResponseError('Account ID is not a valid numeric string');
  const title = typeof record.title === 'string' ? record.title : '';
  return { id, title };
}

/**
 * Get account info from the InSales API.
 * GET /admin/account.json returns id and title on the root object.
 */
export async function getAccount(
  transportOpts: TransportOptions,
): Promise<{ account: Account; usage?: string }> {
  const result = await apiGet<unknown>(transportOpts, '/admin/account.json');
  return { account: normalizeAccount(result.data), usage: result.usage };
}
