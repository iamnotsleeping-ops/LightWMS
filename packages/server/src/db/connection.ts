import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/index';

export type Db = InstanceType<typeof Database>;

let instance: Db | null = null;

/** 全局单例连接。所有写操作必须经由 db.transaction 包裹 */
export function getDb(): Db {
  if (instance) return instance;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  instance = db;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** 测试缝：注入独立数据库实例，避免用例污染开发库 */
export function useDatabase(db: Db): void {
  instance = db;
}