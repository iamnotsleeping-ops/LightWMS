import {
  PURCHASE_ORDER_STATUS_SET,
  type PurchaseOrderBody,
  type PurchaseOrderQuery,
  type PurchaseOrderStatus,
  type PurchaseOrderUpdateBody,
  type PurchaseReturnQuery,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet } from '../../lib/sqlite';

// ---------- 行结构 ----------

export interface OrderListRow {
  id: number;
  order_no: string;
  supplier_id: number;
  supplier_name: string;
  order_date: string;
  status: PurchaseOrderStatus;
  total_amount: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
  total_qty: number;
  received_qty: number;
  /** 剩余待入库量（未入库的在途量），仅在途状态计入 */
  in_transit: number;
}

export interface OrderItemRow {
  id: number;
  line_no: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  quantity: number;
  unit_price: number;
  amount: number;
  received_qty: number;
  cancelled_qty: number;
  in_transit: number;
  promised_date: string;
}

export interface ReturnItemRow {
  id: number;
  line_no: number;
  order_item_id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_name: string;
  quantity: number;
  unit_cost: number;
  amount: number;
}

export interface ReturnListRow {
  id: number;
  return_no: string;
  order_id: number;
  order_no: string;
  supplier_id: number;
  supplier_name: string;
  return_date: string;
  total_amount: number;
  remark: string | null;
  created_at: string;
  total_qty: number;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

// ---------- 内部工具 ----------

function orderRow(db: Db, id: number): { id: number; order_no: string; status: PurchaseOrderStatus } {
  const row = db.prepare('SELECT id, order_no, status FROM purchase_order WHERE id = ?').get(id) as
    | { id: number; order_no: string; status: PurchaseOrderStatus }
    | undefined;
  if (!row) throw new ApiError(404, '采购单不存在');
  return row;
}

function requireStatus(status: PurchaseOrderStatus, allowed: PurchaseOrderStatus[], message: string): void {
  if (!allowed.includes(status)) throw new ApiError(409, message);
}

/** 逗号分隔多值 → 合法状态数组；全部非法时返回空数组（不追加过滤条件） */
function parseStatuses(raw: string | undefined): PurchaseOrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is PurchaseOrderStatus => PURCHASE_ORDER_STATUS_SET.has(value));
}

function computeAmount(quantity: number, unitPrice: number): number {
  return quantity * unitPrice;
}

// ---------- 采购单查询 ----------

const ORDER_SELECT = `
  SELECT o.id, o.order_no, o.supplier_id, s.name AS supplier_name, o.order_date, o.status,
         o.total_amount, o.remark, o.created_at, o.updated_at,
         COALESCE(SUM(i.quantity), 0) AS total_qty,
         COALESCE(SUM(i.received_qty), 0) AS received_qty,
         COALESCE(SUM(i.quantity - i.received_qty - i.cancelled_qty), 0) AS remain_qty
  FROM purchase_order o
  JOIN partner s ON s.id = o.supplier_id
  LEFT JOIN purchase_order_item i ON i.order_id = o.id`;

