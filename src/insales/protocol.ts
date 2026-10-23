import { createHash, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from './errors.js';

/**
 * Compute MD5 hex digest of concatenated string parts.
 * This is part of the existing InSales protocol (install password, token3).
 * Do NOT use MD5 for new application-level security mechanisms.
 */
export function md5(...parts: (string | number | boolean)[]): string {
  const input = parts.map(p => String(p)).join('');
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * Compute the install password: MD5(install_token + app_secret).
 */
export function installPassword(token: string, appSecret: string): string {
  return md5(token, appSecret);
}

/**
 * Compute token: MD5(nonce + password)
 */
export function computeToken(nonce: string, password: string): string {
  return md5(nonce, password);
}

/**
 * Compute token2: MD5(nonce + user_email + user_name + user_id + password)
 */
export function computeToken2(nonce: string, userEmail: string, userName: string, userId: string, password: string): string {
  return md5(nonce, userEmail, userName, userId, password);
}

/**
 * Compute token3: MD5(nonce + user_email + user_name + user_id + email_confirmed + password)
 */
export function computeToken3(
  nonce: string,
  userEmail: string,
  userName: string,
  userId: string,
  emailConfirmed: string,
  password: string,
): string {
  return md5(nonce, userEmail, userName, userId, emailConfirmed, password);
}

/**
 * Constant-time hex string comparison.
 * Both strings must already be validated for hex format and length.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'ascii');
  const bufB = Buffer.from(b, 'ascii');
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Validate and normalize a shop domain.
 * Returns the lowercased domain or throws ProtocolError.
 */
export function normalizeShop(shop: string): string {
  const normalized = shop.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/.test(normalized)) {
    throw new ProtocolError(`Invalid shop domain format: ${shop}`);
  }
  return normalized;
}

/**
 * Validate hex MD5 format (32 lowercase hex chars).
 */
export function isValidHexSignature(sig: string): boolean {
  return /^[a-f0-9]{32}$/.test(sig);
}

/**
 * Validate a hex encryption key format (64 hex chars for 32 bytes).
 */
export function isValidHexKey(key: string): boolean {
  return /^[a-f0-9]{64}$/i.test(key);
}