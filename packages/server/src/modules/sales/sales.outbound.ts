import type { SalesOrderStatus, SalesOutboundBody, SalesReturnBody } from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError } from '../../lib/response';
import { postMovement, readBalanceByStatus, readWarehouseCost } from '../inventory/stock.engine';

export interface OutboundResult {
  orderId: number;
  status: SalesOrderStatus;
  transactionIds: number[];
}

interface OutboundLineDb {
  id: number;
  product_id: number;
  warehouse_id: number;
  quantity: number;
  shipped_qty: number;
  cancelled_qty: number;
}

function loadOrder(
  db: Db,
  id: number,
): { id: number; order_no: string; customer_id: number; status: SalesOrderStatus } {
  const row = db
    .prepare('SELECT id, order_no, customer_id, status FROM sales_order WHERE id = ?')
    .get(id) as
    | { id: number; order_no: string; customer_id: number; status: SalesOrderStatus }
    | undefined;
  if (!row) throw new ApiError(404, '销售单不存在');
  return row;
}

/**
 * 行级直接出库：一个事务内 校验 → 校验物理可用量 → 逐行写 sale_out 流水（按当前均价结转）
 * → 累加 shipped_qty → 推进单据状态。
 * 引擎出库分支不校验库存，故此处必须按 (物料, 仓库) 合并请求量后预检物理可用量。
 */
export function shipSales(body: SalesOutboundBody, _userId: number | null): OutboundResult {
  const db = getDb();
  return db.transaction(() => {
    const order = loadOrder(db, body.orderId);
    if (order.status !== 'confirmed' && order.status !== 'partial') {
      throw new ApiError(409, `销售单当前状态「${order.status}」不可出库`);
    }

    const itemStmt = db.prepare(
      `SELECT id, product_id, warehouse_id, quantity, shipped_qty, cancelled_qty
         FROM sales_order_item WHERE id = ? AND order_id = ?`,
    );

    // 先整体校验未出库量；同 (物料, 仓库) 的请求量合并后再比对物理可用量。
    // claimed 按订单行累计本请求已提交量：上限取自库中快照，若不在请求内累计，
    // 同一订单行重复出现时每一行都会独立通过校验而合计超发。
    const claimed = new Map<number, number>();
    const requested = new Map<string, number>();
    const prepared = body.lines.map((line) => {
      const item = itemStmt.get(line.orderItemId, body.orderId) as OutboundLineDb | undefined;
      if (!item) throw new ApiError(400, '出库明细不属于该销售单');
      const unshipped = item.quantity - item.shipped_qty - item.cancelled_qty;
      const claimedQty = (claimed.get(item.id) ?? 0) + line.quantity;
      if (claimedQty > unshipped) {
        throw new ApiError(409, `出库数量超过未出库量（未出库 ${unshipped}）`);
      }
      claimed.set(item.id, claimedQty);
      const key = `${item.product_id}:${item.warehouse_id}`;
      requested.set(key, (requested.get(key) ?? 0) + line.quantity);
      return { line, item };
    });

    for (const [key, qty] of requested) {
      const [productId, warehouseId] = key.split(':').map(Number);
      const available = readBalanceByStatus(db, productId, warehouseId).available;
      if (available < qty) {
        throw new ApiError(409, `源仓库物理可用库存不足（可用 ${available}）`);
      }
    }

    const occurredAt = body.occurredAt ?? new Date().toISOString();
    const transactionIds: number[] = [];
    const updateItem = db.prepare(
      'UPDATE sales_order_item SET shipped_qty = shipped_qty + ?, updated_at = ? WHERE id = ?',
    );

    for (const { line, item } of prepared) {
      const transactionId = postMovement({
        productId: item.product_id,
        warehouseId: item.warehouse_id,
        stockStatus: 'available',
        bizType: 'sale_out',
        bizId: order.id,
        bizNo: order.order_no,
        direction: -1,
        quantity: line.quantity,
        occurredAt,
      });
      transactionIds.push(transactionId);
      updateItem.run(line.quantity, occurredAt, item.id);
    }

    const status = recomputeOrderStatus(db, order.id);
    db.prepare('UPDATE sales_order SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      occurredAt,
      order.id,
    );

    return { orderId: order.id, status, transactionIds };
  })();
}

