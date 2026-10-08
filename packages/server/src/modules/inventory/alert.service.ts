import {
  type AlertQuery,
  type AlertRuleBody,
  type AlertRuleQuery,
  type AlertRuleUpdateBody,
  type AlertType,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet } from '../../lib/sqlite';

// ---------- 行结构 ----------

export interface AlertRuleRow {
  id: number;
  item_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  min_qty: number;
  max_qty: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface AlertRow {
  rule_id: number;
  item_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  current_qty: number;
  min_qty: number;
  max_qty: number | null;
  alert_type: AlertType;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

// ---------- 内部工具 ----------

const RULE_SELECT = `
  SELECT r.id, r.item_id, p.code AS product_code, p.name AS product_name,
         p.base_unit, p.qty_precision,
         r.warehouse_id, w.name AS warehouse_name,
         r.min_qty, r.max_qty, r.is_active, r.created_at, r.updated_at
  FROM stock_alert_rule r
  JOIN item p ON p.id = r.item_id
  LEFT JOIN warehouse w ON w.id = r.warehouse_id`;

function toBoolInt(value: boolean | 0 | 1 | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 1 ? 1 : 0;
}

/** 唯一性：SQLite 的 UNIQUE 不约束 NULL，全局规则（warehouse_id 为空）需在此显式「先查后写」 */
function assertUnique(
  db: Db,
  itemId: number,
  warehouseId: number | null,
  excludeId?: number,
): void {
  const exclude = excludeId ?? -1;
  const row =
    warehouseId === null
      ? db
          .prepare(
            'SELECT id FROM stock_alert_rule WHERE item_id = ? AND warehouse_id IS NULL AND id <> ?',
          )
          .get(itemId, exclude)
      : db
          .prepare(
            'SELECT id FROM stock_alert_rule WHERE item_id = ? AND warehouse_id = ? AND id <> ?',
          )
          .get(itemId, warehouseId, exclude);
  if (row) throw new ApiError(409, '该物料在此范围的预警规则已存在');
}

function loadRule(db: Db, id: number): AlertRuleRow {
  const row = db
    .prepare(`${RULE_SELECT} WHERE r.id = ?`)
    .get(id) as AlertRuleRow | undefined;
  if (!row) throw new ApiError(404, '预警规则不存在');
  return row;
}

// ---------- 规则维护 ----------

export function listAlertRules(query: AlertRuleQuery): Paged<AlertRuleRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(p.code LIKE ? OR p.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.warehouseId) {
    where.push('r.warehouse_id = ?');
    params.push(query.warehouseId);
  }
  if (query.onlyActive !== undefined) {
    where.push('r.is_active = ?');
    params.push(query.onlyActive);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM stock_alert_rule r JOIN item p ON p.id = r.item_id ${clause}`,
    )
    .get(...params) as { total: number };

  const list = db
    .prepare(`${RULE_SELECT} ${clause} ORDER BY p.code, r.warehouse_id LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as AlertRuleRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export function createAlertRule(body: AlertRuleBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const warehouseId = body.warehouse_id ?? null;
    const minQty = body.min_qty;
    const maxQty = body.max_qty ?? null;
    if (maxQty !== null && maxQty < minQty) throw new ApiError(400, '上限不能小于下限');

    assertUnique(db, body.item_id, warehouseId);

    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO stock_alert_rule
           (item_id, warehouse_id, min_qty, max_qty, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.item_id,
        warehouseId,
        minQty,
        maxQty,
        toBoolInt(body.is_active) ?? 1,
        now,
        now,
      );
    return { id: Number(info.lastInsertRowid) };
  })();
}

export function updateAlertRule(id: number, body: AlertRuleUpdateBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = loadRule(db, id);

    const itemId = body.item_id ?? existing.item_id;
    const warehouseId =
      body.warehouse_id === undefined ? existing.warehouse_id : (body.warehouse_id ?? null);
    const minQty = body.min_qty ?? existing.min_qty;
    const maxQty = body.max_qty === undefined ? existing.max_qty : (body.max_qty ?? null);
    if (maxQty !== null && maxQty < minQty) throw new ApiError(400, '上限不能小于下限');

    if (itemId !== existing.item_id || warehouseId !== existing.warehouse_id) {
      assertUnique(db, itemId, warehouseId, id);
    }

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['item_id', body.item_id],
      ['warehouse_id', body.warehouse_id === undefined ? undefined : warehouseId],
      ['min_qty', body.min_qty],
      ['max_qty', body.max_qty === undefined ? undefined : maxQty],
      ['is_active', toBoolInt(body.is_active)],
    ]);

    if (clause !== '') {
      db.prepare(`UPDATE stock_alert_rule SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE stock_alert_rule SET updated_at = ? WHERE id = ?').run(now, id);
    }
    return { id };
  })();
}

export function deleteAlertRule(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    loadRule(db, id);
    db.prepare('DELETE FROM stock_alert_rule WHERE id = ?').run(id);
    return { id };
  })();
}

// ---------- 当前预警清单 ----------

/** 该物料在指定仓库或全部仓库的 on_hand（available 桶数量） */
function readOnHand(db: Db, productId: number, warehouseId: number | null): number {
  const row =
    warehouseId === null
      ? (db
          .prepare(
            "SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_balance WHERE product_id = ? AND stock_status = 'available'",
          )
          .get(productId) as { qty: number })
      : (db
          .prepare(
            "SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_balance WHERE product_id = ? AND warehouse_id = ? AND stock_status = 'available'",
          )
          .get(productId, warehouseId) as { qty: number });
  return row.qty;
}

export function queryAlerts(query: AlertQuery): AlertRow[] {
  const db = getDb();
  const where: string[] = ['r.is_active = 1'];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(p.code LIKE ? OR p.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.warehouseId) {
    where.push('(r.warehouse_id IS NULL OR r.warehouse_id = ?)');
    params.push(query.warehouseId);
  }

  const rules = db
    .prepare(`${RULE_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.code, r.warehouse_id`)
    .all(...params) as AlertRuleRow[];

  const alerts: AlertRow[] = [];
  for (const rule of rules) {
    const currentQty = readOnHand(db, rule.item_id, rule.warehouse_id);
    const base = {
      rule_id: rule.id,
      item_id: rule.item_id,
      product_code: rule.product_code,
      product_name: rule.product_name,
      base_unit: rule.base_unit,
      qty_precision: rule.qty_precision,
      warehouse_id: rule.warehouse_id,
      warehouse_name: rule.warehouse_name,
      current_qty: currentQty,
      min_qty: rule.min_qty,
      max_qty: rule.max_qty,
    };
    if (currentQty < rule.min_qty) alerts.push({ ...base, alert_type: 'below_min' });
    if (rule.max_qty !== null && currentQty > rule.max_qty) {
      alerts.push({ ...base, alert_type: 'above_max' });
    }
  }

  return query.alertType ? alerts.filter((row) => row.alert_type === query.alertType) : alerts;
}