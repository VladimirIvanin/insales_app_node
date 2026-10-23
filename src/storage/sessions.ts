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

export interface OpenedSession {
  sessionId: string;
  storeId: string;
  generation: number;
}

/**
 * Create a new login challenge for a store.
 * Returns the challenge ID and nonce. The browser binding is stored, not the session.
 */
export function createChallenge(
  storeId: string,
  generation: number,
  browserBinding: string,
): { challengeId: string; nonce: string } {
  const db = getDb();
  const challengeId = randomId(16);
  const nonce = randomId(32);

  db.prepare(
    `
    INSERT INTO login_challenges (id, store_id, nonce, generation, browser_binding, expires_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+5 minutes'))
  `,
  ).run(challengeId, storeId, nonce, generation, browserBinding);

  return { challengeId, nonce };
}

export function findChallengeByBinding(browserBinding: string): ChallengeRow | null {
  const db = getDb();
  const challenge = db
    .prepare(
      `
    SELECT * FROM login_challenges
    WHERE browser_binding = ? AND expires_at > datetime('now')
  `,
    )
    .get(browserBinding) as ChallengeRow | undefined;
  return challenge ?? null;
}

/**
 * Consume one live challenge and insert its session in the same write transaction.
 * The active generation is read again inside the lock. A replaced or removed
 * connection does not receive a session. A second caller finds no challenge.
 */
export function consumeChallengeAndCreateSession(
  challengeId: string,
  browserBinding: string,
  userId: string,
): OpenedSession | null {
  const db = getDb();

  const tx = db.transaction(() => {
    const challenge = db
      .prepare(
        `
      SELECT * FROM login_challenges
      WHERE id = ? AND expires_at > datetime('now')
    `,
      )
      .get(challengeId) as ChallengeRow | undefined;

    if (!challenge || challenge.browser_binding !== browserBinding) return null;

    const store = db
      .prepare('SELECT generation FROM stores WHERE id = ?')
      .get(challenge.store_id) as { generation: number } | undefined;
    db.prepare('DELETE FROM login_challenges WHERE id = ?').run(challengeId);
    if (!store || store.generation !== challenge.generation) return null;

    const sessionId = randomId(32);
    db.prepare(
      `
      INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))
    `,
    ).run(sessionId, challenge.store_id, userId, challenge.generation);

    return { sessionId, storeId: challenge.store_id, generation: challenge.generation };
  });

  return tx() as OpenedSession | null;
}

export function createSession(storeId: string, userId: string, generation: number): string {
  const db = getDb();
  const sessionId = randomId(32);
  db.prepare(
    `
    INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
    VALUES (?, ?, ?, ?, datetime('now', '+1 hour'))
  `,
  ).run(sessionId, storeId, userId, generation);
  return sessionId;
}

export function getSession(sessionId: string): SessionRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `
    SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')
  `,
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

export function deleteSession(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function cleanupExpired(): { challenges: number; sessions: number } {
  const db = getDb();
  const expiredChallenges = db
    .prepare("DELETE FROM login_challenges WHERE expires_at <= datetime('now')")
    .run();
  const expiredSessions = db
    .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run();
  return {
    challenges: expiredChallenges.changes,
    sessions: expiredSessions.changes,
  };
}
