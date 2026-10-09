import {
  STOCKTAKE_ORDER_STATUS_SET,
  type StockStatus,
  type StocktakeOrderBody,
  type StocktakeOrderQuery,
  type StocktakeOrderStatus,
  type StocktakeOrderUpdateBody,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet } from '../../lib/sqlite';
import { postMovement, readBalanceByStatus, readWarehouseCost } from './stock.engine';

// ---------- 行结构 ----------

export interface StocktakeListRow {
  id: number;
  order_no: string;
  warehouse_id: number;
  warehouse_name: string;
  order_date: string;
  status: StocktakeOrderStatus;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
  total_lines: number;
  diff_lines: number;
}

export interface StocktakeItemRow {
  id: number;
  line_no: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  stock_status: StockStatus;
  book_qty: number;
  counted_qty: number;
  diff_qty: number;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

// ---------- 内部工具 ----------

interface StocktakeHeaderDb {
  id: number;
  order_no: string;
  warehouse_id: number;
  status: StocktakeOrderStatus;
}

function headerRow(db: Db, id: number): StocktakeHeaderDb {
  const row = db
    .prepare('SELECT id, order_no, warehouse_id, status FROM stocktake_order WHERE id = ?')
    .get(id) as StocktakeHeaderDb | undefined;
  if (!row) throw new ApiError(404, '盘点单不存在');
  return row;
}

function requireStatus(
  status: StocktakeOrderStatus,
  allowed: StocktakeOrderStatus[],
  message: string,
): void {
  if (!allowed.includes(status)) throw new ApiError(409, message);
}

function parseStatuses(raw: string | undefined): StocktakeOrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is StocktakeOrderStatus => STOCKTAKE_ORDER_STATUS_SET.has(value));
}

const ORDER_SELECT = `
  SELECT o.id, o.order_no, o.warehouse_id, w.name AS warehouse_name,
         o.order_date, o.status, o.posted_at, o.created_at, o.updated_at,
         COALESCE(COUNT(i.id), 0) AS total_lines,
         COALESCE(SUM(CASE WHEN i.diff_qty <> 0 THEN 1 ELSE 0 END), 0) AS diff_lines
  FROM stocktake_order o
  JOIN warehouse w ON w.id = o.warehouse_id
  LEFT JOIN stocktake_order_item i ON i.order_id = o.id`;

// ---------- 盘点单查询 ----------

export function listStocktakes(query: StocktakeOrderQuery): Paged<StocktakeListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(o.order_no LIKE ? OR w.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.warehouseId) {
    where.push('o.warehouse_id = ?');
    params.push(query.warehouseId);
  }
  const statuses = parseStatuses(query.status);
  if (statuses.length > 0) {
    where.push(`o.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (query.dateFrom) {
    where.push('o.order_date >= ?');
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    where.push('o.order_date <= ?');
    params.push(query.dateTo);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM stocktake_order o JOIN warehouse w ON w.id = o.warehouse_id ${clause}`,
    )
    .get(...params) as { total: number };

  const list = db
    .prepare(`${ORDER_SELECT} ${clause} GROUP BY o.id ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as StocktakeListRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export interface StocktakeDetail {
  order: Omit<StocktakeListRow, 'total_lines' | 'diff_lines'>;
  items: StocktakeItemRow[];
}

export function getStocktakeDetail(id: number): StocktakeDetail {
  const db = getDb();
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.warehouse_id, w.name AS warehouse_name,
              o.order_date, o.status, o.posted_at, o.created_at, o.updated_at
         FROM stocktake_order o JOIN warehouse w ON w.id = o.warehouse_id
        WHERE o.id = ?`,
    )
    .get(id) as StocktakeDetail['order'] | undefined;
  if (!order) throw new ApiError(404, '盘点单不存在');

  const items = db
    .prepare(
      `SELECT i.id, i.line_no, i.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              i.stock_status, i.book_qty, i.counted_qty, i.diff_qty
         FROM stocktake_order_item i
         JOIN item p ON p.id = i.product_id
        WHERE i.order_id = ?
        ORDER BY i.line_no`,
    )
    .all(id) as StocktakeItemRow[];

  return { order, items };
}

// ---------- 盘点单写入 ----------

