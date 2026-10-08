import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './connection';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * 顺序执行 src/migrations/*.sql，已应用版本记录在 schema_migration。
 * 每个文件在独立事务内执行，失败则整体回滚，不会留下半截结构。
 */
export function runMigrations(): MigrationResult {
  const db = getDb();
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migration (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const appliedVersions = new Set(
    (db.prepare('SELECT version FROM schema_migration').all() as { version: string }[]).map(
      (row) => row.version,
    ),
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedVersions.has(version)) {
      skipped.push(version);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
    });
    apply();
    applied.push(version);
  }

  return { applied, skipped };
}