import Database from 'better-sqlite3';
import { useDatabase, type Db } from '../db/connection';
import { runMigrations } from '../db/migrate';

/** 建一个独立的 :memory: 库并跑完迁移，供用例使用 */
export function createTestDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  useDatabase(db);
  runMigrations();
  return db;
}

export interface Fixtures {
  itemId: number;
  portItemId: number;
  warehouseId: number;
  portWarehouseId: number;
  supplierId: number;
  customerId: number;
}

export function seedFixtures(db: Db): Fixtures {
  const now = new Date().toISOString();
  const item = db
    .prepare(
      `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 0, ?, ?)`,
    )
    .run('RM-001', '测试零件', '件', now, now);
  const portItem = db
    .prepare(
      `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 0, ?, ?)`,
    )
    .run('FG-001', '测试成品', '件', now, now);
  const warehouse = db
    .prepare(
      `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, 'warehouse', 1, ?, ?)`,
    )
    .run('WH-01', '一号仓', now, now);
  const portWarehouse = db
    .prepare(
      `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, 'port', 1, ?, ?)`,
    )
    .run('PORT-01', '港口仓', now, now);
  const supplier = db
    .prepare(
      `INSERT INTO partner (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, 'supplier', 1, ?, ?)`,
    )
    .run('SU-01', '测试供应商', now, now);
  const customer = db
    .prepare(
      `INSERT INTO partner (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, 'customer', 1, ?, ?)`,
    )
    .run('CU-01', '测试客户', now, now);

  return {
    itemId: Number(item.lastInsertRowid),
    portItemId: Number(portItem.lastInsertRowid),
    warehouseId: Number(warehouse.lastInsertRowid),
    portWarehouseId: Number(portWarehouse.lastInsertRowid),
    supplierId: Number(supplier.lastInsertRowid),
    customerId: Number(customer.lastInsertRowid),
  };
}