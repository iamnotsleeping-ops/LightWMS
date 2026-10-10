import type { PurchaseInboundBody, PurchaseOrderStatus, PurchaseReturnBody } from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { nextDocNo } from '../../lib/doc-no';
import { ApiError } from '../../lib/response';
import { postMovement, readBalanceByStatus } from '../inventory/stock.engine';

export interface InboundResult {
  orderId: number;
  status: PurchaseOrderStatus;
  transactionIds: number[];
}

interface InboundLineDb {
  id: number;
  product_id: number;
  warehouse_id: number;
  quantity: number;
  unit_price: number;
  received_qty: number;
  cancelled_qty: number;
  inspection_required: number;
}

function loadOrder(
  db: Db,
  id: number,
): { id: number; order_no: string; supplier_id: number; status: PurchaseOrderStatus } {
  const row = db
    .prepare('SELECT id, order_no, supplier_id, status FROM purchase_order WHERE id = ?')
    .get(id) as
    | { id: number; order_no: string; supplier_id: number; status: PurchaseOrderStatus }
    | undefined;
  if (!row) throw new ApiError(404, '采购单不存在');
  return row;
}

/**
 * 行级直接入库：一个事务内 校验 → 逐行写 purchase_in 流水 → 累加 received_qty → 推进单据状态。
 * stockStatus 由物料 inspection_required 决定：需检验的落 qc，否则落 available。
 */
export function receivePurchase(body: PurchaseInboundBody, _userId: number | null): InboundResult {
  const db = getDb();
  return db.transaction(() => {
    const order = loadOrder(db, body.orderId);
    if (order.status !== 'confirmed' && order.status !== 'partial') {
      throw new ApiError(409, `采购单当前状态「${order.status}」不可入库`);
    }

    const itemStmt = db.prepare(
      `SELECT i.id, i.product_id, i.warehouse_id, i.quantity, i.unit_price, i.received_qty,
              i.cancelled_qty, p.inspection_required
         FROM purchase_order_item i JOIN item p ON p.id = i.product_id
        WHERE i.id = ? AND i.order_id = ?`,
    );

    // 先整体校验，任一行不合法则整单不入库。
    // claimed 按订单行累计本请求已提交量：数量上限取自库中快照，若不在请求内累计，
    // 同一订单行重复出现时每一行都会独立通过校验而合计超收。
    const claimed = new Map<number, number>();
    const prepared = body.lines.map((line) => {
      const item = itemStmt.get(line.orderItemId, body.orderId) as InboundLineDb | undefined;
      if (!item) throw new ApiError(400, '入库明细不属于该采购单');
      const inTransit = item.quantity - item.received_qty - item.cancelled_qty;
      const claimedQty = (claimed.get(item.id) ?? 0) + line.quantity;
      if (claimedQty > inTransit) {
        throw new ApiError(409, `入库数量超过在途量（在途 ${inTransit}）`);
      }
      claimed.set(item.id, claimedQty);
      return { line, item };
    });

    const occurredAt = body.occurredAt ?? new Date().toISOString();
    const transactionIds: number[] = [];
    const updateItem = db.prepare(
      'UPDATE purchase_order_item SET received_qty = received_qty + ?, updated_at = ? WHERE id = ?',
    );

    for (const { line, item } of prepared) {
      const transactionId = postMovement({
        productId: item.product_id,
        warehouseId: item.warehouse_id,
        stockStatus: item.inspection_required === 1 ? 'qc' : 'available',
        bizType: 'purchase_in',
        bizId: order.id,
        bizNo: order.order_no,
        // 行级归属：IF-5 的"该行首次/最后到货时刻"由它还原（整单口径会把同单其它行的迟到摊过来）
        bizLineId: item.id,
        direction: 1,
        quantity: line.quantity,
        unitCost: item.unit_price,
        occurredAt,
      });
      transactionIds.push(transactionId);
      updateItem.run(line.quantity, occurredAt, item.id);
    }

    const status = recomputeOrderStatus(db, order.id);
    db.prepare('UPDATE purchase_order SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      occurredAt,
      order.id,
    );

    return { orderId: order.id, status, transactionIds };
  })();
}

