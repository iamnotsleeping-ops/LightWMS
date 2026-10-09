import {
  TRANSFER_ORDER_STATUS_SET,
  type TransferOrderBody,
  type TransferOrderQuery,
  type TransferOrderStatus,
  type TransferOrderUpdateBody,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet } from '../../lib/sqlite';
import { postMovement, readBalanceByStatus, readWarehouseCost } from './stock.engine';

// ---------- 行结构 ----------

export interface TransferListRow {
  id: number;
  order_no: string;
  from_warehouse_id: number;
  from_warehouse_name: string;
  to_warehouse_id: number;
  to_warehouse_name: string;
  order_date: string;
  status: TransferOrderStatus;
  remark: string | null;
  created_at: string;
  updated_at: string;
  total_qty: number;
  shipped_qty: number;
  received_qty: number;
  /** 待发货量，仅在 confirmed 状态计入 */
  unshipped: number;
  /** 在途量，仅在 shipped 状态计入 */
  unreceived: number;
}

export interface TransferItemRow {
  id: number;
  line_no: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  quantity: number;
  shipped_qty: number;
  received_qty: number;
  cancelled_qty: number;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

// ---------- 内部工具 ----------

interface TransferHeaderDb {
  id: number;
  order_no: string;
  from_warehouse_id: number;
  to_warehouse_id: number;
  status: TransferOrderStatus;
}

function headerRow(db: Db, id: number): TransferHeaderDb {
  const row = db
    .prepare(
      'SELECT id, order_no, from_warehouse_id, to_warehouse_id, status FROM transfer_order WHERE id = ?',
    )
    .get(id) as TransferHeaderDb | undefined;
  if (!row) throw new ApiError(404, '调拨单不存在');
  return row;
}

function requireStatus(
  status: TransferOrderStatus,
  allowed: TransferOrderStatus[],
  message: string,
): void {
  if (!allowed.includes(status)) throw new ApiError(409, message);
}

function parseStatuses(raw: string | undefined): TransferOrderStatus[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is TransferOrderStatus => TRANSFER_ORDER_STATUS_SET.has(value));
}

// ---------- 调拨单查询 ----------

const ORDER_SELECT = `
  SELECT o.id, o.order_no,
         o.from_warehouse_id, fw.name AS from_warehouse_name,
         o.to_warehouse_id, tw.name AS to_warehouse_name,
         o.order_date, o.status, o.remark, o.created_at, o.updated_at,
         COALESCE(SUM(i.quantity), 0) AS total_qty,
         COALESCE(SUM(i.shipped_qty), 0) AS shipped_qty,
         COALESCE(SUM(i.received_qty), 0) AS received_qty
  FROM transfer_order o
  JOIN warehouse fw ON fw.id = o.from_warehouse_id
  JOIN warehouse tw ON tw.id = o.to_warehouse_id
  LEFT JOIN transfer_order_item i ON i.order_id = o.id`;

