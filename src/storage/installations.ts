import { getDb } from './database.js';
import { encrypt, decrypt, randomId } from './credentials.js';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';

export interface StoreRow {
  id: string;
  shop: string;
  password: string;
  title: string;
  generation: number;
  created_at: string;
  updated_at: string;
}

export interface CandidateRow {
  id: string;
  store_id: string;
  shop: string;
  password: string;
  ordinal: number;
  created_at: string;
  expires_at: string;
  diagnostic: string | null;
}

export type CreateCandidateResult =
  | { status: 'created'; id: string; ordinal: number }
  | { status: 'duplicate'; id: string }
  | { status: 'already_active' };

export class PendingQuotaError extends Error {
  constructor(shop: string) {
    super(`Max pending candidates (${MAX_PENDING_PER_DOMAIN}) reached for domain: ${shop}`);
    this.name = 'PendingQuotaError';
  }
}

/** Runs inside the insert transaction, after the ordinal is reserved and before commit. */
export const candidateHooks: { afterReserve: (() => void) | null } = { afterReserve: null };

const CANDIDATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PENDING_PER_DOMAIN = 5;
const NOT_EXPIRED = `CAST(expires_at AS INTEGER) > unixepoch()`;

function aadFor(shop: string, storeId: string, purpose: string): string {
  return `${shop}:${storeId}:${purpose}`;
}

function passwordsEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    timingSafeEqual(leftBuf, leftBuf);
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

function candidateExpiry(): string {
  return String(Math.floor(Date.now() / 1000) + CANDIDATE_TTL_SECONDS);
}

/**
 * Reserve the next candidate ordinal. The caller must already hold the write
 * transaction that inserts the candidate. The counter is never decreased.
 */
function reserveOrdinal(): number {
  const db = getDb();
  const row = db.prepare('SELECT counter FROM generation_counter WHERE id = 1').get() as
    { counter: number } | undefined;
  const next = (row?.counter ?? 0) + 1;
  const updated = db.prepare('UPDATE generation_counter SET counter = ? WHERE id = 1').run(next);
  if (updated.changes !== 1) {
    throw new Error('Generation counter is missing');
  }
  return next;
}

/**
 * Save an install candidate without replacing another credential.
 * The same password is deduplicated and keeps its original ordinal.
 * A repeat of the active password does not create a candidate and does not
 * change the active generation or revoke sessions.
 */
export function createCandidate(
  config: AppConfig,
  storeId: string,
  shop: string,
  password: string,
): CreateCandidateResult {
  const db = getDb();
  const encrypted = encrypt(password, config.appEncryptionKey, aadFor(shop, storeId, 'candidate'));
  const candidateId = randomId(16);
  const expiresAt = candidateExpiry();

  const tx = db.transaction((): CreateCandidateResult => {
    db.prepare(
      `DELETE FROM install_candidates WHERE CAST(expires_at AS INTEGER) <= unixepoch()`,
    ).run();

    const active = db
      .prepare('SELECT * FROM stores WHERE id = ? AND shop = ?')
      .get(storeId, shop) as StoreRow | undefined;
    if (active) {
      const activePassword = decrypt(
        { data: active.password },
        config.appEncryptionKey,
        aadFor(active.shop, active.id, 'store'),
      );
      if (passwordsEqual(activePassword, password)) return { status: 'already_active' };
    }

    const pending = db
      .prepare('SELECT * FROM install_candidates WHERE store_id = ? AND shop = ?')
      .all(storeId, shop) as CandidateRow[];
    for (const row of pending) {
      const existing = decrypt(
        { data: row.password },
        config.appEncryptionKey,
        aadFor(row.shop, row.store_id, 'candidate'),
      );
      if (passwordsEqual(existing, password)) return { status: 'duplicate', id: row.id };
    }

    const pendingCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM install_candidates WHERE shop = ?').get(shop) as {
        cnt: number;
      }
    ).cnt;
    if (pendingCount >= MAX_PENDING_PER_DOMAIN) throw new PendingQuotaError(shop);

    const ordinal = reserveOrdinal();
    candidateHooks.afterReserve?.();
    db.prepare(
      `
      INSERT INTO install_candidates (id, store_id, shop, password, ordinal, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    ).run(candidateId, storeId, shop, encrypted.data, ordinal, expiresAt);
    return { status: 'created', id: candidateId, ordinal };
  });

  return tx();
}

/**
 * Highest remaining ordinal for the shop. Timestamp is not the order.
 */
export function findCandidate(storeId: string, shop: string): CandidateRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT * FROM install_candidates
    WHERE store_id = ? AND shop = ? AND ${NOT_EXPIRED}
    ORDER BY ordinal DESC, rowid DESC
    LIMIT 1
  `,
    )
    .get(storeId, shop) as CandidateRow | undefined;
  return row ?? null;
}

/**
 * Promote a candidate that is still present and newer than the active
 * generation. The same password as the active store is an idempotent repeat.
 * An older candidate is left in place so a later retry keeps its ordinal and
 * cannot replace the newer connection.
 */