function recomputeOrderStatus(db: Db, orderId: number): SalesOrderStatus {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total_lines,
              SUM(CASE WHEN shipped_qty + cancelled_qty >= quantity THEN 1 ELSE 0 END) AS done_lines,
              COALESCE(SUM(shipped_qty), 0) AS shipped_sum
         FROM sales_order_item WHERE order_id = ?`,
    )
    .get(orderId) as { total_lines: number; done_lines: number; shipped_sum: number };

  if (agg.total_lines > 0 && agg.done_lines === agg.total_lines) return 'shipped';
  if (agg.shipped_sum > 0) return 'partial';
  return 'confirmed';
}

export interface SalesReturnResult {
  id: number;
  return_no: string;
  transactionIds: number[];
}

interface ReturnLineSource {
  order_item_id: number;
  product_id: number;
  warehouse_id: number;
  shipped_qty: number;
}

/**
 * 销售退货：创建即过账。可退量 = shipped_qty − 该行历史退货量（实时汇总，不落字段）。
 * 与采购退货（出库、自动结转）不对称：此处为入库，必须显式传入退货前均价，
 * 引擎按该均价重算后均价零漂移。退货不改变销售单状态。
 */
export function createSalesReturn(body: SalesReturnBody, userId: number | null): SalesReturnResult {
  const db = getDb();
  return db.transaction(() => {
    const order = loadOrder(db, body.orderId);
    if (!['confirmed', 'partial', 'shipped'].includes(order.status)) {
      throw new ApiError(409, '草稿或已取消的销售单没有可退货物');
    }

    const sourceStmt = db.prepare(
      `SELECT id AS order_item_id, product_id, warehouse_id, shipped_qty
         FROM sales_order_item WHERE id = ? AND order_id = ?`,
    );
    const returnedStmt = db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS qty FROM sales_return_item WHERE order_item_id = ?',
    );

    // claimed 按订单行累计，防止同一订单行重复提交时合计超过可退量（退货为入库，
    // 若绕过可退量会凭空增加库存）
    const claimed = new Map<number, number>();
    const prepared = body.lines.map((line) => {
      const source = sourceStmt.get(line.orderItemId, body.orderId) as ReturnLineSource | undefined;
      if (!source) throw new ApiError(400, '退货明细不属于该销售单');
      const alreadyReturned = (returnedStmt.get(source.order_item_id) as { qty: number }).qty;
      const returnable = source.shipped_qty - alreadyReturned;
      const claimedQty = (claimed.get(source.order_item_id) ?? 0) + line.quantity;
      if (claimedQty > returnable) {
        throw new ApiError(409, `退货数量超过可退量（可退 ${returnable}）`);
      }
      claimed.set(source.order_item_id, claimedQty);
      return { line, source };
    });

    const now = new Date().toISOString();
    const returnNo = nextDocNo(db, 'sales_return', body.returnDate);
    const headerInfo = db
      .prepare(
        `INSERT INTO sales_return
           (return_no, order_id, customer_id, return_date, total_amount, remark, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        returnNo,
        order.id,
        order.customer_id,
        body.returnDate,
        body.remark ?? null,
        userId,
        now,
        now,
      );
    const returnId = Number(headerInfo.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO sales_return_item
         (return_id, order_item_id, line_no, product_id, warehouse_id, quantity, unit_cost, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transactionIds: number[] = [];
    let totalAmount = 0;
    prepared.forEach(({ line, source }, index) => {
      const unitCost = readWarehouseCost(db, source.product_id, source.warehouse_id);
      const transactionId = postMovement({
        productId: source.product_id,
        warehouseId: source.warehouse_id,
        stockStatus: 'available',
        bizType: 'sale_return',
        bizId: returnId,
        bizNo: returnNo,
        direction: 1,
        quantity: line.quantity,
        unitCost,
        occurredAt: now,
      });
      transactionIds.push(transactionId);

      const amount = unitCost * line.quantity;
      totalAmount += amount;
      insertItem.run(
        returnId,
        source.order_item_id,
        index + 1,
        source.product_id,
        source.warehouse_id,
        line.quantity,
        unitCost,
        amount,
        now,
      );
    });

    db.prepare('UPDATE sales_return SET total_amount = ?, updated_at = ? WHERE id = ?').run(
      totalAmount,
      now,
      returnId,
    );

    return { id: returnId, return_no: returnNo, transactionIds };
  })();
}