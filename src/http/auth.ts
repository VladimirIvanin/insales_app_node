import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { createClient, type InsalesClient } from '../insales/client.js';
import { computeToken3, constantTimeEqual, isValidHexSignature } from '../insales/protocol.js';
import { StorageError } from '../insales/errors.js';
import { decryptStorePassword, getStore } from '../storage/installations.js';
import { getDb } from '../storage/database.js';
import { consumeChallengeAndCreateSession, findChallengeByBinding } from '../storage/sessions.js';
import { lifecycleHooks } from '../application/hooks.js';

const inspectCustom = Symbol.for('nodejs.util.inspect.custom');

/**
 * Session, store and credential read together. `password` is omitted from JSON and inspect.
 */
export class AuthorizedContext {
  readonly sessionId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly shop: string;
  readonly generation: number;
  readonly title: string;
  readonly password: string;

  constructor(fields: {
    sessionId: string;
    storeId: string;
    userId: string;
    shop: string;
    generation: number;
    title: string;
    password: string;
  }) {
    this.sessionId = fields.sessionId;
    this.storeId = fields.storeId;
    this.userId = fields.userId;
    this.shop = fields.shop;
    this.generation = fields.generation;
    this.title = fields.title;
    this.password = fields.password;
  }

  toJSON(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      storeId: this.storeId,
      userId: this.userId,
      shop: this.shop,
      generation: this.generation,
      title: this.title,
    };
  }

  [inspectCustom](): Record<string, unknown> {
    return this.toJSON();
  }
}

interface SessionJoinRow {
  id: string;
  store_id: string;
  user_id: string;
  generation: number;
  shop: string;
  title: string;
  password: string;
}

/**
 * One read of the live session and the active store of the same generation.
 * The password is the one stored on that row, not a later re-read by store id.
 */
export function authorize(config: AppConfig, request: FastifyRequest): AuthorizedContext | null {
  const sid = request.cookies['demo_session'];
  if (!sid) return null;

  try {
    const row = getDb()
      .prepare(
        `
      SELECT s.id, s.store_id, s.user_id, s.generation, st.shop, st.title, st.password
      FROM sessions s
      JOIN stores st ON st.id = s.store_id AND st.generation = s.generation
      WHERE s.id = ? AND s.expires_at > datetime('now')
    `,
      )
      .get(sid) as SessionJoinRow | undefined;
    if (!row) return null;

    const password = decryptStorePassword(config, {
      id: row.store_id,
      shop: row.shop,
      password: row.password,
      title: row.title,
      generation: row.generation,
      created_at: '',
      updated_at: '',
    });
    return new AuthorizedContext({
      sessionId: row.id,
      storeId: row.store_id,
      userId: row.user_id,
      shop: row.shop,
      generation: row.generation,
      title: row.title,
      password,
    });
  } catch {
    return null;
  }
}

export function clientForContext(config: AppConfig, auth: AuthorizedContext): InsalesClient {
  return createClient({
    appId: config.insalesAppId,
    shop: auth.shop,
    password: auth.password,
    allowHttp: config.localDemo,
    timeout: 5_000,
  });
}

export interface Token3Input {
  signature: string;
  userEmail: string;
  userName: string;
  userId: string;
  emailConfirmed: string;
  browserBinding: string;
}

/**
 * Check token3, then consume the challenge and insert the session atomically.
 * The hook runs after the signature check and before that transaction.
 */
export async function completeAutologin(
  config: AppConfig,
  input: Token3Input,
): Promise<{ ok: true; sessionId: string; storeId: string } | { ok: false }> {
  const challenge = findChallengeByBinding(input.browserBinding);
  if (!challenge) return { ok: false };

  const store = getStore(challenge.store_id);
  if (!store || store.generation !== challenge.generation) return { ok: false };

  let password: string;
  try {
    password = decryptStorePassword(config, store);
  } catch (err: unknown) {
    if (err instanceof StorageError) return { ok: false };
    throw err;
  }

  const expected = computeToken3(
    challenge.nonce,
    input.userEmail,
    input.userName,
    input.userId,
    input.emailConfirmed,
    password,
  );
  if (!isValidHexSignature(input.signature) || !constantTimeEqual(expected, input.signature)) {
    return { ok: false };
  }

  if (lifecycleHooks.afterSignatureVerified) await lifecycleHooks.afterSignatureVerified();

  const opened = consumeChallengeAndCreateSession(challenge.id, input.browserBinding, input.userId);
  if (!opened) return { ok: false };
  return { ok: true, sessionId: opened.sessionId, storeId: opened.storeId };
}

export function sessionCookie(value: string, secure: boolean, maxAge: number): string {
  const base = `demo_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  return secure ? `${base}; Secure` : base;
}