export function listTransfers(query: TransferOrderQuery): Paged<TransferListRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(o.order_no LIKE ? OR fw.name LIKE ? OR tw.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.fromWarehouseId) {
    where.push('o.from_warehouse_id = ?');
    params.push(query.fromWarehouseId);
  }
  if (query.toWarehouseId) {
    where.push('o.to_warehouse_id = ?');
    params.push(query.toWarehouseId);
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
      `SELECT COUNT(*) AS total FROM transfer_order o
        JOIN warehouse fw ON fw.id = o.from_warehouse_id
        JOIN warehouse tw ON tw.id = o.to_warehouse_id ${clause}`,
    )
    .get(...params) as { total: number };

  const rows = db
    .prepare(`${ORDER_SELECT} ${clause} GROUP BY o.id ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as Omit<
    TransferListRow,
    'unshipped' | 'unreceived'
  >[];

  const list: TransferListRow[] = rows.map((row) => ({
    ...row,
    unshipped: row.status === 'confirmed' ? row.total_qty - row.shipped_qty : 0,
    unreceived: row.status === 'shipped' ? row.shipped_qty - row.received_qty : 0,
  }));

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export interface TransferDetail {
  order: Omit<TransferListRow, 'total_qty' | 'shipped_qty' | 'received_qty' | 'unshipped' | 'unreceived'>;
  items: TransferItemRow[];
}

export function getTransferDetail(id: number): TransferDetail {
  const db = getDb();
  const order = db
    .prepare(
      `SELECT o.id, o.order_no,
              o.from_warehouse_id, fw.name AS from_warehouse_name,
              o.to_warehouse_id, tw.name AS to_warehouse_name,
              o.order_date, o.status, o.remark, o.created_at, o.updated_at
         FROM transfer_order o
         JOIN warehouse fw ON fw.id = o.from_warehouse_id
         JOIN warehouse tw ON tw.id = o.to_warehouse_id
        WHERE o.id = ?`,
    )
    .get(id) as TransferDetail['order'] | undefined;
  if (!order) throw new ApiError(404, '调拨单不存在');

  const items = db
    .prepare(
      `SELECT i.id, i.line_no, i.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              i.quantity, i.shipped_qty, i.received_qty, i.cancelled_qty
         FROM transfer_order_item i
         JOIN item p ON p.id = i.product_id
        WHERE i.order_id = ?
        ORDER BY i.line_no`,
    )
    .all(id) as TransferItemRow[];

  return { order, items };
}

// ---------- 调拨单写入 ----------

function insertItems(
  db: Db,
  orderId: number,
  items: TransferOrderBody['items'],
  now: string,
): void {
  const insert = db.prepare(
    `INSERT INTO transfer_order_item
       (order_id, line_no, product_id, quantity, shipped_qty, received_qty, cancelled_qty, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)`,
  );
  items.forEach((item, index) => {
    insert.run(orderId, index + 1, item.product_id, item.quantity, now, now);
  });
}

export function createTransfer(
  body: TransferOrderBody,
  userId: number | null,
): { id: number; order_no: string } {
  const db = getDb();
  if (body.from_warehouse_id === body.to_warehouse_id) {
    throw new ApiError(400, '调出与调入仓库不能相同');
  }
  return db.transaction(() => {
    const now = new Date().toISOString();
    const orderNo = nextDocNo(db, 'transfer', body.order_date);

    const info = db
      .prepare(
        `INSERT INTO transfer_order
           (order_no, from_warehouse_id, to_warehouse_id, order_date, status, remark, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      )
      .run(
        orderNo,
        body.from_warehouse_id,
        body.to_warehouse_id,
        body.order_date,
        body.remark ?? null,
        userId,
        now,
        now,
      );
    const orderId = Number(info.lastInsertRowid);

    insertItems(db, orderId, body.items, now);
    return { id: orderId, order_no: orderNo };
  })();
}

