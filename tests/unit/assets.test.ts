import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateAssets } from '../../src/app.js';
import { locateMigrations } from '../../src/storage/migrate.js';

describe('asset locations', () => {
  it('prefers templates next to the compiled module over the source tree and cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'insales-assets-'));
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'templates'), { recursive: true });
    mkdirSync(join(root, 'templates'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(dist, 'templates', '401.ejs'), 'dist');
    writeFileSync(join(root, 'templates', '401.ejs'), 'source');
    const elsewhere = mkdtempSync(join(tmpdir(), 'insales-assets-cwd-'));
    mkdirSync(join(elsewhere, 'templates'), { recursive: true });
    writeFileSync(join(elsewhere, 'templates', '401.ejs'), 'cwd');
    const previous = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(locateAssets(dist).templatesDir).toBe(join(dist, 'templates'));
      expect(locateAssets(join(root, 'src')).templatesDir).toBe(join(root, 'templates'));
    } finally {
      process.chdir(previous);
    }
  });

  it('prefers migrations next to the compiled storage module', () => {
    const root = mkdtempSync(join(tmpdir(), 'insales-migrations-'));
    mkdirSync(join(root, 'dist', 'storage'), { recursive: true });
    mkdirSync(join(root, 'dist', 'migrations'), { recursive: true });
    mkdirSync(join(root, 'migrations'), { recursive: true });
    mkdirSync(join(root, 'src', 'storage'), { recursive: true });
    writeFileSync(join(root, 'dist', 'migrations', '001_initial.sql'), '-- dist');
    writeFileSync(join(root, 'migrations', '001_initial.sql'), '-- source');
    expect(locateMigrations(join(root, 'dist', 'storage'))).toBe(join(root, 'dist', 'migrations'));
    expect(locateMigrations(join(root, 'src', 'storage'))).toBe(join(root, 'migrations'));
  });
});
