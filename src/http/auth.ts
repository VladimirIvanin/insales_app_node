import { FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '../storage/database.js';

export interface SessionContext {
  sessionId: string;
  storeId: string;
  userId: string;
  shop: string;
  generation: number;
}

/**
 * Extract session from request cookie and verify it's valid.
 * Returns session context or null if not authenticated.
 */
export function getSession(request: FastifyRequest): SessionContext | null {
  const sid = request.cookies['demo_session'];
  if (!sid) return null;

  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT s.id, s.store_id, s.user_id, s.generation, st.shop
      FROM sessions s
      JOIN stores st ON st.id = s.store_id
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `).get(sid) as { id: string; store_id: string; user_id: string; generation: number; shop: string } | undefined;

    if (!row) return null;

    return {
      sessionId: row.id,
      storeId: row.store_id,
      userId: row.user_id,
      shop: row.shop,
      generation: row.generation,
    };
  } catch {
    return null;
  }
}

/**
 * Require valid session for a route.
 * Returns 401 if no valid session.
 */
export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = getSession(request);
  if (!session) {
    reply.status(401).type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Требуется вход</title>'
      + '<body style="font:18px system-ui;margin:60px auto;max-width:720px;padding:24px">'
      + '<h1>Требуется вход</h1>'
      + '<p>Откройте приложение из раздела расширений InSales.</p></html>'
    );
    return;
  }
  (request as unknown as Record<string, unknown>).session = session;
}