import { ALLOWED_STATUS_TRANSITIONS } from '@light-erp/shared';
import type { BizType, StockStatus } from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { ApiError } from '../../lib/response';

export interface MovementInput {
  productId: number;
  warehouseId: number;
  stockStatus: StockStatus;
  bizType: BizType;
  bizId?: number | null;
  bizNo?: string | null;
  /**
   * 业务**单据行**的 id（采购入库 = purchase_order_item.id）。
   *
   * 账本原先只有单据级归属，导致"实际到货时刻"只能按整单还原，做不到料号级提前期。
   * 目前仅采购入库 / 采购退货填充；其它业务类型与**全部存量行**为 NULL（不回填、不猜）。
   */
  bizLineId?: number | null;
  /** 1 入库 / -1 出库；quantity 恒为正数 */
  direction: 1 | -1;
  quantity: number;
  /** 入库单位成本（分）。出库忽略此值，改用当前移动加权平均成本 */
  unitCost?: number;
  occurredAt?: string;
}

export interface StatusChangeInput {
  productId: number;
  warehouseId: number;
  fromStatus: StockStatus;
  toStatus: StockStatus;
  quantity: number;
  occurredAt?: string;
}

/**
 * 该物料在该仓库的成本（分）。成本按 (物料, 仓库) 维度，不区分库存状态。
 *
 * `postMovement` 会把同一 (物料, 仓库) 的三条状态行 `avg_cost` 一并刷新（见文末的
 * 全仓库 UPDATE），因此三者本应始终相等。这里用 `MAX` 而非 `LIMIT 1` 取值：
 * 一旦将来出现部分更新导致三者不一致，返回结果仍是确定的，而不是取决于行序。
 * （`stock.query.ts` 与 `report.service.ts` 也统一用 `MAX(avg_cost)`。）
 */
export function readWarehouseCost(db: Db, productId: number, warehouseId: number): number {
  const row = db
    .prepare(
      'SELECT MAX(avg_cost) AS avg_cost FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
    )
    .get(productId, warehouseId) as { avg_cost: number | null };
  return row.avg_cost ?? 0;
}

/** 该物料在该仓库的全部状态数量之和 */
export function readWarehouseQuantity(db: Db, productId: number, warehouseId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
    )
    .get(productId, warehouseId) as { qty: number };
  return row.qty;
}

/** 该物料在该仓库各状态的现有量；缺失状态补 0 */
export function readBalanceByStatus(
  db: Db,
  productId: number,
  warehouseId: number,
): Record<StockStatus, number> {
  const rows = db
    .prepare(
      'SELECT stock_status, quantity FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
    )
    .all(productId, warehouseId) as { stock_status: StockStatus; quantity: number }[];
  const result: Record<StockStatus, number> = { available: 0, frozen: 0, qc: 0 };
  for (const row of rows) result[row.stock_status] = row.quantity;
  return result;
}

function upsertBalance(
  db: Db,
  params: {
    productId: number;
    warehouseId: number;
    stockStatus: StockStatus;
    delta: number;
    avgCost: number;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO stock_balance (product_id, warehouse_id, stock_status, quantity, avg_cost, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (product_id, warehouse_id, stock_status)
     DO UPDATE SET quantity = quantity + excluded.quantity,
                   avg_cost = excluded.avg_cost,
                   updated_at = excluded.updated_at`,
  ).run(
    params.productId,
    params.warehouseId,
    params.stockStatus,
    params.delta,
    params.avgCost,
    params.now,
  );
}

/**
 * 写一笔库存流水并同步余额。
 * 入库按移动加权平均重算成本，出库按当前成本结转；status_change 只搬移数量、不重算成本。
 */
export function postMovement(input: MovementInput): number {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new ApiError(400, '数量必须为正整数');
  }

  const db = getDb();
  return db.transaction(() => {
    const now = input.occurredAt ?? new Date().toISOString();
    const qtyBefore = readWarehouseQuantity(db, input.productId, input.warehouseId);
    const costBefore = readWarehouseCost(db, input.productId, input.warehouseId);

    const recalcCost = input.direction === 1 && input.bizType !== 'status_change';
    const unitCost = recalcCost ? (input.unitCost ?? 0) : costBefore;

    const totalQty = qtyBefore + input.direction * input.quantity;
    const avgCost = recalcCost
      ? totalQty > 0
        ? Math.round((qtyBefore * costBefore + input.quantity * unitCost) / totalQty)
        : unitCost
      : costBefore;

    const info = db
      .prepare(
        `INSERT INTO stock_transaction
           (product_id, warehouse_id, stock_status, biz_type, biz_id, biz_no, biz_line_id,
            direction, quantity, unit_cost, occurred_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.productId,
        input.warehouseId,
        input.stockStatus,
        input.bizType,
        input.bizId ?? null,
        input.bizNo ?? null,
        input.bizLineId ?? null,
        input.direction,
        input.quantity,
        unitCost,
        now,
        now,
      );

    upsertBalance(db, {
      productId: input.productId,
      warehouseId: input.warehouseId,
      stockStatus: input.stockStatus,
      delta: input.direction * input.quantity,
      avgCost,
      now,
    });

    if (recalcCost) {
      db.prepare(
        'UPDATE stock_balance SET avg_cost = ?, updated_at = ? WHERE product_id = ? AND warehouse_id = ?',
      ).run(avgCost, now, input.productId, input.warehouseId);
    }

    return Number(info.lastInsertRowid);
  })();
}

function isTransitionAllowed(from: StockStatus, to: StockStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS.some((pair) => pair.from === from && pair.to === to);
}

/**
 * 库存状态转移：同一事务内写两笔 status_change 流水（出 + 入），只搬移数量，不重算成本。
 */
export function changeStockStatus(input: StatusChangeInput): number[] {
  if (input.fromStatus === input.toStatus) {
    throw new ApiError(400, '来源状态与目标状态不能相同');
  }
  if (!isTransitionAllowed(input.fromStatus, input.toStatus)) {
    throw new ApiError(409, `不允许从「${input.fromStatus}」转移到「${input.toStatus}」`);
  }

  const db = getDb();
  return db.transaction(() => {
    const balances = readBalanceByStatus(db, input.productId, input.warehouseId);
    if (balances[input.fromStatus] < input.quantity) {
      throw new ApiError(409, '来源状态的库存数量不足');
    }
    const shared = {
      productId: input.productId,
      warehouseId: input.warehouseId,
      bizType: 'status_change' as const,
      quantity: input.quantity,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    };
    const outId = postMovement({ ...shared, stockStatus: input.fromStatus, direction: -1 });
    const inId = postMovement({ ...shared, stockStatus: input.toStatus, direction: 1 });
    return [outId, inId];
  })();
}