import type {
  ItemMovementQuery,
  LedgerQuery,
  StockSnapshotQuery,
  SupplierLeadTimeQuery,
} from '@light-erp/shared';
import { getDb } from '../../db/connection';
import { RECEIPT_CTE, daysBetween, mean, round } from '../../lib/leadtime';
import type { PageInfo } from '../../lib/response';
import { businessDateOf, businessToday } from '../../lib/time';
import {
  normalizeAsOf,
  queryStockList,
  queryStockValueByDimension,
  queryTransactions,
  type QueryModeOptions,
} from '../inventory/stock.query';

type Row = Record<string, unknown>;

export interface ReportPaged {
  list: Row[];
  page: PageInfo;
  warnings: string[];
}

/** 导出（format=csv）时传 `{ all: true }`：跳过 LIMIT/OFFSET 与 JS 切片，返回全部命中行 */
export type ReportQueryOptions = QueryModeOptions;

// ---------- 通用工具 ----------

/** 缺省区间：本月 1 日 ~ 今日（按业务时区 UTC+8 取「日」，与 normalizeAsOf 一致） */
function defaultRange(dateFrom: string | undefined, dateTo: string | undefined): {
  from: string | null;
  to: string | null;
} {
  const today = businessToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  return {
    from: normalizeAsOf(dateFrom ?? monthStart, false),
    to: normalizeAsOf(dateTo ?? today, true),
  };
}

// ---------- IF-R1 进销存明细账 ----------

/**
 * 按「物料 × 仓库」统计区间收发。**排除 biz_type='status_change'**：
 * 状态转移成对写「出 + 入」，计入会让入库、出库两栏同时虚增而净额不变。
 * 金额用流水 unit_cost（分）结转。
 */