function recomputeOrderStatus(db: Db, orderId: number): PurchaseOrderStatus {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total_lines,
              SUM(CASE WHEN received_qty + cancelled_qty >= quantity THEN 1 ELSE 0 END) AS done_lines,
              COALESCE(SUM(received_qty), 0) AS received_sum
         FROM purchase_order_item WHERE order_id = ?`,
    )
    .get(orderId) as { total_lines: number; done_lines: number; received_sum: number };

  if (agg.total_lines > 0 && agg.done_lines === agg.total_lines) return 'received';
  if (agg.received_sum > 0) return 'partial';
  return 'confirmed';
}

export interface PurchaseReturnResult {
  id: number;
  return_no: string;
  transactionIds: number[];
}

interface ReturnLineSource {
  order_item_id: number;
  product_id: number;
  warehouse_id: number;
  received_qty: number;
}

/**
 * 采购退货：创建即过账。可退量 = received_qty − 该行历史退货量（实时汇总，不落字段）；
 * 源仓可用量不足则拒绝（质检未放行的货不可退）。退货不改变采购单状态。
 */
export function createPurchaseReturn(body: PurchaseReturnBody, userId: number | null): PurchaseReturnResult {
  const db = getDb();
  return db.transaction(() => {
    const order = loadOrder(db, body.orderId);
    if (!['confirmed', 'partial', 'received'].includes(order.status)) {
      throw new ApiError(409, '草稿或已取消的采购单没有可退货物');
    }

    const sourceStmt = db.prepare(
      `SELECT id AS order_item_id, product_id, warehouse_id, received_qty
         FROM purchase_order_item WHERE id = ? AND order_id = ?`,
    );
    const returnedStmt = db.prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS qty FROM purchase_return_item WHERE order_item_id = ?',
    );

    // 校验可退量与源仓可用量；同 (物料, 仓库) 的请求量合并后再比对，避免多行叠加超标。
    // claimed 按订单行累计，防止同一订单行重复提交时合计超过可退量。
    const claimed = new Map<number, number>();
    const requested = new Map<string, number>();
    const prepared = body.lines.map((line) => {
      const source = sourceStmt.get(line.orderItemId, body.orderId) as ReturnLineSource | undefined;
      if (!source) throw new ApiError(400, '退货明细不属于该采购单');
      const alreadyReturned = (returnedStmt.get(source.order_item_id) as { qty: number }).qty;
      const returnable = source.received_qty - alreadyReturned;
      const claimedQty = (claimed.get(source.order_item_id) ?? 0) + line.quantity;
      if (claimedQty > returnable) {
        throw new ApiError(409, `退货数量超过可退量（可退 ${returnable}）`);
      }
      claimed.set(source.order_item_id, claimedQty);
      const key = `${source.product_id}:${source.warehouse_id}`;
      requested.set(key, (requested.get(key) ?? 0) + line.quantity);
      return { line, source };
    });

    for (const [key, qty] of requested) {
      const [productId, warehouseId] = key.split(':').map(Number);
      const available = readBalanceByStatus(db, productId, warehouseId).available;
      if (available < qty) {
        throw new ApiError(409, '源仓库可用库存不足，质检中的货物请先做质检放行');
      }
    }

    const now = new Date().toISOString();
    const returnNo = nextDocNo(db, 'purchase_return', body.returnDate);
    const headerInfo = db
      .prepare(
        `INSERT INTO purchase_return
           (return_no, order_id, supplier_id, return_date, total_amount, remark, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        returnNo,
        order.id,
        order.supplier_id,
        body.returnDate,
        body.remark ?? null,
        userId,
        now,
        now,
      );
    const returnId = Number(headerInfo.lastInsertRowid);

    const unitCostStmt = db.prepare('SELECT unit_cost FROM stock_transaction WHERE id = ?');
    const insertItem = db.prepare(
      `INSERT INTO purchase_return_item
         (return_id, order_item_id, line_no, product_id, warehouse_id, quantity, unit_cost, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transactionIds: number[] = [];
    let totalAmount = 0;
    prepared.forEach(({ line, source }, index) => {
      const transactionId = postMovement({
        productId: source.product_id,
        warehouseId: source.warehouse_id,
        stockStatus: 'available',
        bizType: 'purchase_return',
        bizId: returnId,
        bizNo: returnNo,
        // 退货归属到**被退的那条采购单行**，保持行级血缘
        bizLineId: source.order_item_id,
        direction: -1,
        quantity: line.quantity,
      });
      transactionIds.push(transactionId);

      const unitCost = (unitCostStmt.get(transactionId) as { unit_cost: number }).unit_cost;
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

    db.prepare('UPDATE purchase_return SET total_amount = ?, updated_at = ? WHERE id = ?').run(
      totalAmount,
      now,
      returnId,
    );

    return { id: returnId, return_no: returnNo, transactionIds };
  })();
}