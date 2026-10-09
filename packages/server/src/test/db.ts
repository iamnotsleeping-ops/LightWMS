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
    .run('RM-001', '测试零件', 'EA', now, now);
  const portItem = db
    .prepare(
      `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
       VALUES (?, ?, ?, 1, 0, 0, ?, ?)`,
    )
    .run('FG-001', '测试成品', 'EA', now, now);
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

/**
 * 给已存在的用户追加一个持有指定权限码的角色。
 * 用于「必须以某个特定用户身份发请求」的用例（例如校验操作者自身身份的护栏）。
 */
export function grantPermissions(db: Db, userId: number, permissionCodes: string[]): void {
  if (permissionCodes.length === 0) return;
  const now = new Date().toISOString();
  const roleId = Number(
    db
      .prepare('INSERT INTO sys_role (code, name, description) VALUES (?, ?, ?)')
      .run(`test_role_${userId}_${now}`, `测试角色 ${userId}`, '测试用角色').lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO sys_role_permission (role_id, permission_id)
     SELECT ?, id FROM sys_permission WHERE code = ?`,
  );
  for (const code of permissionCodes) insert.run(roleId, code);
  db.prepare('INSERT OR IGNORE INTO sys_user_role (user_id, role_id) VALUES (?, ?)').run(
    userId,
    roleId,
  );
}

/**
 * 建一个「启用 + 持有指定权限码」的真实用户，返回 `sys_user.id`。
 *
 * 授权以数据库为准（见 plugins/auth.ts 的 loadAuthState），因此 HTTP 层用例不能再用
 * `jwt.sign({ sub: 1, permissions: [...] })` 伪造身份，必须落一条真实用户 + 角色 +
 * 权限关联。传空数组即得到「已登录但无任何业务权限」的用户。
 */
export function createAuthorizedUser(db: Db, permissionCodes: string[]): number {
  const now = new Date().toISOString();
  const userId = Number(
    db
      .prepare(
        'INSERT INTO sys_user (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)',
      )
      .run(`测试用户-${permissionCodes.length}-${now}`, now, now).lastInsertRowid,
  );

  grantPermissions(db, userId, permissionCodes);
  return userId;
}