/** 录入时快照账面量；diff = 实盘 − 账面，过账时会按当时余额重算 */
function insertItems(
  db: Db,
  orderId: number,
  warehouseId: number,
  items: StocktakeOrderBody['items'],
): void {
  const insert = db.prepare(
    `INSERT INTO stocktake_order_item
       (order_id, line_no, product_id, stock_status, book_qty, counted_qty, diff_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  items.forEach((item, index) => {
    const bookQty = readBalanceByStatus(db, item.product_id, warehouseId)[item.stock_status];
    insert.run(
      orderId,
      index + 1,
      item.product_id,
      item.stock_status,
      bookQty,
      item.counted_qty,
      item.counted_qty - bookQty,
    );
  });
}

export function createStocktake(
  body: StocktakeOrderBody,
  userId: number | null,
): { id: number; order_no: string } {
  const db = getDb();
  return db.transaction(() => {
    const now = new Date().toISOString();
    const orderNo = nextDocNo(db, 'stocktake', body.order_date);

    const info = db
      .prepare(
        `INSERT INTO stocktake_order
           (order_no, warehouse_id, order_date, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(orderNo, body.warehouse_id, body.order_date, userId, now, now);
    const orderId = Number(info.lastInsertRowid);

    insertItems(db, orderId, body.warehouse_id, body.items);
    return { id: orderId, order_no: orderNo };
  })();
}

export function updateStocktake(id: number, body: StocktakeOrderUpdateBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的盘点单可修改');

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['warehouse_id', body.warehouse_id],
      ['order_date', body.order_date],
    ]);

    if (body.items) {
      const warehouseId = body.warehouse_id ?? existing.warehouse_id;
      db.prepare('DELETE FROM stocktake_order_item WHERE order_id = ?').run(id);
      insertItems(db, id, warehouseId, body.items);
    }

    if (clause !== '') {
      db.prepare(`UPDATE stocktake_order SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE stocktake_order SET updated_at = ? WHERE id = ?').run(now, id);
    }
    return { id };
  })();
}

export function deleteStocktake(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的盘点单可删除');
    db.prepare('DELETE FROM stocktake_order WHERE id = ?').run(id);
    return { id };
  })();
}

export function cancelStocktake(id: number): { id: number; status: StocktakeOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的盘点单可取消');
    db.prepare("UPDATE stocktake_order SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'cancelled' as const };
  })();
}

export interface StocktakePostResult {
  id: number;
  status: StocktakeOrderStatus;
  transactionIds: number[];
  adjustedLines: number;
}

interface StocktakeLineDb {
  id: number;
  product_id: number;
  stock_status: StockStatus;
  counted_qty: number;
}

/**
 * 盘点过账：以实盘量对齐账面。
 * 过账时重读当前余额、重算差异（消除「录入 → 过账」之间的库存漂移），
 * 盘盈显式传入当前均价使均价零漂移，盘亏走引擎出库分支自动携带成本。
 */
export function postStocktake(id: number, occurredAt?: string): StocktakePostResult {
  const db = getDb();
  return db.transaction(() => {
    const order = headerRow(db, id);
    requireStatus(order.status, ['draft'], '仅草稿状态的盘点单可过账');

    const lines = db
      .prepare(
        'SELECT id, product_id, stock_status, counted_qty FROM stocktake_order_item WHERE order_id = ? ORDER BY line_no',
      )
      .all(id) as StocktakeLineDb[];

    const now = occurredAt ?? new Date().toISOString();
    const transactionIds: number[] = [];
    const writeBack = db.prepare(
      'UPDATE stocktake_order_item SET book_qty = ?, diff_qty = ? WHERE id = ?',
    );

    for (const line of lines) {
      const bookNow = readBalanceByStatus(db, line.product_id, order.warehouse_id)[
        line.stock_status
      ];
      const delta = line.counted_qty - bookNow;

      // 此处无需再校验「盘亏是否超过账面」：过账的语义就是把余额对齐到实盘量
      // （counted_qty ≥ 0 已由 zod 保证），盘盈盘亏本身都允许。
      // 曾有一条 `if (bookNow + delta < 0)` 守卫，等价于 `counted_qty < 0`，恒不成立。

      if (delta !== 0) {
        const transactionId = postMovement({
          productId: line.product_id,
          warehouseId: order.warehouse_id,
          stockStatus: line.stock_status,
          bizType: 'adjust',
          bizId: order.id,
          bizNo: order.order_no,
          direction: delta > 0 ? 1 : -1,
          quantity: Math.abs(delta),
          ...(delta > 0
            ? { unitCost: readWarehouseCost(db, line.product_id, order.warehouse_id) }
            : {}),
          occurredAt: now,
        });
        transactionIds.push(transactionId);
      }

      writeBack.run(bookNow, delta, line.id);
    }

    db.prepare(
      "UPDATE stocktake_order SET status = 'posted', posted_at = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, order.id);

    return {
      id: order.id,
      status: 'posted' as const,
      transactionIds,
      adjustedLines: transactionIds.length,
    };
  })();
}