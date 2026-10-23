import { getDb } from './database.js';
import { randomId } from './credentials.js';

export interface ChallengeRow {
  id: string;
  store_id: string;
  nonce: string;
  generation: number;
  browser_binding: string;
  expires_at: string;
}

export interface SessionRow {
  id: string;
  store_id: string;
  user_id: string;
  generation: number;
  expires_at: string;
}

/**
 * Create a new login challenge for a store.
 * Returns the challenge ID (used as session cookie) and nonce.
 */
export function createChallenge(
  storeId: string,
  generation: number,
  browserBinding: string,
): { challengeId: string; nonce: string } {
  const db = getDb();
  const challengeId = randomId(16);
  const nonce = randomId(32);

  db.prepare(`
    INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+5 minutes'))
  `).run(challengeId, storeId, nonce, generation, browserBinding);

  return { challengeId, nonce };
}

/**
 * Consume a challenge — verify and delete atomically.
 * Returns the challenge data if valid, or null if consumed/expired.
 */
export function consumeChallenge(
  challengeId: string,
  browserBinding: string,
  currentGeneration: number,
): ChallengeRow | null {
  const db = getDb();

  const tx = db.transaction(() => {
    const challenge = db.prepare(`
      SELECT * FROM login_challenges
      WHERE id = ? AND expires_at > datetime('now')
    `).get(challengeId) as ChallengeRow | undefined;

    if (!challenge) return null;

    // Verify browser binding
    if (challenge.browser_binding !== browserBinding) return null;

    // Verify generation — challenge must match current store generation
    if (challenge.generation !== currentGeneration) return null;

    // Delete challenge (consume it)
    db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challengeId);

    return challenge;
  });

  return tx() as ChallengeRow | null;
}

/**
 * Create a new session for a store.
 */
export function createSession(
  storeId: string,
  userId: string,
  generation: number,
): string {
  const db = getDb();
  const sessionId = randomId(32);

  db.prepare(`
    INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))
  `).run(sessionId, storeId, userId, generation);

  return sessionId;
}

/**
 * Get a valid session by ID.
 */
export function getSession(sessionId: string): SessionRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')
  `).get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

/**
 * Delete a session (logout).
 */
export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

/**
 * Clean up expired challenges and sessions.
 */
export function cleanupExpired(): { challenges: number; sessions: number } {
  const db = getDb();
  const expiredChallenges = db.prepare('DELETE FROM login_challenges WHERE expires_at <= datetime(\'now\')').run();
  const expiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= datetime(\'now\')').run();
  return {
    challenges: expiredChallenges.changes,
    sessions: expiredSessions.changes,
  };
}