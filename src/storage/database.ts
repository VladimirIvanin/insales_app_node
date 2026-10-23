import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { StorageError } from '../insales/errors.js';
import type { AppConfig } from '../config.js';
import { migrate } from './migrate.js';

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new StorageError('Database not initialized');
  return _db;
}

export function initDb(config: AppConfig): Database.Database {
  const dbPath = config.appDb;

  // If already initialized with the same path, return existing connection
  if (_db && _dbPath === dbPath) return _db;

  // Close existing connection if path changed (test isolation)
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }

  // Ensure runtime directory exists
  mkdirSync(config.appRuntimeDir, { recursive: true, mode: 0o700 });

  const dbDir = dirname(dbPath);
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });

  const db = new Database(dbPath, {
    /* verbose: console.log */
  });

  // Enable WAL mode for better read concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');
  db.pragma('foreign_keys = ON');

  _db = db;
  _dbPath = dbPath;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Run migrations and return the result.
 */
export function applyMigrations(config: AppConfig): void {
  const db = initDb(config);
  migrate(db, config.appRuntimeDir);
}

/**
 * Check database readiness — returns true if schema is accessible.
 */
export function isReady(): boolean {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}