export function activateCandidate(config: AppConfig, candidateId: string): number | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const candidate = db
      .prepare(
        `
      SELECT * FROM install_candidates WHERE id = ? AND ${NOT_EXPIRED}
    `,
      )
      .get(candidateId) as CandidateRow | undefined;
    if (!candidate) return null;

    const password = decrypt(
      { data: candidate.password },
      config.appEncryptionKey,
      aadFor(candidate.shop, candidate.store_id, 'candidate'),
    );
    const shopOwner = db.prepare('SELECT id FROM stores WHERE shop = ?').get(candidate.shop) as
      { id: string } | undefined;
    if (shopOwner && shopOwner.id !== candidate.store_id) return null;

    const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(candidate.store_id) as
      StoreRow | undefined;
    if (existing) {
      const currentPassword = decrypt(
        { data: existing.password },
        config.appEncryptionKey,
        aadFor(existing.shop, existing.id, 'store'),
      );
      if (existing.shop === candidate.shop && passwordsEqual(currentPassword, password)) {
        db.prepare('DELETE FROM install_candidates WHERE id = ?').run(candidateId);
        return existing.generation;
      }
      if (candidate.ordinal <= existing.generation) return null;
    }

    const generation = candidate.ordinal;
    const encrypted = encrypt(
      password,
      config.appEncryptionKey,
      aadFor(candidate.shop, candidate.store_id, 'store'),
    );
    if (existing) {
      db.prepare(
        `
        UPDATE stores SET shop = ?, password = ?, title = '', generation = ?, updated_at = datetime('now')
        WHERE id = ? AND generation = ?
      `,
      ).run(candidate.shop, encrypted.data, generation, candidate.store_id, existing.generation);
      const replaced = db
        .prepare('SELECT generation FROM stores WHERE id = ?')
        .get(candidate.store_id) as { generation: number };
      if (replaced.generation !== generation) return null;
      db.prepare('DELETE FROM sessions WHERE store_id = ?').run(candidate.store_id);
      db.prepare('DELETE FROM login_challenges WHERE store_id = ?').run(candidate.store_id);
    } else {
      db.prepare(
        `
        INSERT INTO stores (id, shop, password, title, generation)
        VALUES (?, ?, ?, '', ?)
      `,
      ).run(candidate.store_id, candidate.shop, encrypted.data, generation);
    }

    db.prepare('DELETE FROM install_candidates WHERE id = ?').run(candidateId);
    return generation;
  });

  return tx() as number | null;
}

export function rejectCandidate(candidateId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM install_candidates WHERE id = ?').run(candidateId);
}

export function getStore(storeId: string): StoreRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) as StoreRow | undefined;
  return row ?? null;
}

export function getStoreByShop(shop: string): StoreRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM stores WHERE shop = ?').get(shop) as StoreRow | undefined;
  return row ?? null;
}

export function decryptStorePassword(config: AppConfig, store: StoreRow): string {
  return decrypt(
    { data: store.password },
    config.appEncryptionKey,
    aadFor(store.shop, store.id, 'store'),
  );
}

export function decryptCandidatePassword(config: AppConfig, candidate: CandidateRow): string {
  return decrypt(
    { data: candidate.password },
    config.appEncryptionKey,
    aadFor(candidate.shop, candidate.store_id, 'candidate'),
  );
}

/**
 * Cancel the active connection and pending candidates whose ready password
 * matches. Other generations of the same shop stay in place.
 */
export function uninstallStore(
  config: AppConfig,
  storeId: string,
  shop: string,
  providedPassword: string,
): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    const store = db
      .prepare('SELECT * FROM stores WHERE id = ? AND shop = ?')
      .get(storeId, shop) as StoreRow | undefined;
    const candidates = db
      .prepare('SELECT * FROM install_candidates WHERE store_id = ? AND shop = ?')
      .all(storeId, shop) as CandidateRow[];

    let removed = false;
    if (store) {
      const actualPassword = decrypt(
        { data: store.password },
        config.appEncryptionKey,
        aadFor(store.shop, store.id, 'store'),
      );
      if (passwordsEqual(actualPassword, providedPassword)) {
        db.prepare('DELETE FROM sessions WHERE store_id = ?').run(store.id);
        db.prepare('DELETE FROM login_challenges WHERE store_id = ?').run(store.id);
        db.prepare('DELETE FROM stores WHERE id = ?').run(store.id);
        removed = true;
      }
    }

    for (const candidate of candidates) {
      const actualPassword = decrypt(
        { data: candidate.password },
        config.appEncryptionKey,
        aadFor(candidate.shop, candidate.store_id, 'candidate'),
      );
      if (!passwordsEqual(actualPassword, providedPassword)) continue;
      db.prepare('DELETE FROM install_candidates WHERE id = ?').run(candidate.id);
      removed = true;
    }

    return removed;
  });

  return tx() as boolean;
}

/**
 * Update the title only when the store is still the generation that was activated.
 * Returns false when a newer installation already replaced that generation.
 */
export function updateStoreTitle(storeId: string, title: string, generation: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE stores SET title = ?, updated_at = datetime('now') WHERE id = ? AND generation = ?`,
    )
    .run(title, storeId, generation);
  return result.changes === 1;
}
