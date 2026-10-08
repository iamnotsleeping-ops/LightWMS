import {
  SALES_ORDER_STATUS_SET,
  type SalesOrderBody,
  type SalesOrderQuery,
  type SalesOrderStatus,
  type SalesOrderUpdateBody,
  type SalesReturnQuery,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet } from '../../lib/sqlite';

// ---------- 行结构 ----------

export interface OrderListRow {
  id: number;
  order_no: string;
  customer_id: number;
  customer_name: string;
  order_date: string;
  status: SalesOrderStatus;
  total_amount: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
  total_qty: number;
  shipped_qty: number;
  /** 未出库量（待发货），仅在待出库状态计入 */
  unshipped: number;
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
  shipped_qty: number;
  cancelled_qty: number;
  unshipped: number;
  due_date: string;
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
  customer_id: number;
  customer_name: string;
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

function orderRow(db: Db, id: number): { id: number; order_no: string; status: SalesOrderStatus } {
  const row = db.prepare('SELECT id, order_no, status FROM sales_order WHERE id = ?').get(id) as
    | { id: number; order_no: string; status: SalesOrderStatus }
    | undefined;
  if (!row) throw new ApiError(404, '销售单不存在');
  return row;
}

function requireStatus(status: SalesOrderStatus, allowed: SalesOrderStatus[], message: string): void {
  if (!allowed.includes(status)) throw new ApiError(409, message);
}

/** 逗号分隔多值 → 合法状态数组；全部非法时返回空数组（不追加过滤条件） */
function parseStatuses(raw: string | undefined): SalesOrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is SalesOrderStatus => SALES_ORDER_STATUS_SET.has(value));
}

function computeAmount(quantity: number, unitPrice: number): number {
  return quantity * unitPrice;
}

// ---------- 销售单查询 ----------

const ORDER_SELECT = `
  SELECT o.id, o.order_no, o.customer_id, c.name AS customer_name, o.order_date, o.status,
         o.total_amount, o.remark, o.created_at, o.updated_at,
         COALESCE(SUM(i.quantity), 0) AS total_qty,
         COALESCE(SUM(i.shipped_qty), 0) AS shipped_qty,
         COALESCE(SUM(i.quantity - i.shipped_qty - i.cancelled_qty), 0) AS remain_qty
  FROM sales_order o
  JOIN partner c ON c.id = o.customer_id
  LEFT JOIN sales_order_item i ON i.order_id = o.id`;

export function listOrders(query: SalesOrderQuery): Paged<OrderListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(o.order_no LIKE ? OR c.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.customerId) {
    where.push('o.customer_id = ?');
    params.push(query.customerId);
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
    .prepare(`SELECT COUNT(*) AS total FROM sales_order o JOIN partner c ON c.id = o.customer_id ${clause}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `${ORDER_SELECT} ${clause} GROUP BY o.id
       ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as (Omit<
    OrderListRow,
    'unshipped'
  > & { remain_qty: number })[];

  const list: OrderListRow[] = rows.map(({ remain_qty, ...row }) => ({
    ...row,
    unshipped: row.status === 'confirmed' || row.status === 'partial' ? remain_qty : 0,
  }));

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export interface OrderDetail {
  order: Omit<OrderListRow, 'total_qty' | 'shipped_qty' | 'unshipped'>;
  items: OrderItemRow[];
  returns: (ReturnListRow & { lines: ReturnItemRow[] })[];
}

export function getOrderDetail(id: number): OrderDetail {
  const db = getDb();
  const order = db
    .prepare(
      `SELECT o.id, o.order_no, o.customer_id, c.name AS customer_name, o.order_date, o.status,
              o.total_amount, o.remark, o.created_at, o.updated_at
         FROM sales_order o JOIN partner c ON c.id = o.customer_id
        WHERE o.id = ?`,
    )
    .get(id) as OrderDetail['order'] | undefined;
  if (!order) throw new ApiError(404, '销售单不存在');

  const items = db
    .prepare(
      `SELECT i.id, i.line_no, i.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              i.quantity, i.unit_price, i.amount, i.shipped_qty, i.cancelled_qty, i.due_date
         FROM sales_order_item i
         JOIN item p ON p.id = i.product_id
         JOIN warehouse w ON w.id = i.warehouse_id
        WHERE i.order_id = ?
        ORDER BY i.line_no`,
    )
    .all(id) as Omit<OrderItemRow, 'unshipped'>[];

  const itemRows: OrderItemRow[] = items.map((item) => ({
    ...item,
    unshipped: item.quantity - item.shipped_qty - item.cancelled_qty,
  }));

  const returns = db
    .prepare(
      `SELECT r.id, r.return_no, r.order_id, o.order_no, r.customer_id, c.name AS customer_name,
              r.return_date, r.total_amount, r.remark, r.created_at,
              COALESCE(SUM(ri.quantity), 0) AS total_qty
         FROM sales_return r
         JOIN sales_order o ON o.id = r.order_id
         JOIN partner c ON c.id = r.customer_id
         LEFT JOIN sales_return_item ri ON ri.return_id = r.id
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
       FROM sales_return_item ri
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

// ---------- 销售单写入 ----------

function insertItems(db: Db, orderId: number, items: SalesOrderBody['items'], now: string): number {
  const insert = db.prepare(
    `INSERT INTO sales_order_item
       (order_id, line_no, product_id, warehouse_id, quantity, unit_price, amount,
        shipped_qty, cancelled_qty, due_date, created_at, updated_at)
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
      item.due_date,
      now,
      now,
    );
  });
  return total;
}

