import { apiGet } from '../transport.js';
import { ApiError } from '../errors.js';
import type { TransportOptions } from '../transport.js';

export interface Account {
  /** InSales account/store ID, normalized to string */
  id: string;
  /** Store title — may be empty */
  title: string;
}

/**
 * Normalize a raw account response from InSales API.
 * The API returns id as a number, we normalize to string for safe comparison.
 */
function normalizeAccount(raw: Record<string, unknown>): Account {
  let id: string;
  const rawId = raw.id;
  if (typeof rawId === 'number') {
    // Check if the number is within safe integer range
    if (!Number.isSafeInteger(rawId) || rawId < 0) {
      throw new ApiError(0, undefined, undefined, 'Account ID is outside safe integer range');
    }
    id = String(rawId);
  } else if (typeof rawId === 'string') {
    if (!/^\d+$/.test(rawId)) {
      throw new ApiError(0, undefined, undefined, 'Account ID is not a valid numeric string');
    }
    id = rawId;
  } else {
    throw new ApiError(0, undefined, undefined, 'Account ID is missing or invalid type');
  }

  const title = typeof raw.title === 'string' ? raw.title : '';

  return { id, title };
}

/**
 * Get account info from the InSales API.
 */
export async function getAccount(transportOpts: TransportOptions): Promise<{ account: Account; usage?: string }> {
  const result = await apiGet<Record<string, unknown>>(transportOpts, '/admin/account.json');
  const account = normalizeAccount(result.data);
  return { account, usage: result.usage };
}