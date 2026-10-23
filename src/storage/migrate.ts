import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface MigrationRow {
  version: number;
}

function moduleDir(): string {
  return typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));
}

/**
 * dist/storage uses dist/migrations. src/storage uses the repository migrations.
 * The compiled layout is checked first so a checkout next to dist does not hide it.
 */
export function locateMigrations(fromDir: string): string {
  const candidates = [
    resolve(fromDir, '..', 'migrations'),
    resolve(fromDir, '..', '..', 'migrations'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot find migrations near ${fromDir}`);
}

function findMigrationsDir(): string {
  return locateMigrations(moduleDir());
}

/**
 * Run all pending SQL migrations from the migrations directory.
 * Migrations are applied in version order within a transaction.
 */
export function migrate(db: Database.Database, _runtimeDir: string): void {
  const migrationsDir = findMigrationsDir();

  // Ensure schema_migrations table exists
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER NOT NULL PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as MigrationRow[]).map(r => r.version),
  );

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applyTx = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  });

  for (const file of files) {
    const versionMatch = file.match(/^(\d+)/);
    if (!versionMatch) continue;
    const version = parseInt(versionMatch[1], 10);
    if (applied.has(version)) continue;

    const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
    applyTx(version, sql);
    console.log(`Migration ${file} applied`);
  }
}

/**
 * Show migration status.
 */
export function migrationStatus(db: Database.Database): { version: number; appliedAt: string }[] {
  return db.prepare('SELECT version, applied_at as appliedAt FROM schema_migrations ORDER BY version').all() as {
    version: number;
    appliedAt: string;
  }[];
}