import type {
  ItemMovementQuery,
  LedgerQuery,
  StockSnapshotQuery,
  SubstituteUsageQuery,
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

// ---------- IF-R5 替代料使用 / 呆滞 ----------

/**
 * 呆滞阈值（自然日）：距最后一次替代使用达到该天数即判为呆滞。
 * 独立导出以便前后端 / 文档统一引用，避免 90 这个数字散落。
 */
export const SUBSTITUTE_IDLE_DAYS = 90;

type SubstituteUsageRow = {
  item_code: string;
  item_name: string;
  base_unit: string;
  substitution_count: number;
  total_sub_qty: number;
  last_used_at: string | null;
  idle_days: number | null;
  is_idle: 0 | 1;
};

/**
 * 替代料使用 / 呆滞分析（IF-R5），一行一个**替代料物料**。
 *
 * 数据源：`item_substitute` 的去重替代料 ∪ `item_substitute_log` 出现过的替代料，
 * 再 LEFT JOIN 日志聚合。之所以从左连接而不是只扫日志：
 *   - 「配了替代关系但从未真正用过」的物料必须出现在报表里（substitution_count = 0），
 *     否则最该关注的呆滞项恰恰会消失；这类行只能来自 `item_substitute`。
 *   - 反过来，日志是「确实用过」的唯一权威记录：替代关系后来被删 / 停用时，
 *     历史使用痕迹不应随之丢失，故日志里出现过的替代料也独立成行。
 *   两张表都取并集后，报表既不漏「未用过」，也不漏「用过但关系已撤」。
 *
 * 区间语义：`dateFrom` / `dateTo` 按业务日（UTC+8）边界过滤日志 `created_at`，
 * 三个聚合列（count / total / last_used_at）都只统计区间内的日志 —— 与明细账「统计区间」
 * 口径一致。因此缩小 / 挪动区间会同时改变呆滞判定（区间内最后一次使用），
 * 服务层会就此给出告警。
 *
 * 呆滞判定用业务日（UTC+8）：`idle_days` 为「最后一次使用的业务日 → 今日业务日」的自然日差，
 * 从未使用为 null；`is_idle` 对「从未使用」与「idle_days ≥ SUBSTITUTE_IDLE_DAYS」都为 1。
 */
export function querySubstituteUsage(
  query: SubstituteUsageQuery,
  options: ReportQueryOptions = {},
): ReportPaged {
  const db = getDb();
  const from = normalizeAsOf(query.dateFrom, false);
  const to = normalizeAsOf(query.dateTo, true);

  const rows = db
    .prepare(
      `WITH sub_items AS (
         SELECT sub_item_id AS item_id FROM item_substitute
         UNION
         SELECT sub_item_id AS item_id FROM item_substitute_log
       ),
       usage AS (
         SELECT l.sub_item_id AS item_id,
                COUNT(*) AS substitution_count,
                SUM(l.sub_actual_qty) AS total_sub_qty
           FROM item_substitute_log l
          WHERE (@dateFrom IS NULL OR l.created_at >= @dateFrom)
            AND (@dateTo IS NULL OR l.created_at <= @dateTo)
          GROUP BY l.sub_item_id
       ),
       -- 呆滞判定必须看「全部历史」的最后一次使用：若也按区间取 MAX，
       -- 任何区间过滤都会把区间外用过的替代料显示成"从未使用"，90 天口径随即失真。
       last_usage AS (
         SELECT l.sub_item_id AS item_id, MAX(l.created_at) AS last_used_at
           FROM item_substitute_log l
          GROUP BY l.sub_item_id
       )
       SELECT i.code AS item_code, i.name AS item_name, i.base_unit,
              COALESCE(u.substitution_count, 0) AS substitution_count,
              COALESCE(u.total_sub_qty, 0) AS total_sub_qty,
              lu.last_used_at AS last_used_at
         FROM sub_items s
         JOIN item i ON i.id = s.item_id
         LEFT JOIN usage u ON u.item_id = s.item_id
         LEFT JOIN last_usage lu ON lu.item_id = s.item_id
        WHERE (@keyword IS NULL OR i.code LIKE @keyword OR i.name LIKE @keyword)`,
    )
    .all({
      keyword: query.keyword ? `%${query.keyword}%` : null,
      dateFrom: from,
      dateTo: to,
    }) as Omit<SubstituteUsageRow, 'idle_days' | 'is_idle'>[];

  const today = businessToday();
  const enriched: SubstituteUsageRow[] = rows.map((row) => {
    // 呆滞按业务日算：先取最后一次使用的业务日，再与今日业务日相减（不用 UTC 取日）
    const lastUsedDay = row.last_used_at === null ? null : businessDateOf(row.last_used_at);
    const idleDays = lastUsedDay === null ? null : daysBetween(lastUsedDay, today);
    return {
      ...row,
      idle_days: idleDays,
      is_idle: idleDays === null || idleDays >= SUBSTITUTE_IDLE_DAYS ? 1 : 0,
    };
  });

  const matched = query.onlyIdle === 1 ? enriched.filter((row) => row.is_idle === 1) : enriched;
  // 呆滞列由 JS 依「今日业务日」推导，故排序 / 分页也在 JS 侧完成
  matched.sort((a, b) => {
    if (a.is_idle !== b.is_idle) return b.is_idle - a.is_idle;
    if (a.last_used_at !== b.last_used_at) {
      if (a.last_used_at === null) return -1; // NULLS FIRST：呆滞项里「从未使用」排最前
      if (b.last_used_at === null) return 1;
      return a.last_used_at < b.last_used_at ? -1 : 1;
    }
    return a.item_code.localeCompare(b.item_code);
  });

  const total = matched.length;
  const list: Row[] = options.all
    ? matched
    : matched.slice(
        (query.page - 1) * query.pageSize,
        (query.page - 1) * query.pageSize + query.pageSize,
      );

  const warnings = [
    `呆滞判定：自最后一次替代使用起 ≥ ${SUBSTITUTE_IDLE_DAYS} 个自然日未再使用（按业务日 UTC+8 计算）`,
  ];
  if (from || to) {
    warnings.push(
      `统计区间：${from ? businessDateOf(from) : '不限'} ~ ${to ? businessDateOf(to) : '不限'}` +
        `（替代日志按业务日 UTC+8 边界过滤，仅影响 substitution_count / total_sub_qty；` +
        `last_used_at 与呆滞判定**始终按全部历史**，不受区间影响）`,
    );
  }
  return { list, page: { page: query.page, pageSize: query.pageSize, total }, warnings };
}