export function updateTransfer(id: number, body: TransferOrderUpdateBody): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的调拨单可修改');

    const fromId = body.from_warehouse_id ?? existing.from_warehouse_id;
    const toId = body.to_warehouse_id ?? existing.to_warehouse_id;
    if (fromId === toId) throw new ApiError(400, '调出与调入仓库不能相同');

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['from_warehouse_id', body.from_warehouse_id],
      ['to_warehouse_id', body.to_warehouse_id],
      ['order_date', body.order_date],
      ['remark', body.remark === undefined ? undefined : body.remark || null],
    ]);

    if (body.items) {
      db.prepare('DELETE FROM transfer_order_item WHERE order_id = ?').run(id);
      insertItems(db, id, body.items, now);
    }

    if (clause !== '') {
      db.prepare(`UPDATE transfer_order SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        now,
        id,
      );
    } else {
      db.prepare('UPDATE transfer_order SET updated_at = ? WHERE id = ?').run(now, id);
    }
    return { id };
  })();
}

export function deleteTransfer(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的调拨单可删除');
    db.prepare('DELETE FROM transfer_order WHERE id = ?').run(id);
    return { id };
  })();
}

export function confirmTransfer(id: number): { id: number; status: TransferOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft'], '仅草稿状态的调拨单可确认');
    db.prepare("UPDATE transfer_order SET status = 'confirmed', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
    return { id, status: 'confirmed' as const };
  })();
}

export function cancelTransfer(id: number): { id: number; status: TransferOrderStatus } {
  const db = getDb();
  return db.transaction(() => {
    const existing = headerRow(db, id);
    requireStatus(existing.status, ['draft', 'confirmed'], '仅草稿或已确认的调拨单可取消');
    const now = new Date().toISOString();
    // 行级回填取消量，与采购 / 销售取消保持一致（该列此前无任何写入路径）
    db.prepare(
      'UPDATE transfer_order_item SET cancelled_qty = quantity - shipped_qty, updated_at = ? WHERE order_id = ?',
    ).run(now, id);
    db.prepare("UPDATE transfer_order SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      now,
      id,
    );
    return { id, status: 'cancelled' as const };
  })();
}

export interface TransferOperationResult {
  id: number;
  status: TransferOrderStatus;
  transactionIds: number[];
}

interface TransferLineDb {
  id: number;
  product_id: number;
  quantity: number;
  shipped_qty: number;
  received_qty: number;
}

/**
 * 整单发货：源仓 → 在途。
 * 引擎出库分支不校验库存，故按 product 合并整单请求量后预检源仓物理可用量。
 * 出库按源仓当前移动加权平均结转（不传 unitCost），源仓均价不变。
 */
export function shipTransfer(id: number, occurredAt?: string): TransferOperationResult {
  const db = getDb();
  return db.transaction(() => {
    const order = headerRow(db, id);
    requireStatus(order.status, ['confirmed'], `调拨单当前状态「${order.status}」不可发货`);

    const lines = db
      .prepare(
        'SELECT id, product_id, quantity, shipped_qty, received_qty FROM transfer_order_item WHERE order_id = ?',
      )
      .all(id) as TransferLineDb[];
    if (lines.length === 0) throw new ApiError(409, '调拨单没有明细，无法发货');

    const requested = new Map<number, number>();
    for (const line of lines) {
      requested.set(line.product_id, (requested.get(line.product_id) ?? 0) + line.quantity);
    }
    for (const [productId, qty] of requested) {
      const available = readBalanceByStatus(db, productId, order.from_warehouse_id).available;
      if (available < qty) {
        throw new ApiError(409, `调出仓库物理可用库存不足（可用 ${available}）`);
      }
    }

    const now = occurredAt ?? new Date().toISOString();
    const transactionIds: number[] = [];
    const updateItem = db.prepare(
      'UPDATE transfer_order_item SET shipped_qty = ?, updated_at = ? WHERE id = ?',
    );

    for (const line of lines) {
      const transactionId = postMovement({
        productId: line.product_id,
        warehouseId: order.from_warehouse_id,
        stockStatus: 'available',
        bizType: 'transfer_out',
        bizId: order.id,
        bizNo: order.order_no,
        direction: -1,
        quantity: line.quantity,
        occurredAt: now,
      });
      transactionIds.push(transactionId);
      updateItem.run(line.quantity, now, line.id);
    }

    db.prepare("UPDATE transfer_order SET status = 'shipped', updated_at = ? WHERE id = ?").run(
      now,
      order.id,
    );
    return { id: order.id, status: 'shipped' as const, transactionIds };
  })();
}

/**
 * 整单收货：在途 → 目标仓。
 * 入库必须显式传入源仓当前均价作为结转成本，否则引擎 fallback 0 会把目标仓均价稀释为 0。
 */
export function receiveTransfer(id: number, occurredAt?: string): TransferOperationResult {
  const db = getDb();
  return db.transaction(() => {
    const order = headerRow(db, id);
    requireStatus(order.status, ['shipped'], `调拨单当前状态「${order.status}」不可收货`);

    const lines = db
      .prepare(
        'SELECT id, product_id, quantity, shipped_qty, received_qty FROM transfer_order_item WHERE order_id = ?',
      )
      .all(id) as TransferLineDb[];

    const now = occurredAt ?? new Date().toISOString();
    const transactionIds: number[] = [];
    const updateItem = db.prepare(
      'UPDATE transfer_order_item SET received_qty = ?, updated_at = ? WHERE id = ?',
    );

    for (const line of lines) {
      const unitCost = readWarehouseCost(db, line.product_id, order.from_warehouse_id);
      const transactionId = postMovement({
        productId: line.product_id,
        warehouseId: order.to_warehouse_id,
        stockStatus: 'available',
        bizType: 'transfer_in',
        bizId: order.id,
        bizNo: order.order_no,
        direction: 1,
        quantity: line.quantity,
        unitCost,
        occurredAt: now,
      });
      transactionIds.push(transactionId);
      updateItem.run(line.quantity, now, line.id);
    }

    db.prepare("UPDATE transfer_order SET status = 'received', updated_at = ? WHERE id = ?").run(
      now,
      order.id,
    );
    return { id: order.id, status: 'received' as const, transactionIds };
  })();
}