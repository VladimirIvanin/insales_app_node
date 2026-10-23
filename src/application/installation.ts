import { AppConfig } from '../config.js';
import { installPassword, normalizeShop } from '../insales/protocol.js';
import { getAccount } from '../insales/resources/account.js';
import { ApiError, ProtocolError } from '../insales/errors.js';
import {
  createCandidate,
  findCandidate,
  activateCandidate,
  rejectCandidate,
  getStore,
  getStoreByShop,
  uninstallStore,
  decryptCandidatePassword,
  updateStoreTitle,
  PendingQuotaError,
} from '../storage/installations.js';
import type { TransportOptions } from '../insales/transport.js';

/**
 * Save an install candidate and return. The callback does not call the API.
 */
export function handleInstall(
  config: AppConfig,
  shop: string,
  insalesId: string,
  token: string,
): void {
  const normalizedShop = normalizeShop(shop);
  if (!config.allowedShops.includes(normalizedShop)) {
    throw new ProtocolError(`Shop ${normalizedShop} is not in ALLOWED_SHOPS`);
  }
  if (!/^\d+$/.test(insalesId)) {
    throw new ProtocolError(`Invalid insales_id: ${insalesId}`);
  }
  if (!token || token.length < 1) {
    throw new ProtocolError('Token is empty');
  }

  const password = installPassword(token, config.insalesAppSecret);
  try {
    createCandidate(config, insalesId, normalizedShop, password);
  } catch (err: unknown) {
    if (err instanceof PendingQuotaError) {
      throw new ProtocolError('Too many pending installations for this shop');
    }
    throw err;
  }
}

/**
 * Verify one candidate. Credential and identity failures remove that candidate.
 * Network, timeout and malformed responses keep it until the TTL.
 */
export async function verifyCandidate(
  config: AppConfig,
  storeId: string,
  shop: string,
  transportOpts: Omit<TransportOptions, 'shop' | 'password'>,
): Promise<{ generation: number | null; diagnostic: string }> {
  const normalizedShop = normalizeShop(shop);
  const candidate = findCandidate(storeId, normalizedShop);

  if (!candidate) {
    const active = getStore(storeId);
    if (active) return { generation: null, diagnostic: 'no_candidate_active_exists' };
    return { generation: null, diagnostic: 'no_candidate_no_active' };
  }

  const password = decryptCandidatePassword(config, candidate);
  const opts: TransportOptions = {
    ...transportOpts,
    shop: normalizedShop,
    password,
    basePath: '',
  };

  try {
    const { account } = await getAccount(opts);
    if (account.id !== storeId) {
      rejectCandidate(candidate.id);
      return { generation: null, diagnostic: 'identity_mismatch' };
    }

    const generation = activateCandidate(config, candidate.id);
    if (generation !== null) {
      updateStoreTitle(storeId, account.title);
      return { generation, diagnostic: 'activated' };
    }
    const owner = getStoreByShop(normalizedShop);
    if (owner && owner.id !== storeId) {
      rejectCandidate(candidate.id);
      return { generation: null, diagnostic: 'shop_taken' };
    }
    return { generation: null, diagnostic: 'activation_failed' };
  } catch (err: unknown) {
    if (isCredentialRejection(err)) {
      rejectCandidate(candidate.id);
      return { generation: null, diagnostic: 'api_rejected' };
    }
    return { generation: null, diagnostic: 'transient_error' };
  }
}

function isCredentialRejection(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * The uninstall token is the ready store password. It is not hashed again.
 * The HTTP response is always success so the callback does not reveal whether
 * a matching connection existed.
 */
export function handleUninstall(
  config: AppConfig,
  shop: string,
  insalesId: string,
  token: string,
): boolean {
  const normalizedShop = normalizeShop(shop);
  if (!config.allowedShops.includes(normalizedShop)) return true;
  uninstallStore(config, insalesId, normalizedShop, token);
  return true;
}