export function createOrder(body: SalesOrderBody, userId: number | null): { id: number; order_no: string } {
  const db = getDb();
  return db.transaction(() => {
    const now = new Date().toISOString();
    const orderNo = nextDocNo(db, 'sales', body.order_date);

    const info = db
      .prepare(
        `INSERT INTO sales_order
           (order_no, customer_id, order_date, status, total_amount, remark, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', 0, ?, ?, ?, ?)`,
      )
      .run(orderNo, body.customer_id, body.order_date, body.remark ?? null, userId, now, now);
    const orderId = Number(info.lastInsertRowid);

    const total = insertItems(db, orderId, body.items, now);
    db.prepare('UPDATE sales_order SET total_amount = ? WHERE id = ?').run(total, orderId);

    return { id: orderId, order_no: orderNo };
  })();
}

export function updateOrder(id: number, body: SalesOrderUpdateBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的销售单可修改');

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['customer_id', body.customer_id],
      ['order_date', body.order_date],
      ['remark', body.remark === undefined ? undefined : body.remark || null],
    ]);

    if (body.items) {
      db.prepare('DELETE FROM sales_order_item WHERE order_id = ?').run(id);
      const total = insertItems(db, id, body.items, now);
      db.prepare('UPDATE sales_order SET total_amount = ? WHERE id = ?').run(total, id);
    }

    if (clause !== '') {
      db.prepare(`UPDATE sales_order SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE sales_order SET updated_at = ? WHERE id = ?').run(now, id);
    }
    return { id };
  })();
}

export function deleteOrder(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的销售单可删除');
    db.prepare('DELETE FROM sales_order WHERE id = ?').run(id);
    return { id };
  })();
}

export function confirmOrder(id: number): { id: number; status: SalesOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的销售单可确认');
    db.prepare("UPDATE sales_order SET status = 'confirmed', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'confirmed' as const };
  })();
}

export function cancelOrder(id: number): { id: number; status: SalesOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = orderRow(db, id);
    requireStatus(existing.status, ['draft', 'confirmed'], '仅草稿或已确认的销售单可取消');
    db.prepare("UPDATE sales_order SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'cancelled' as const };
  })();
}

// ---------- 销售退货查询 ----------

export function listReturns(query: SalesReturnQuery): Paged<ReturnListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.orderId) {
    where.push('r.order_id = ?');
    params.push(query.orderId);
  }
  if (query.keyword) {
    where.push('(r.return_no LIKE ? OR o.order_no LIKE ? OR c.name LIKE ?)');
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
    FROM sales_return r
    JOIN sales_order o ON o.id = r.order_id
    JOIN partner c ON c.id = r.customer_id
    LEFT JOIN sales_return_item ri ON ri.return_id = r.id`;

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sales_return r ${clause}`)
    .get(...params) as { total: number };

  const list = db
    .prepare(
      `SELECT r.id, r.return_no, r.order_id, o.order_no, r.customer_id, c.name AS customer_name,
              r.return_date, r.total_amount, r.remark, r.created_at,
              COALESCE(SUM(ri.quantity), 0) AS total_qty
       ${base} ${clause}
       GROUP BY r.id
       ORDER BY r.return_date DESC, r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as ReturnListRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}