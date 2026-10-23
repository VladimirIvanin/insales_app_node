import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb, closeDb, applyMigrations } from '../../src/storage/database.js';
import {
  createCandidate,
  findCandidate,
  activateCandidate,
  getStore,
  uninstallStore,
  decryptStorePassword,
  decryptCandidatePassword,
  PendingQuotaError,
} from '../../src/storage/installations.js';
import { createSession, getSession } from '../../src/storage/sessions.js';
import { handleInstall, handleUninstall } from '../../src/application/installation.js';
import { installPassword } from '../../src/insales/protocol.js';
import { syntheticConfig } from '../support/config.js';
import type { AppConfig } from '../../src/config.js';

describe('Lifecycle storage', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'insales-lifecycle-'));
  const config: AppConfig = syntheticConfig({
    appRuntimeDir: tmpDir,
    appDb: join(tmpDir, 'test.sqlite3'),
    allowedShops: ['shop.example', 'shop-a.example', 'shop-b.example'],
  });

  beforeAll(() => {
    initDb(config);
    applyMigrations(config);
  });

  afterAll(() => {
    closeDb();
  });

  function candidates(storeId: string, shop: string): number {
    return (
      getDb()
        .prepare('SELECT COUNT(*) AS cnt FROM install_candidates WHERE store_id = ? AND shop = ?')
        .get(storeId, shop) as { cnt: number }
    ).cnt;
  }

  it('runs install, activation, session and ready-password uninstall as one scenario', () => {
    handleInstall(config, 'shop.example', '42', 'install-token');
    const password = installPassword('install-token', config.insalesAppSecret);
    const candidate = findCandidate('42', 'shop.example');
    expect(candidate).not.toBeNull();
    expect(decryptCandidatePassword(config, candidate!)).toBe(password);

    const generation = activateCandidate(config, candidate!.id);
    expect(generation).toBeGreaterThan(0);
    const sessionId = createSession('42', '7', generation!);
    expect(decryptStorePassword(config, getStore('42')!)).toBe(password);

    handleUninstall(config, 'shop.example', '42', 'install-token');
    expect(getStore('42')).not.toBeNull();
    expect(getSession(sessionId)).not.toBeNull();

    handleUninstall(config, 'shop.example', '42', password);
    expect(getStore('42')).toBeNull();
    expect(getSession(sessionId)).toBeNull();

    handleInstall(config, 'shop.example', '42', 'second-token');
    const again = findCandidate('42', 'shop.example');
    const nextGeneration = activateCandidate(config, again!.id);
    expect(nextGeneration).toBeGreaterThan(generation!);
    expect(decryptStorePassword(config, getStore('42')!)).toBe(
      installPassword('second-token', config.insalesAppSecret),
    );
    expect(getSession(sessionId)).toBeNull();
  });

  it('keeps independent pending credentials and deduplicates the same one', () => {
    const shop = 'pending.example';
    const first = createCandidate(config, '51', shop, 'password-a');
    const second = createCandidate(config, '51', shop, 'password-b');
    const repeat = createCandidate(config, '51', shop, 'password-a');
    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    expect(repeat).toEqual({ status: 'duplicate', id: first.status === 'created' ? first.id : '' });
    expect(candidates('51', shop)).toBe(2);
    expect(findCandidate('51', shop)?.id).toBe(second.status === 'created' ? second.id : '');
  });

  it('does not extend the TTL of a duplicate pending credential', () => {
    const created = createCandidate(config, '52', 'ttl.example', 'password-a');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const shortened = String(Math.floor(Date.now() / 1000) + 30);
    getDb()
      .prepare('UPDATE install_candidates SET expires_at = ? WHERE id = ?')
      .run(shortened, created.id);
    const again = createCandidate(config, '52', 'ttl.example', 'password-a');
    expect(again).toEqual({ status: 'duplicate', id: created.id });
    const row = getDb()
      .prepare('SELECT expires_at FROM install_candidates WHERE id = ?')
      .get(created.id) as { expires_at: string };
    expect(row.expires_at).toBe(shortened);
  });

  it('rejects a sixth pending credential without deleting the earlier ones', () => {
    const shop = 'quota.example';
    for (let index = 0; index < 5; index += 1) {
      expect(createCandidate(config, String(600 + index), shop, `password-${index}`).status).toBe(
        'created',
      );
    }
    expect(() => createCandidate(config, '699', shop, 'password-new')).toThrow(PendingQuotaError);
    expect(candidates('600', shop)).toBe(1);
  });

  it('treats a repeat of the active credential as idempotent', () => {
    const created = createCandidate(config, '70', 'active.example', 'password-a');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const generation = activateCandidate(config, created.id);
    const sessionId = createSession('70', '1', generation!);
    expect(createCandidate(config, '70', 'active.example', 'password-a')).toEqual({
      status: 'already_active',
    });
    expect(getStore('70')?.generation).toBe(generation);
    expect(getSession(sessionId)).not.toBeNull();
    expect(findCandidate('70', 'active.example')).toBeNull();

    const replacement = createCandidate(config, '70', 'active.example', 'password-b');
    expect(replacement.status).toBe('created');
    if (replacement.status !== 'created') return;
    const nextGeneration = activateCandidate(config, replacement.id);
    expect(nextGeneration).not.toBe(generation);
    expect(getSession(sessionId)).toBeNull();
    expect(decryptStorePassword(config, getStore('70')!)).toBe('password-b');
  });

  it('rejects an expired timestamp on the same date, including an ISO value the old string comparison would keep', () => {
    const clock = getDb()
      .prepare(`SELECT datetime('now', '-1 minute') AS past, datetime('now') AS now`)
      .get() as { past: string; now: string };
    const iso = `${clock.past.replace(' ', 'T')}.000Z`;
    getDb()
      .prepare(
        `
      INSERT INTO install_candidates (id, store_id, shop, password, ordinal, expires_at)
      VALUES ('iso-expired', '80', 'expiry.example', 'blob', 1, ?)
    `,
      )
      .run(iso);
    const legacy = getDb()
      .prepare(
        `SELECT COUNT(*) AS cnt FROM install_candidates WHERE id = 'iso-expired' AND expires_at > datetime('now')`,
      )
      .get() as { cnt: number };
    if (clock.past.slice(0, 10) === clock.now.slice(0, 10)) expect(legacy.cnt).toBe(1);
    expect(findCandidate('80', 'expiry.example')).toBeNull();

    const now = Math.floor(Date.now() / 1000);
    getDb()
      .prepare(
        `
      INSERT INTO install_candidates (id, store_id, shop, password, ordinal, expires_at)
      VALUES ('epoch-expired', '81', 'expiry.example', 'blob', 1, ?)
    `,
      )
      .run(String(now - 60));
    getDb()
      .prepare(
        `
      INSERT INTO install_candidates (id, store_id, shop, password, ordinal, expires_at)
      VALUES ('epoch-open', '81', 'expiry.example', 'blob', 2, ?)
    `,
      )
      .run(String(now + 120));
    expect(findCandidate('81', 'expiry.example')?.id).toBe('epoch-open');
  });

  it('uninstalls only the credential that matches', () => {
    const shop = 'matrix.example';
    const pending = createCandidate(config, '90', shop, 'only-pending');
    expect(pending.status).toBe('created');
    expect(uninstallStore(config, '90', shop, 'wrong')).toBe(false);
    expect(candidates('90', shop)).toBe(1);
    expect(uninstallStore(config, '90', shop, 'only-pending')).toBe(true);
    expect(candidates('90', shop)).toBe(0);

    const active = createCandidate(config, '91', shop, 'active-password');
    expect(active.status).toBe('created');
    if (active.status !== 'created') return;
    const generation = activateCandidate(config, active.id)!;
    const sessionId = createSession('91', '4', generation);
    const other = createCandidate(config, '91', shop, 'pending-password');
    expect(other.status).toBe('created');

    expect(uninstallStore(config, '91', shop, 'pending-password')).toBe(true);
    expect(getStore('91')).not.toBeNull();
    expect(getSession(sessionId)).not.toBeNull();
    expect(candidates('91', shop)).toBe(0);

    const kept = createCandidate(config, '91', shop, 'kept-password');
    expect(kept.status).toBe('created');
    expect(uninstallStore(config, '91', shop, 'active-password')).toBe(true);
    expect(getStore('91')).toBeNull();
    expect(getSession(sessionId)).toBeNull();
    expect(findCandidate('91', shop)?.id).toBe(kept.status === 'created' ? kept.id : '');

    const oldPassword = 'old-password';
    const replaced = createCandidate(config, '92', shop, oldPassword);
    expect(replaced.status).toBe('created');
    if (replaced.status !== 'created') return;
    activateCandidate(config, replaced.id);
    uninstallStore(config, '92', shop, oldPassword);
    const current = createCandidate(config, '92', shop, 'current-password');
    expect(current.status).toBe('created');
    if (current.status !== 'created') return;
    activateCandidate(config, current.id);
    expect(uninstallStore(config, '92', shop, oldPassword)).toBe(false);
    expect(decryptStorePassword(config, getStore('92')!)).toBe('current-password');
  });

  it('cancels every pending row with the same password and leaves another shop', () => {
    const shop = 'copies.example';
    const created = createCandidate(config, '93', shop, 'shared-password');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    const row = getDb()
      .prepare('SELECT password, expires_at FROM install_candidates WHERE id = ?')
      .get(created.id) as { password: string; expires_at: string };
    getDb()
      .prepare(
        `
      INSERT INTO install_candidates (id, store_id, shop, password, ordinal, expires_at)
      VALUES ('copy-93', '93', ?, ?, 80, ?)
    `,
      )
      .run(shop, row.password, row.expires_at);
    expect(uninstallStore(config, '93', shop, 'shared-password')).toBe(true);
    expect(candidates('93', shop)).toBe(0);

    const shopA = createCandidate(config, '94', 'shop-a.example', 'password-a');
    const shopB = createCandidate(config, '95', 'shop-b.example', 'password-b');
    expect(shopA.status).toBe('created');
    expect(shopB.status).toBe('created');
    if (shopA.status !== 'created' || shopB.status !== 'created') return;
    const generationA = activateCandidate(config, shopA.id)!;
    const generationB = activateCandidate(config, shopB.id)!;
    const sessionB = createSession('95', '8', generationB);
    expect(uninstallStore(config, '94', 'shop-a.example', 'password-a')).toBe(true);
    expect(getStore('94')).toBeNull();
    expect(getStore('95')?.generation).toBe(generationB);
    expect(getSession(sessionB)?.store_id).toBe('95');
    expect(generationA).toBeGreaterThan(0);
  });
});