export function queryInventoryLedger(
  query: LedgerQuery,
  options: ReportQueryOptions = {},
): ReportPaged {
  const db = getDb();
  const { from, to } = defaultRange(query.dateFrom, query.dateTo);

  const inRange = `(@dateFrom IS NULL OR t.occurred_at >= @dateFrom)
      AND (@dateTo IS NULL OR t.occurred_at <= @dateTo)`;
  const beforeFrom = `@dateFrom IS NOT NULL AND t.occurred_at < @dateFrom`;

  const inner = `
    SELECT t.product_id, p.code AS product_code, p.name AS product_name,
           p.base_unit, p.qty_precision,
           t.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
           SUM(CASE WHEN ${beforeFrom} THEN t.direction * t.quantity ELSE 0 END) AS opening_qty,
           SUM(CASE WHEN t.direction = 1 AND ${inRange} THEN t.quantity ELSE 0 END) AS in_qty,
           SUM(CASE WHEN t.direction = -1 AND ${inRange} THEN t.quantity ELSE 0 END) AS out_qty,
           SUM(CASE WHEN ${beforeFrom} THEN t.direction * t.quantity * t.unit_cost ELSE 0 END) AS opening_amount,
           SUM(CASE WHEN t.direction = 1 AND ${inRange} THEN t.quantity * t.unit_cost ELSE 0 END) AS in_amount,
           SUM(CASE WHEN t.direction = -1 AND ${inRange} THEN t.quantity * t.unit_cost ELSE 0 END) AS out_amount
      FROM stock_transaction t
      JOIN item p ON p.id = t.product_id
      JOIN warehouse w ON w.id = t.warehouse_id
     WHERE t.biz_type <> 'status_change'
       AND (@keyword IS NULL OR p.code LIKE @keyword OR p.name LIKE @keyword)
       AND (@warehouseId IS NULL OR t.warehouse_id = @warehouseId)
       AND (@dateTo IS NULL OR t.occurred_at <= @dateTo)
     GROUP BY t.product_id, t.warehouse_id`;

  const params = {
    keyword: query.keyword ? `%${query.keyword}%` : null,
    warehouseId: query.warehouseId ?? null,
    dateFrom: from,
    dateTo: to,
  };
  const activeWhere = 'WHERE x.opening_qty <> 0 OR x.in_qty <> 0 OR x.out_qty <> 0';

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM (${inner}) x ${activeWhere}`)
    .get(params) as { total: number };

  const paging = options.all ? '' : 'LIMIT @limit OFFSET @offset';
  const rows = db
    .prepare(
      `SELECT * FROM (${inner}) x ${activeWhere}
        ORDER BY x.product_code, x.warehouse_code
        ${paging}`,
    )
    .all(
      options.all
        ? params
        : { ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
    ) as Record<
    string,
    number | string
  >[];

  const list: Row[] = rows.map((row) => {
    const openingQty = Number(row.opening_qty);
    const inQty = Number(row.in_qty);
    const outQty = Number(row.out_qty);
    const openingAmount = Number(row.opening_amount);
    const inAmount = Number(row.in_amount);
    const outAmount = Number(row.out_amount);
    return {
      ...row,
      opening_qty: openingQty,
      in_qty: inQty,
      out_qty: outQty,
      closing_qty: openingQty + inQty - outQty,
      opening_amount: openingAmount,
      in_amount: inAmount,
      out_amount: outAmount,
      closing_amount: openingAmount + inAmount - outAmount,
    };
  });

  const warnings: string[] = [];
  if (from) warnings.push(`统计区间：${from.slice(0, 10)} ~ ${to?.slice(0, 10) ?? '—'}`);
  return { list, page: { page: query.page, pageSize: query.pageSize, total }, warnings };
}

// ---------- IF-R2 库存现状表 ----------

/**
 * 复用库存口径清单（on_hand/frozen/qc/total_qty + reserved/in_transit/available/projected），
 * 追加金额列：
 *   - `stock_amount`：**按流水累计**的结存金额，与 IF-R1 明细账的「期末金额」同口径
 *     （对应 `total_qty`，不是 available 单桶）。历史时点也能算，只要给 `as_of`。
 *   - `avg_cost`：移动加权均价，仅作参考；历史时点不可还原，返回 null。
 *
 * 此前该列叫 `on_hand_amount = on_hand × avg_cost`，与明细账期末金额会差出几分到几十分
 * （均价逐笔取整的漂移），两张报表对同一状态给出不同金额，故改为流水累计口径。
 */
export function queryStockSnapshot(
  query: StockSnapshotQuery,
  options: ReportQueryOptions = {},
): ReportPaged {
  const result = queryStockList(
    {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      warehouseId: query.warehouseId,
      asOf: query.asOf,
    },
    options,
  );

  const db = getDb();
  const amounts = queryStockValueByDimension(db, result.asOf);
  const costs = new Map<string, number>(
    (
      db
        .prepare(
          'SELECT product_id, warehouse_id, MAX(avg_cost) AS avg_cost FROM stock_balance GROUP BY product_id, warehouse_id',
        )
        .all() as { product_id: number; warehouse_id: number; avg_cost: number }[]
    ).map((row) => [`${row.product_id}:${row.warehouse_id}`, row.avg_cost]),
  );

  const list: Row[] = result.list.map((row) => {
    const key = `${row.product_id}:${row.warehouse_id}`;
    return {
      ...row,
      avg_cost: result.asOf ? null : (costs.get(key) ?? 0),
      stock_amount: amounts.get(key) ?? 0,
    };
  });

  const warnings = [`port_stock_as_inventory=${result.portAsInventory}`];
  if (result.asOf) {
    warnings.push(
      `历史时点（${result.asOf.slice(0, 10)}）：on_hand / frozen / qc / total_qty 与 stock_amount 均按 stock_transaction 重算；reserved / in_transit / available / projected 依赖单据当时状态不可还原，返回 null；移动加权均价不可还原，avg_cost 为 null`,
    );
  }
  return { list, page: result.page, warnings };
}

// ---------- IF-R3 商品收发明细 ----------

/** 复用库存流水明细，追加金额列 amount = quantity × unit_cost */
export function queryItemMovement(
  query: ItemMovementQuery,
  options: ReportQueryOptions = {},
): ReportPaged {
  const result = queryTransactions(
    {
      page: query.page,
      pageSize: query.pageSize,
      productId: query.productId,
      warehouseId: query.warehouseId,
      stockStatus: query.stockStatus,
      bizType: query.bizType,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    },
    options,
  );

  const list: Row[] = result.list.map((row) => ({
    ...row,
    amount: row.quantity * row.unit_cost,
  }));
  return { list, page: result.page, warnings: [] };
}

// ---------- IF-R4 供应商提前期分析 ----------

interface SupplierLeadTimeRow {
  supplier_code: string;
  supplier_name: string;
  order_count: number;
  line_count: number;
  received_line_count: number;
  avg_lead_time_days: number | null;
  min_lead_time_days: number | null;
  max_lead_time_days: number | null;
  avg_promised_lead_time_days: number | null;
  on_time_rate: number | null;
  last_order_date: string | null;
}

/**
 * 全供应商提前期聚合（整单口径）。仅统计有到货记录（biz_type='purchase_in'）的供应商；
 * 实际到货时刻取整单 MIN/MAX occurred_at（流水无行号）。
 */
export function querySupplierLeadTime(
  query: SupplierLeadTimeQuery,
  options: ReportQueryOptions = {},
): ReportPaged {
  const db = getDb();
  const params = {
    keyword: query.keyword ? `%${query.keyword}%` : null,
    dateFrom: query.dateFrom ?? null,
    dateTo: query.dateTo ?? null,
  };

  const orders = db
    .prepare(
      `${RECEIPT_CTE}
       SELECT o.id, o.supplier_id, s.code AS supplier_code, s.name AS supplier_name,
              o.order_date, r.last_received_at, a.max_promised_date
         FROM purchase_order o
         JOIN receipts r ON r.order_id = o.id
         JOIN order_agg a ON a.order_id = o.id
         JOIN partner s ON s.id = o.supplier_id
        WHERE (@keyword IS NULL OR s.code LIKE @keyword OR s.name LIKE @keyword)
          AND (@dateFrom IS NULL OR o.order_date >= @dateFrom)
          AND (@dateTo IS NULL OR o.order_date <= @dateTo)
        ORDER BY s.code, o.order_date`,
    )
    .all(params) as {
    id: number;
    supplier_id: number;
    supplier_code: string;
    supplier_name: string;
    order_date: string;
    last_received_at: string;
    max_promised_date: string;
  }[];

  // 行数统计：按供应商汇总其订单的全部表体行
  const lineStats = new Map<number, { lineCount: number; receivedLineCount: number }>();
  const orderIds = orders.map((row) => row.id);
  if (orderIds.length > 0) {
    const rows = db
      .prepare(
        `SELECT o.supplier_id AS supplier_id, COUNT(*) AS line_count,
                SUM(CASE WHEN i.received_qty > 0 THEN 1 ELSE 0 END) AS received_line_count
           FROM purchase_order_item i
           JOIN purchase_order o ON o.id = i.order_id
          WHERE i.order_id IN (${orderIds.map(() => '?').join(', ')})
          GROUP BY o.supplier_id`,
      )
      .all(...orderIds) as {
      supplier_id: number;
      line_count: number;
      received_line_count: number;
    }[];
    for (const row of rows) {
      lineStats.set(row.supplier_id, {
        lineCount: row.line_count,
        receivedLineCount: row.received_line_count,
      });
    }
  }

  const grouped = new Map<number, SupplierLeadTimeRow>();
  for (const row of orders) {
    const key = row.supplier_id;
    let entry = grouped.get(key);
    if (!entry) {
      const stats = lineStats.get(key) ?? { lineCount: 0, receivedLineCount: 0 };
      entry = {
        supplier_code: row.supplier_code,
        supplier_name: row.supplier_name,
        order_count: 0,
        line_count: stats.lineCount,
        received_line_count: stats.receivedLineCount,
        avg_lead_time_days: null,
        min_lead_time_days: null,
        max_lead_time_days: null,
        avg_promised_lead_time_days: null,
        on_time_rate: null,
        last_order_date: null,
      };
      grouped.set(key, entry);
      (entry as SupplierLeadTimeRow & { _leadTimes?: number[]; _promised?: number[]; _onTime?: number })._leadTimes = [];
      (entry as SupplierLeadTimeRow & { _leadTimes?: number[]; _promised?: number[]; _onTime?: number })._promised = [];
      (entry as SupplierLeadTimeRow & { _leadTimes?: number[]; _promised?: number[]; _onTime?: number })._onTime = 0;
    }
    const bag = entry as SupplierLeadTimeRow & {
      _leadTimes: number[];
      _promised: number[];
      _onTime: number;
    };
    const receivedDay = businessDateOf(row.last_received_at);
    bag.order_count += 1;
    bag._leadTimes.push(daysBetween(row.order_date, receivedDay));
    bag._promised.push(daysBetween(row.order_date, row.max_promised_date));
    if (receivedDay <= row.max_promised_date) bag._onTime += 1;
    if (bag.last_order_date === null || row.order_date > bag.last_order_date) {
      bag.last_order_date = row.order_date;
    }
  }

  const suppliers: SupplierLeadTimeRow[] = [];
  for (const entry of grouped.values()) {
    const bag = entry as SupplierLeadTimeRow & {
      _leadTimes: number[];
      _promised: number[];
      _onTime: number;
    };
    bag.avg_lead_time_days = mean(bag._leadTimes);
    bag.min_lead_time_days = bag._leadTimes.length > 0 ? Math.min(...bag._leadTimes) : null;
    bag.max_lead_time_days = bag._leadTimes.length > 0 ? Math.max(...bag._leadTimes) : null;
    bag.avg_promised_lead_time_days = mean(bag._promised);
    bag.on_time_rate = bag.order_count > 0 ? round(bag._onTime / bag.order_count, 4) : null;
    delete (bag as { _leadTimes?: number[] })._leadTimes;
    delete (bag as { _promised?: number[] })._promised;
    delete (bag as { _onTime?: number })._onTime;
    suppliers.push(bag);
  }
  suppliers.sort((a, b) => a.supplier_code.localeCompare(b.supplier_code));

  const total = suppliers.length;
  const list = (
    options.all
      ? suppliers
      : suppliers.slice((query.page - 1) * query.pageSize, (query.page - 1) * query.pageSize + query.pageSize)
  ) as unknown as Row[];
  return { list, page: { page: query.page, pageSize: query.pageSize, total }, warnings: [] };
}