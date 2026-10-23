import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, applyMigrations, getDb } from '../../src/storage/database.js';
import { migrate } from '../../src/storage/migrate.js';
import { createCandidate, getStore } from '../../src/storage/installations.js';
import { getSession } from '../../src/storage/sessions.js';
import { encrypt } from '../../src/storage/credentials.js';
import { syntheticConfig, TEST_KEY_HEX } from '../support/config.js';

describe('candidate ordinal migration', () => {
  const dirs: string[] = [];

  afterEach(() => {
    closeDb();
  });

  it('applies all migrations on an empty database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-migrate-fresh-'));
    dirs.push(dir);
    const config = syntheticConfig({ appRuntimeDir: dir, appDb: join(dir, 'app.sqlite3') });
    initDb(config);
    applyMigrations(config);
    const versions = getDb()
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[];
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    const created = createCandidate(config, '1', 'shop.example', 'password');
    expect(created.status).toBe('created');
    if (created.status === 'created') expect(created.ordinal).toBeGreaterThan(0);
  });

  it('cancels ambiguous pending rows and keeps the active store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insales-migrate-old-'));
    const dbPath = join(dir, 'legacy.sqlite3');
    const db = new Database(dbPath);
    db.exec(readFileSync(join(process.cwd(), 'migrations/001_initial.sql'), 'utf8'));
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
    db.prepare(`UPDATE generation_counter SET counter = 3 WHERE id = 1`).run();
    const password = encrypt(
      'old-password',
      Buffer.from(TEST_KEY_HEX, 'hex'),
      'shop.example:5:store',
    ).data;
    db.prepare(
      `
      INSERT INTO stores (id, shop, password, title, generation)
      VALUES ('5', 'shop.example', ?, 'Kept', 3)
    `,
    ).run(password);
    db.prepare(
      `
      INSERT INTO sessions (id, store_id, user_id, generation, expires_at)
      VALUES ('session-old', '5', '7', 3, datetime('now', '+1 hour'))
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO install_candidates (id, store_id, shop, password, generation, expires_at)
      VALUES ('pending-a', '5', 'shop.example', 'cipher-a', 0, '4102444800')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO install_candidates (id, store_id, shop, password, generation, expires_at)
      VALUES ('pending-b', '8', 'other.example', 'cipher-b', 0, '4102444800')
    `,
    ).run();
    db.close();

    const config = syntheticConfig({
      appRuntimeDir: dir,
      appDb: dbPath,
      allowedShops: ['shop.example', 'other.example'],
    });
    initDb(config);
    migrate(getDb(), dir);
    expect(getStore('5')?.title).toBe('Kept');
    expect(getStore('5')?.generation).toBe(3);
    expect(getSession('session-old')?.generation).toBe(3);
    const pending = getDb().prepare('SELECT COUNT(*) AS cnt FROM install_candidates').get() as {
      cnt: number;
    };
    expect(pending.cnt).toBe(0);
    const counter = getDb()
      .prepare('SELECT counter FROM generation_counter WHERE id = 1')
      .get() as { counter: number };
    expect(counter.counter).toBeGreaterThanOrEqual(3);

    const created = createCandidate(config, '5', 'shop.example', 'password-new');
    expect(created.status).toBe('created');
    if (created.status === 'created') expect(created.ordinal).toBeGreaterThan(3);
    expect(getStore('5')?.generation).toBe(3);
    expect(getSession('session-old')).not.toBeNull();
  });
});
