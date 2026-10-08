import type { BalanceQuery, InventoryQuery, StockTransactionQuery } from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { config } from '../../config/index';
import type { PageInfo } from '../../lib/response';

export interface StockRow {
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  warehouse_type: string;
  on_hand: number;
  frozen: number;
  reserved: number | null;
  in_transit: number | null;
  available: number | null;
  projected: number | null;
}

export interface BalanceRow {
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  warehouse_type: string;
  available_qty: number;
  frozen_qty: number;
  qc_qty: number;
  total_qty: number;
  avg_cost: number;
  updated_at: string;
}

export interface TransactionRow {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  stock_status: string;
  biz_type: string;
  biz_id: number | null;
  biz_no: string | null;
  direction: number;
  quantity: number;
  unit_cost: number;
  occurred_at: string;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

/** 读取港口仓库存口径参数，缺失时回退到环境默认值 */
export function readPortStockAsInventory(db: Db): boolean {
  const row = db
    .prepare("SELECT value FROM sys_param WHERE key = 'port_stock_as_inventory'")
    .get() as { value: string } | undefined;
  if (!row) return config.defaults.portStockAsInventory;
  return row.value === 'true' || row.value === '1';
}

/** YYYY-MM-DD 归一为当日末刻，ISO 原样返回；未传返回 null */
export function normalizeAsOf(value: string | undefined, endOfDay: boolean): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`;
  }
  return value;
}

interface QueryFilters {
  keyword?: string;
  productId?: number;
  warehouseId?: number;
}

function filterClause(alias: string): string {
  return `(@keyword IS NULL OR ${alias}.code LIKE @keyword OR ${alias}.name LIKE @keyword)
      AND (@productId IS NULL OR ${alias}.id = @productId)
      AND (@warehouseId IS NULL OR w.id = @warehouseId)`;
}

function filterParams(filters: QueryFilters): Record<string, unknown> {
  return {
    keyword: filters.keyword ? `%${filters.keyword}%` : null,
    productId: filters.productId ?? null,
    warehouseId: filters.warehouseId ?? null,
  };
}

/**
 * 库存口径清单。当前时点读 stock_balance；指定 as_of 时从 stock_transaction 重算。
 * reserved / in_transit 是单据派生量，历史时点无法还原，仅在当前时点返回。
 */
export function queryStockList(query: InventoryQuery): Paged<StockRow> & { portAsInventory: boolean; asOf: string | null } {
  const db = getDb();
  const portAsInventory = readPortStockAsInventory(db);
  const asOf = normalizeAsOf(query.asOf, true);

  const physical = asOf
    ? `SELECT product_id, warehouse_id, stock_status, SUM(quantity * direction) AS qty
         FROM stock_transaction WHERE occurred_at <= @asOf
        GROUP BY product_id, warehouse_id, stock_status
       HAVING SUM(quantity * direction) <> 0`
    : `SELECT product_id, warehouse_id, stock_status, quantity AS qty
         FROM stock_balance WHERE quantity <> 0`;

  const emptyCte = 'SELECT NULL AS product_id, NULL AS warehouse_id, NULL AS qty WHERE 0';
  const reservedCte = asOf
    ? emptyCte
    : `SELECT i.product_id, i.warehouse_id, SUM(i.quantity - i.shipped_qty - i.cancelled_qty) AS qty
         FROM sales_order_item i JOIN sales_order o ON o.id = i.order_id
        WHERE o.status IN ('confirmed', 'partial')
        GROUP BY i.product_id, i.warehouse_id
       HAVING SUM(i.quantity - i.shipped_qty - i.cancelled_qty) <> 0`;
  const purchaseTransitCte = asOf
    ? emptyCte
    : `SELECT i.product_id, i.warehouse_id, SUM(i.quantity - i.received_qty - i.cancelled_qty) AS qty
         FROM purchase_order_item i JOIN purchase_order o ON o.id = i.order_id
        WHERE o.status IN ('confirmed', 'partial')
        GROUP BY i.product_id, i.warehouse_id
       HAVING SUM(i.quantity - i.received_qty - i.cancelled_qty) <> 0`;
  const transferTransitCte = asOf
    ? emptyCte
    : `SELECT i.product_id, o.to_warehouse_id AS warehouse_id, SUM(i.shipped_qty - i.received_qty) AS qty
         FROM transfer_order_item i JOIN transfer_order o ON o.id = i.order_id
        WHERE o.status = 'shipped'
        GROUP BY i.product_id, o.to_warehouse_id
       HAVING SUM(i.shipped_qty - i.received_qty) <> 0`;

  const cte = `
    WITH physical AS (${physical}),
    agg AS (
      SELECT product_id, warehouse_id,
             SUM(CASE WHEN stock_status = 'available' THEN qty ELSE 0 END) AS on_hand,
             SUM(CASE WHEN stock_status IN ('frozen', 'qc') THEN qty ELSE 0 END) AS frozen
        FROM physical GROUP BY product_id, warehouse_id
    ),
    reserved AS (${reservedCte}),
    purchase_transit AS (${purchaseTransitCte}),
    transfer_transit AS (${transferTransitCte}),
    transit AS (
      SELECT product_id, warehouse_id, SUM(qty) AS qty
        FROM (SELECT * FROM purchase_transit UNION ALL SELECT * FROM transfer_transit)
       GROUP BY product_id, warehouse_id
    ),
    keys AS (
      SELECT product_id, warehouse_id FROM agg
      UNION SELECT product_id, warehouse_id FROM reserved
      UNION SELECT product_id, warehouse_id FROM purchase_transit
      UNION SELECT product_id, warehouse_id FROM transfer_transit
    )`;

  const joins = `
    FROM keys k
    JOIN item p ON p.id = k.product_id
    JOIN warehouse w ON w.id = k.warehouse_id
    LEFT JOIN agg a ON a.product_id = k.product_id AND a.warehouse_id = k.warehouse_id
    LEFT JOIN reserved r ON r.product_id = k.product_id AND r.warehouse_id = k.warehouse_id
    LEFT JOIN transit t ON t.product_id = k.product_id AND t.warehouse_id = k.warehouse_id`;

  const where = `
    WHERE (@portAsInventory = 1 OR w.type <> 'port')
      AND (@keyword IS NULL OR p.code LIKE @keyword OR p.name LIKE @keyword)
      AND (@productId IS NULL OR k.product_id = @productId)
      AND (@warehouseId IS NULL OR k.warehouse_id = @warehouseId)`;

  const params: Record<string, unknown> = {
    portAsInventory: portAsInventory ? 1 : 0,
    keyword: query.keyword ? `%${query.keyword}%` : null,
    productId: query.productId ?? null,
    warehouseId: query.warehouseId ?? null,
    ...(asOf ? { asOf } : {}),
  };

  const total = (
    db.prepare(`${cte} SELECT COUNT(*) AS total ${joins} ${where}`).get(params) as { total: number }
  ).total;

  const rows = db
    .prepare(
      `${cte}
       SELECT k.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              k.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              w.type AS warehouse_type,
              COALESCE(a.on_hand, 0) AS on_hand,
              COALESCE(a.frozen, 0) AS frozen,
              COALESCE(r.qty, 0) AS reserved,
              COALESCE(t.qty, 0) AS in_transit
       ${joins} ${where}
       ORDER BY p.code, w.code
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize }) as {
    product_id: number;
    product_code: string;
    product_name: string;
    base_unit: string;
    qty_precision: number;
    warehouse_id: number;
    warehouse_code: string;
    warehouse_name: string;
    warehouse_type: string;
    on_hand: number;
    frozen: number;
    reserved: number;
    in_transit: number;
  }[];

  const list: StockRow[] = rows.map((row) => {
    if (asOf) {
      return { ...row, reserved: null, in_transit: null, available: null, projected: null };
    }
    return {
      ...row,
      available: row.on_hand - row.reserved,
      projected: row.on_hand + row.in_transit - row.reserved,
    };
  });

  return {
    list,
    page: { page: query.page, pageSize: query.pageSize, total },
    portAsInventory,
    asOf,
  };
}

