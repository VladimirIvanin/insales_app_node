import { AppConfig } from '../config.js';
import { createClient } from '../insales/client.js';
import { ApiError, ProtocolError } from '../insales/errors.js';
import { installPassword, normalizeShop } from '../insales/protocol.js';
import { claimVerification, releaseVerification, retryDelay } from './verification-budget.js';
import type { TransportOptions } from '../insales/transport.js';
import { lifecycleHooks } from './hooks.js';
import {
  activateCandidate,
  createCandidate,
  decryptCandidatePassword,
  findCandidate,
  getStore,
  pendingCandidates,
  type CandidateRow,
  rejectCandidate,
  uninstallStore,
  updateStoreTitle,
  PendingQuotaError,
} from '../storage/installations.js';

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
  createCandidate(config, insalesId, normalizedShop, password);
}

export async function receiveInstallation(
  config: AppConfig,
  shop: string,
  storeId: string,
  token: string,
): Promise<void> {
  try {
    handleInstall(config, shop, storeId, token);
    return;
  } catch (err) {
    if (!(err instanceof PendingQuotaError)) throw err;
  }
  const normalizedShop = normalizeShop(shop);
  const deadline = Date.now() + 2000;
  for (const candidate of pendingCandidates(normalizedShop)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await inspectCandidate(config, candidate, {
      appId: config.insalesAppId,
      allowHttp: config.localDemo,
      timeout: remaining,
    });
    if (result.status === 'invalid') {
      rejectCandidate(candidate.id);
      handleInstall(config, shop, storeId, token);
      return;
    }
    if (result.status === 'unavailable') break;
  }
  throw new PendingQuotaError(normalizedShop);
}

type Inspection =
  { status: 'valid'; title: string } | { status: 'invalid' } | { status: 'unavailable' };

async function inspectCandidate(
  config: AppConfig,
  candidate: CandidateRow,
  options: Omit<TransportOptions, 'shop' | 'password'>,
): Promise<Inspection> {
  const permit = claimVerification(candidate.shop);
  if (!permit) return { status: 'unavailable' };
  let delay = 0;
  try {
    const client = createClient({
      ...options,
      shop: candidate.shop,
      password: decryptCandidatePassword(config, candidate),
    });
    const { account } = await client.account.get();
    return account.id === candidate.store_id
      ? { status: 'valid', title: account.title }
      : { status: 'invalid' };
  } catch (err) {
    if (isCredentialRejection(err)) return { status: 'invalid' };
    delay = err instanceof ApiError ? retryDelay(err.retryAfter) : 5;
    return { status: 'unavailable' };
  } finally {
    releaseVerification(candidate.shop, permit, delay);
  }
}

/**
 * Verify one candidate. Credential and identity failures remove that candidate.
 * Network, timeout and malformed responses keep it until the TTL.
 * Activation rechecks the candidate under the write lock, so a newer confirmed
 * connection is not replaced by this result.
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

  const result = await inspectCandidate(config, candidate, transportOpts);
  if (result.status === 'invalid') {
    rejectCandidate(candidate.id);
    return { generation: null, diagnostic: 'api_rejected' };
  }
  if (result.status === 'unavailable') return { generation: null, diagnostic: 'transient_error' };
  if (lifecycleHooks.afterAccountRead) await lifecycleHooks.afterAccountRead();
  const generation = activateCandidate(config, candidate.id);
  if (lifecycleHooks.afterActivate) await lifecycleHooks.afterActivate();
  if (generation !== null) {
    updateStoreTitle(storeId, result.title, generation);
    return { generation, diagnostic: 'activated' };
  }
  const current = getStore(storeId);
  if (current && current.generation > candidate.ordinal)
    return { generation: null, diagnostic: 'stale_candidate' };
  return { generation: null, diagnostic: 'activation_failed' };
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