export function listOrders(query: PurchaseOrderQuery): Paged<OrderListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(o.order_no LIKE ? OR s.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.supplierId) {
    where.push('o.supplier_id = ?');
    params.push(query.supplierId);
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
    .prepare(`SELECT COUNT(*) AS total FROM purchase_order o JOIN partner s ON s.id = o.supplier_id ${clause}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `${ORDER_SELECT} ${clause} GROUP BY o.id
       ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as (Omit<
    OrderListRow,
    'in_transit'
  > & { remain_qty: number })[];

  const list: OrderListRow[] = rows.map(({ remain_qty, ...row }) => ({
    ...row,
    in_transit: row.status === 'confirmed' || row.status === 'partial' ? remain_qty : 0,
  }));

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export interface OrderDetail {
  order: Omit<OrderListRow, 'total_qty' | 'received_qty' | 'in_transit'>;
  items: OrderItemRow[];
  returns: (ReturnListRow & { lines: ReturnItemRow[] })[];
}

export function getOrderDetail(id: number): OrderDetail {
  const db = getDb();
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.supplier_id, s.name AS supplier_name, o.order_date, o.status,
              o.total_amount, o.remark, o.created_at, o.updated_at
         FROM purchase_order o JOIN partner s ON s.id = o.supplier_id
        WHERE o.id = ?`,
    )
    .get(id) as OrderDetail['order'] | undefined;
  if (!order) throw new ApiError(404, '采购单不存在');

  const items = db
    .prepare(
      `SELECT i.id, i.line_no, i.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              i.quantity, i.unit_price, i.amount, i.received_qty, i.cancelled_qty, i.promised_date
         FROM purchase_order_item i
         JOIN item p ON p.id = i.product_id
         JOIN warehouse w ON w.id = i.warehouse_id
        WHERE i.order_id = ?
        ORDER BY i.line_no`,
    )
    .all(id) as Omit<OrderItemRow, 'in_transit'>[];

  const itemRows: OrderItemRow[] = items.map((item) => ({
    ...item,
    in_transit: item.quantity - item.received_qty - item.cancelled_qty,
  }));

  const returns = db
    .prepare(
      `SELECT r.id, r.return_no, r.order_id, o.order_no, r.supplier_id, s.name AS supplier_name,
              r.return_date, r.total_amount, r.remark, r.created_at,
              COALESCE(SUM(ri.quantity), 0) AS total_qty
         FROM purchase_return r
         JOIN purchase_order o ON o.id = r.order_id
         JOIN partner s ON s.id = r.supplier_id
         LEFT JOIN purchase_return_item ri ON ri.return_id = r.id
        WHERE r.order_id = ?
        GROUP BY r.id
        ORDER BY r.return_date DESC, r.id DESC`,
    )
    .all(id) as ReturnListRow[];

  const lineStmt = db.prepare(
    `SELECT ri.id, ri.line_no, ri.order_item_id, ri.product_id, p.code AS product_code,
            p.name AS product_name, p.base_unit, p.qty_precision,
            ri.warehouse_id, w.name AS warehouse_name,
            ri.quantity, ri.unit_cost, ri.amount
       FROM purchase_return_item ri
       JOIN item p ON p.id = ri.product_id
       JOIN warehouse w ON w.id = ri.warehouse_id
      WHERE ri.return_id = ?
      ORDER BY ri.line_no`,
  );

  return {
    order,
    items: itemRows,
    returns: returns.map((row) => ({ ...row, lines: lineStmt.all(row.id) as ReturnItemRow[] })),
  };
}

// ---------- 采购单写入 ----------

function insertItems(
  db: Db,
  orderId: number,
  items: PurchaseOrderBody['items'],
  now: string,
): number {
  const insert = db.prepare(
    `INSERT INTO purchase_order_item
       (order_id, line_no, product_id, warehouse_id, quantity, unit_price, amount,
        received_qty, cancelled_qty, promised_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
  );
  let total = 0;
  items.forEach((item, index) => {
    const amount = computeAmount(item.quantity, item.unit_price);
    total += amount;
    insert.run(
      orderId,
      index + 1,
      item.product_id,
      item.warehouse_id,
      item.quantity,
      item.unit_price,
      amount,
      item.promised_date,
      now,
      now,
    );
  });
  return total;
}

export function createOrder(body: PurchaseOrderBody, userId: number | null): { id: number; order_no: string } {
  const db = getDb();
  return db.transaction(() => {
    const now = new Date().toISOString();
    const orderNo = nextDocNo(db, 'purchase', body.order_date);

    const info = db
      .prepare(
        `INSERT INTO purchase_order
           (order_no, supplier_id, order_date, status, total_amount, remark, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', 0, ?, ?, ?, ?)`,
      )
      .run(orderNo, body.supplier_id, body.order_date, body.remark ?? null, userId, now, now);
    const orderId = Number(info.lastInsertRowid);

    const total = insertItems(db, orderId, body.items, now);
    db.prepare('UPDATE purchase_order SET total_amount = ? WHERE id = ?').run(total, orderId);

    return { id: orderId, order_no: orderNo };
  })();
}

export function updateOrder(id: number, body: PurchaseOrderUpdateBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的采购单可修改');

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['supplier_id', body.supplier_id],
      ['order_date', body.order_date],
      ['remark', body.remark === undefined ? undefined : body.remark || null],
    ]);

    if (body.items) {
      db.prepare('DELETE FROM purchase_order_item WHERE order_id = ?').run(id);
      const total = insertItems(db, id, body.items, now);
      db.prepare('UPDATE purchase_order SET total_amount = ? WHERE id = ?').run(total, id);
    }

    if (clause !== '') {
      db.prepare(`UPDATE purchase_order SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE purchase_order SET updated_at = ? WHERE id = ?').run(now, id);
    }
    return { id };
  })();
}

export function deleteOrder(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的采购单可删除');
    db.prepare('DELETE FROM purchase_order WHERE id = ?').run(id);
    return { id };
  })();
}

export function confirmOrder(id: number): { id: number; status: PurchaseOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的采购单可确认');
    db.prepare("UPDATE purchase_order SET status = 'confirmed', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'confirmed' as const };
  })();
}

export function cancelOrder(id: number): { id: number; status: PurchaseOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft', 'confirmed'], '仅草稿或已确认的采购单可取消');
    db.prepare("UPDATE purchase_order SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'cancelled' as const };
  })();
}

// ---------- 采购退货查询 ----------

export function listReturns(query: PurchaseReturnQuery): Paged<ReturnListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.orderId) {
    where.push('r.order_id = ?');
    params.push(query.orderId);
  }
  if (query.keyword) {
    where.push('(r.return_no LIKE ? OR o.order_no LIKE ? OR s.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.dateFrom) {
    where.push('r.return_date >= ?');
    params.push(query.dateFrom);
  }
  if (query.dateTo) {
    where.push('r.return_date <= ?');
    params.push(query.dateTo);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const base = `
    FROM purchase_return r
    JOIN purchase_order o ON o.id = r.order_id
    JOIN partner s ON s.id = r.supplier_id
    LEFT JOIN purchase_return_item ri ON ri.return_id = r.id`;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM purchase_return r ${clause}`)
    .get(...params) as { total: number };

  const list = db
    .prepare(
      `SELECT r.id, r.return_no, r.order_id, o.order_no, r.supplier_id, s.name AS supplier_name,
              r.return_date, r.total_amount, r.remark, r.created_at,
              COALESCE(SUM(ri.quantity), 0) AS total_qty
       ${base} ${clause}
       GROUP BY r.id
       ORDER BY r.return_date DESC, r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as ReturnListRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}