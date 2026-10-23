import { getDb } from '../storage/database.js';
import { randomId } from '../storage/credentials.js';

interface BudgetRow {
  window_started: number;
  attempts: number;
  next_attempt_at: number;
  lease_until: number;
}

export function claimVerification(shop: string): string | null {
  const db = getDb();
  return db.transaction(() => {
    const now = Date.now() / 1000;
    db.prepare(
      'INSERT OR IGNORE INTO verification_budgets (shop, window_started) VALUES (?, ?)',
    ).run(shop, now);
    const row = db
      .prepare('SELECT * FROM verification_budgets WHERE shop = ?')
      .get(shop) as BudgetRow;
    if (row.next_attempt_at > now || row.lease_until > now) return null;
    const attempts = row.window_started > now - 60 ? row.attempts : 0;
    if (attempts >= 10) return null;
    const token = randomId(16);
    db.prepare(
      `UPDATE verification_budgets SET window_started = ?, attempts = ?, lease_until = ?, lease_token = ? WHERE shop = ?`,
    ).run(attempts ? row.window_started : now, attempts + 1, now + 15, token, shop);
    return token;
  })();
}

export function releaseVerification(shop: string, token: string, delaySeconds = 0): void {
  getDb()
    .prepare(
      `UPDATE verification_budgets SET lease_until = 0, lease_token = NULL, next_attempt_at = ? WHERE shop = ? AND lease_token = ?`,
    )
    .run(Date.now() / 1000 + delaySeconds, shop, token);
}

export function retryDelay(value?: string): number {
  if (!value) return 5;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(5, seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(5, (date - Date.now()) / 1000) : 5;
}