/** 底层余额明细：按 物料 × 仓库 展开三状态数量与成本，供状态管理页使用 */
export function queryBalances(query: BalanceQuery): BalanceRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT b.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              w.type AS warehouse_type,
              SUM(CASE WHEN b.stock_status = 'available' THEN b.quantity ELSE 0 END) AS available_qty,
              SUM(CASE WHEN b.stock_status = 'frozen' THEN b.quantity ELSE 0 END) AS frozen_qty,
              SUM(CASE WHEN b.stock_status = 'qc' THEN b.quantity ELSE 0 END) AS qc_qty,
              SUM(b.quantity) AS total_qty,
              MAX(b.avg_cost) AS avg_cost,
              MAX(b.updated_at) AS updated_at
         FROM stock_balance b
         JOIN item p ON p.id = b.product_id
         JOIN warehouse w ON w.id = b.warehouse_id
        WHERE ${filterClause('p')}
        GROUP BY b.product_id, b.warehouse_id
       HAVING SUM(b.quantity) <> 0
        ORDER BY p.code, w.code`,
    )
    .all(filterParams(query)) as BalanceRow[];
}

export function queryTransactions(query: StockTransactionQuery): Paged<TransactionRow> {
  const db = getDb();
  const dateFrom = normalizeAsOf(query.dateFrom, false);
  const dateTo = normalizeAsOf(query.dateTo, true);

  const where = `
    WHERE (@productId IS NULL OR t.product_id = @productId)
      AND (@warehouseId IS NULL OR t.warehouse_id = @warehouseId)
      AND (@stockStatus IS NULL OR t.stock_status = @stockStatus)
      AND (@bizType IS NULL OR t.biz_type = @bizType)
      AND (@dateFrom IS NULL OR t.occurred_at >= @dateFrom)
      AND (@dateTo IS NULL OR t.occurred_at <= @dateTo)`;

  const params = {
    productId: query.productId ?? null,
    warehouseId: query.warehouseId ?? null,
    stockStatus: query.stockStatus ?? null,
    bizType: query.bizType ?? null,
    dateFrom,
    dateTo,
  };

  const total = (
    db.prepare(`SELECT COUNT(*) AS total FROM stock_transaction t ${where}`).get(params) as {
      total: number;
    }
  ).total;

  const list = db
    .prepare(
      `SELECT t.id, t.product_id, p.code AS product_code, p.name AS product_name,
              p.base_unit, p.qty_precision,
              t.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              t.stock_status, t.biz_type, t.biz_id, t.biz_no,
              t.direction, t.quantity, t.unit_cost, t.occurred_at
         FROM stock_transaction t
         JOIN item p ON p.id = t.product_id
         JOIN warehouse w ON w.id = t.warehouse_id
         ${where}
        ORDER BY t.occurred_at DESC, t.id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize }) as TransactionRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}