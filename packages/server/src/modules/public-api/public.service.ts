import {
  PURCHASE_ORDER_STATUSES,
  SALES_ORDER_STATUSES,
  type PublicBomExplodeQuery,
  type PublicBomsQuery,
  type PublicInTransitQuery,
  type PublicInventoryQuery,
  type PublicItemsQuery,
  type PublicLeadTimeStatsQuery,
  type PublicPurchaseHistoryQuery,
  type PublicSalesOrdersQuery,
  type PublicSubstitutesQuery,
  type PublicSubstitutionPlanQuery,
  type PublicWarehousesQuery,
  type SubstituteScene,
  type SubstituteStrategy,
  type SubstitutionSkipReason,
} from '@light-erp/shared';
import { getDb } from '../../db/connection';
import { RECEIPT_CTE, daysBetween, mean, round } from '../../lib/leadtime';
import { ApiError, type PageInfo } from '../../lib/response';
import { businessDateOf, businessToday } from '../../lib/time';
import { explodeBom, listBoms } from '../masterdata/bom.service';
import { queryStockList } from '../inventory/stock.query';
import { planSubstitution } from '../substitute/substitute.plan';

type Row = Record<string, unknown>;

export interface PublicPaged {
  list: Row[];
  page: PageInfo;
  warnings: string[];
}

const IN_TRANSIT_DEFAULT_STATUSES = ['confirmed', 'partial'];

/**
 * IF-6 缺省状态范围：「未结需求」。
 *
 * 与内部 `reserved` 口径（stock.query.ts：只统计 confirmed / partial）保持一致。
 * 若缺省返回全部状态，`draft` 与 `cancelled` 订单行的 `unshipped` 仍等于订单量，
 * 下游按 `unshipped` 求和会把未生效与已取消的需求一并算作待出库，系统性高估。
 */
const OPEN_SALES_STATUSES = ['confirmed', 'partial'];

// ---------- 通用工具 ----------

function pageOf(query: { page: number; page_size: number }, total: number): PageInfo {
  return { page: query.page, pageSize: query.page_size, total };
}

function emptyPage(query: { page: number; page_size: number }, warnings: string[] = []): PublicPaged {
  return { list: [], page: pageOf(query, 0), warnings };
}

function idByCode(table: 'item' | 'warehouse' | 'partner', code: string): number | null {
  const row = getDb().prepare(`SELECT id FROM ${table} WHERE code = ?`).get(code) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

/** 逗号分隔多值 → 合法状态数组；未提供或全非法时回退默认值 */
function parseStatusList(raw: string | undefined, allowed: readonly string[], fallback: string[]): string[] {
  if (!raw) return fallback;
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => allowed.includes(value));
  return list.length > 0 ? list : fallback;
}

/** 逗号分隔的编码列表 → 去掉空项的编码数组（保持输入顺序） */
function parseCodeList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * as_of 归一为业务日（YYYY-MM-DD）。
 * 生效期（effective_from / effective_to）是业务日字符串，若把 ISO 时间戳直接与日期串比较，
 * 「当天到期」会被判成已失效；故先换算到 UTC+8 业务日再比。
 */
function asOfBusinessDate(asOf: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : businessDateOf(asOf);
}

// ---------- IF-1 物料主数据 ----------

export function listPublicItems(query: PublicItemsQuery): PublicPaged {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.keyword) {
    where.push('(i.code LIKE ? OR i.name LIKE ?)');
    params.push(`%${query.keyword}%`, `%${query.keyword}%`);
  }
  if (query.category_code) {
    where.push('c.code = ?');
    params.push(query.category_code);
  }
  if (query.is_active !== undefined) {
    where.push('i.is_active = ?');
    params.push(query.is_active);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const base = 'FROM item i LEFT JOIN item_category c ON c.id = i.category_id';

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${base} ${clause}`).get(...params) as {
    total: number;
  };
  const rows = db
    .prepare(
      `SELECT i.id, i.code, i.name, i.base_unit, i.qty_precision,
              c.code AS category_code, c.name AS category_name, c.capacity_group,
              i.is_active, i.inspection_required, i.batch_managed, i.serial_managed,
              i.created_at, i.updated_at
       ${base} ${clause} ORDER BY i.code LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as Row[];
  return { list: rows, page: pageOf(query, total), warnings: [] };
}

// ---------- IF-2 BOM ----------

export function listPublicBoms(query: PublicBomsQuery): Row[] {
  let parentItemId: number | undefined;
  if (query.parent_item_code) {
    const id = idByCode('item', query.parent_item_code);
    if (id === null) return [];
    parentItemId = id;
  }
  let childItemId: number | undefined;
  if (query.child_item_code) {
    const id = idByCode('item', query.child_item_code);
    if (id === null) return [];
    childItemId = id;
  }

  return listBoms({
    parentItemId,
    childItemId,
    keyword: query.keyword,
    asOf: query.as_of,
  }).map((row) => ({
    id: row.id,
    parent_item_code: row.parent_code,
    parent_item_name: row.parent_name,
    parent_base_unit: row.parent_unit,
    child_item_code: row.child_code,
    child_item_name: row.child_name,
    child_base_unit: row.child_unit,
    qty_per: row.qty_per,
    scrap_rate: row.scrap_rate,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  }));
}

// ---------- IF-2b BOM 多层展开 ----------

export function explodePublicBom(
  itemCode: string,
  query: PublicBomExplodeQuery,
): { data: Row; warnings: string[] } {
  const result = explodeBom({ itemCode, asOf: query.as_of, qty: query.qty });
  const data: Row = {
    as_of: result.asOf,
    root: {
      item_code: result.root.itemCode,
      item_name: result.root.itemName,
      base_unit: result.root.baseUnit,
      qty_precision: result.root.qtyPrecision,
      required_qty: result.root.requiredQty,
    },
    lines: result.lines.map((line) => ({
      level: line.level,
      item_code: line.itemCode,
      item_name: line.itemName,
      base_unit: line.baseUnit,
      qty_precision: line.qtyPrecision,
      qty_per: line.qtyPer,
      scrap_rate: line.scrapRate,
      required_qty: line.requiredQty,
      is_leaf: line.isLeaf,
      cyclic: line.cyclic,
    })),
    cycles: result.cycles,
  };
  return { data, warnings: result.warnings };
}

// ---------- IF-3 库存 ----------

export function queryPublicInventory(query: PublicInventoryQuery): PublicPaged {
  let productId: number | undefined;
  if (query.item_code) {
    const id = idByCode('item', query.item_code);
    if (id === null) return emptyPage(query);
    productId = id;
  }
  let warehouseId: number | undefined;
  if (query.warehouse_code) {
    const id = idByCode('warehouse', query.warehouse_code);
    if (id === null) return emptyPage(query);
    warehouseId = id;
  }

  const result = queryStockList({
    page: query.page,
    pageSize: query.page_size,
    keyword: query.keyword,
    productId,
    warehouseId,
    asOf: query.as_of,
  });

  const list: Row[] = result.list.map((row) => ({
    item_code: row.product_code,
    item_name: row.product_name,
    base_unit: row.base_unit,
    qty_precision: row.qty_precision,
    warehouse_code: row.warehouse_code,
    warehouse_name: row.warehouse_name,
    warehouse_type: row.warehouse_type,
    on_hand: row.on_hand,
    frozen: row.frozen,
    qc: row.qc,
    total_qty: row.total_qty,
    reserved: row.reserved,
    in_transit: row.in_transit,
    available: row.available,
    projected: row.projected,
  }));

  const warnings = result.asOf
    ? [
        '指定 as_of 时 reserved / in_transit / available / projected 为单据派生量，历史时点不可还原，返回 null；on_hand / frozen / qc / total_qty 已按 stock_transaction 重算',
      ]
    : [];
  return { list, page: result.page, warnings };
}

// ---------- IF-4 在途 / 采购订单 ----------

export function listPublicInTransit(query: PublicInTransitQuery): PublicPaged {
  const db = getDb();
  const statuses = parseStatusList(
    query.status,
    PURCHASE_ORDER_STATUSES,
    IN_TRANSIT_DEFAULT_STATUSES,
  );

  const where: string[] = [`o.status IN (${statuses.map(() => '?').join(', ')})`];
  const params: unknown[] = [...statuses];
  if (query.as_of) {
    where.push('o.order_date <= ?');
    params.push(query.as_of);
  }
  if (query.supplier_code) {
    where.push('s.code = ?');
    params.push(query.supplier_code);
  }
  if (query.item_code) {
    where.push('p.code = ?');
    params.push(query.item_code);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const base = `
    FROM purchase_order o
    JOIN partner s ON s.id = o.supplier_id
    JOIN purchase_order_item i ON i.order_id = o.id
    JOIN item p ON p.id = i.product_id
    JOIN warehouse w ON w.id = i.warehouse_id`;

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${base} ${clause}`).get(...params) as {
    total: number;
  };
  const list = db
    .prepare(
      `SELECT o.order_no, o.order_date, o.status,
              s.code AS supplier_code, s.name AS supplier_name,
              i.line_no, p.code AS item_code, p.name AS item_name, p.base_unit,
              w.code AS warehouse_code, w.name AS warehouse_name,
              i.quantity, i.received_qty, i.cancelled_qty,
              (i.quantity - i.received_qty - i.cancelled_qty) AS in_transit,
              i.promised_date
       ${base} ${clause}
       ORDER BY o.order_date DESC, o.id DESC, i.line_no
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as Row[];

  const warnings = query.as_of
    ? ['指定 as_of 时按采购单 order_date <= as_of 过滤；单据状态与已执行量为当前值，历史进度不可还原（按当前进度近似）']
    : [];
  return { list, page: pageOf(query, total), warnings };
}

// ---------- IF-5 历史采购订单（提前期，整单口径） ----------

export function listPublicPurchaseHistory(query: PublicPurchaseHistoryQuery): PublicPaged {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.supplier_code) {
    where.push('s.code = ?');
    params.push(query.supplier_code);
  }
  if (query.item_code) {
    where.push('p.code = ?');
    params.push(query.item_code);
  }
  if (query.date_from) {
    where.push('o.order_date >= ?');
    params.push(query.date_from);
  }
  if (query.date_to) {
    where.push('o.order_date <= ?');
    params.push(query.date_to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const base = `
    FROM purchase_order o
    JOIN receipts r ON r.order_id = o.id
    JOIN order_agg a ON a.order_id = o.id
    JOIN partner s ON s.id = o.supplier_id
    JOIN purchase_order_item i ON i.order_id = o.id
    JOIN item p ON p.id = i.product_id
    LEFT JOIN line_receipts lr ON lr.biz_line_id = i.id`;

  const { total } = db
    .prepare(`${RECEIPT_CTE} SELECT COUNT(*) AS total ${base} ${clause}`)
    .get(...params) as { total: number };

  const rows = db
    .prepare(
      `${RECEIPT_CTE}
       SELECT o.order_no, o.order_date, o.status,
              s.code AS supplier_code, s.name AS supplier_name,
              i.line_no, p.code AS item_code, p.name AS item_name,
              i.quantity, i.received_qty, i.unit_price, i.promised_date,
              r.first_received_at, r.last_received_at, a.max_promised_date,
              lr.line_first_received_at, lr.line_last_received_at
       ${base} ${clause}
       ORDER BY o.order_date DESC, o.id DESC, i.line_no
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as (Row & {
    order_date: string;
    first_received_at: string;
    last_received_at: string;
    max_promised_date: string;
    /** 该**行**自己的承诺日（NOT NULL），line_on_time 与它比较 */
    promised_date: string;
    /** 行级（迁移 0010 起才有）：该采购单行自身流水的首次/最后到货时刻；存量或非采购入库为 null */
    line_first_received_at: string | null;
    line_last_received_at: string | null;
  })[];

  const list: Row[] = rows.map((row) => {
    const lastDay = businessDateOf(row.last_received_at);
    return {
      order_no: row.order_no,
      order_date: row.order_date,
      status: row.status,
      supplier_code: row.supplier_code,
      supplier_name: row.supplier_name,
      line_no: row.line_no,
      item_code: row.item_code,
      item_name: row.item_name,
      quantity: row.quantity,
      received_qty: row.received_qty,
      unit_price: row.unit_price,
      promised_date: row.promised_date,
      first_received_at: row.first_received_at,
      last_received_at: row.last_received_at,
      lead_time_days: daysBetween(row.order_date, lastDay),
      promised_lead_time_days: daysBetween(row.order_date, row.max_promised_date),
      on_time: lastDay <= row.max_promised_date,
      // ---- 以下为**行级**口径（迁移 0010 起）：行没有行级到货数据时为 null（存量单不回溯）----
      line_first_received_at: row.line_first_received_at,
      line_last_received_at: row.line_last_received_at,
      line_lead_time_days:
        row.line_last_received_at === null
          ? null
          : daysBetween(row.order_date, businessDateOf(row.line_last_received_at)),
      // 与整单 on_time 的区别：这里比的是**该行自己的** promised_date，不是整单最晚承诺日
      line_on_time:
        row.line_last_received_at === null
          ? null
          : businessDateOf(row.line_last_received_at) <= row.promised_date,
    };
  });

  return { list, page: pageOf(query, total), warnings: [] };
}

// ---------- IF-5b 供应商提前期聚合 ----------

export interface LeadTimeStats {
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

export function supplierLeadTimeStats(code: string, query: PublicLeadTimeStatsQuery): LeadTimeStats {
  const db = getDb();
  const supplier = db.prepare('SELECT id, code, name FROM partner WHERE code = ?').get(code) as
    | { id: number; code: string; name: string }
    | undefined;
  if (!supplier) throw new ApiError(404, '供应商不存在');

  const where: string[] = ['o.supplier_id = ?'];
  const params: unknown[] = [supplier.id];
  if (query.date_from) {
    where.push('o.order_date >= ?');
    params.push(query.date_from);
  }
  if (query.date_to) {
    where.push('o.order_date <= ?');
    params.push(query.date_to);
  }
  if (query.item_code) {
    where.push(
      'EXISTS (SELECT 1 FROM purchase_order_item i2 JOIN item p2 ON p2.id = i2.product_id WHERE i2.order_id = o.id AND p2.code = ?)',
    );
    params.push(query.item_code);
  }

  const orders = db
    .prepare(
      `${RECEIPT_CTE}
       SELECT o.id, o.order_date, r.last_received_at, a.max_promised_date
         FROM purchase_order o
         JOIN receipts r ON r.order_id = o.id
         JOIN order_agg a ON a.order_id = o.id
        WHERE ${where.join(' AND ')}`,
    )
    .all(...params) as {
    id: number;
    order_date: string;
    last_received_at: string;
    max_promised_date: string;
  }[];

  const orderIds = orders.map((row) => row.id);
  let lineCount = 0;
  let receivedLineCount = 0;
  if (orderIds.length > 0) {
    const lineWhere = [`i.order_id IN (${orderIds.map(() => '?').join(', ')})`];
    const lineParams: unknown[] = [...orderIds];
    if (query.item_code) {
      lineWhere.push('p.code = ?');
      lineParams.push(query.item_code);
    }
    const lineStats = db
      .prepare(
        `SELECT COUNT(*) AS line_count,
                COALESCE(SUM(CASE WHEN i.received_qty > 0 THEN 1 ELSE 0 END), 0) AS received_line_count
           FROM purchase_order_item i JOIN item p ON p.id = i.product_id
          WHERE ${lineWhere.join(' AND ')}`,
      )
      .get(...lineParams) as { line_count: number; received_line_count: number };
    lineCount = lineStats.line_count;
    receivedLineCount = lineStats.received_line_count;
  }

  const leadTimes = orders.map((row) =>
    daysBetween(row.order_date, businessDateOf(row.last_received_at)),
  );
  const promisedLeadTimes = orders.map((row) => daysBetween(row.order_date, row.max_promised_date));
  const onTimeCount = orders.filter(
    (row) => businessDateOf(row.last_received_at) <= row.max_promised_date,
  ).length;
  const lastOrderDate = orders.reduce<string | null>(
    (latest, row) => (latest === null || row.order_date > latest ? row.order_date : latest),
    null,
  );

  return {
    supplier_code: supplier.code,
    supplier_name: supplier.name,
    order_count: orders.length,
    line_count: lineCount,
    received_line_count: receivedLineCount,
    avg_lead_time_days: mean(leadTimes),
    min_lead_time_days: leadTimes.length > 0 ? Math.min(...leadTimes) : null,
    max_lead_time_days: leadTimes.length > 0 ? Math.max(...leadTimes) : null,
    avg_promised_lead_time_days: mean(promisedLeadTimes),
    on_time_rate: orders.length > 0 ? round(onTimeCount / orders.length, 4) : null,
    last_order_date: lastOrderDate,
  };
}

// ---------- IF-6 销售订单行 ----------

/**
 * 行级明细：一行 = 销售单的一行物料。
 * 字段口径：订单号 / 行号 / 订单日期 / 客户（脱敏为客户编码）/ 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 订单状态。
 * 未出库量 = quantity − shipped_qty − cancelled_qty。
 * `customer_name` 按客户名称精确过滤（返回仍只给客户编码）；`order_date` 按订单日期精确匹配；
 * `date_from`、`date_to` 按「要求交期」（`due_date`）过滤。
 */
export function listPublicSalesOrders(query: PublicSalesOrdersQuery): PublicPaged {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.order_no) {
    where.push('so.order_no = ?');
    params.push(query.order_no);
  }
  if (query.customer_code) {
    where.push('c.code = ?');
    params.push(query.customer_code);
  }
  if (query.customer_name) {
    where.push('c.name = ?');
    params.push(query.customer_name);
  }
  if (query.item_code) {
    where.push('i.code = ?');
    params.push(query.item_code);
  }
  if (query.warehouse_code) {
    where.push('w.code = ?');
    params.push(query.warehouse_code);
  }
  if (query.order_date) {
    where.push('so.order_date = ?');
    params.push(query.order_date);
  }
  if (query.status) {
    const statuses = parseStatusList(query.status, SALES_ORDER_STATUSES, []);
    if (statuses.length === 0) return emptyPage(query);
    where.push(`so.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  } else {
    // 缺省只返回未结需求，避免把 draft / cancelled 计入待出库（见 OPEN_SALES_STATUSES 注释）
    where.push(`so.status IN (${OPEN_SALES_STATUSES.map(() => '?').join(', ')})`);
    params.push(...OPEN_SALES_STATUSES);
  }
  if (query.date_from) {
    where.push('soi.due_date >= ?');
    params.push(query.date_from);
  }
  if (query.date_to) {
    where.push('soi.due_date <= ?');
    params.push(query.date_to);
  }
  if (query.keyword) {
    where.push('(so.order_no LIKE ? OR c.code LIKE ? OR i.code LIKE ? OR i.name LIKE ?)');
    const like = `%${query.keyword}%`;
    params.push(like, like, like, like);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM sales_order_item soi
       JOIN sales_order so ON so.id = soi.order_id
       JOIN partner c ON c.id = so.customer_id
       JOIN item i ON i.id = soi.product_id
       JOIN warehouse w ON w.id = soi.warehouse_id`;

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${base} ${clause}`).get(...params) as {
    total: number;
  };
  const rows = db
    .prepare(
      `SELECT so.order_no, soi.line_no, so.order_date, c.code AS customer_code,
              i.code AS item_code, w.code AS warehouse_code,
              soi.quantity, soi.shipped_qty,
              soi.quantity - soi.shipped_qty - soi.cancelled_qty AS unshipped,
              soi.due_date, so.status
       ${base} ${clause} ORDER BY so.order_no, soi.line_no LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as Row[];

  const warnings = query.status
    ? []
    : [
        `未指定 status，缺省仅返回未结需求（${OPEN_SALES_STATUSES.join(' / ')}），与内部 reserved 口径一致；如需包含 draft / cancelled，请显式传 status（支持逗号分隔多值）`,
      ];
  return { list: rows, page: pageOf(query, total), warnings };
}

// ---------- IF-7 工厂 / 仓库 ----------

export function listPublicWarehouses(query: PublicWarehousesQuery): Row[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.type) {
    where.push('w.type = ?');
    params.push(query.type);
  }
  if (query.is_active !== undefined) {
    where.push('w.is_active = ?');
    params.push(query.is_active);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(
      `SELECT w.code, w.name, w.type, pw.code AS parent_code, pw.name AS parent_name,
              w.is_active, w.created_at, w.updated_at
         FROM warehouse w LEFT JOIN warehouse pw ON pw.id = w.parent_id
         ${clause} ORDER BY w.type, w.code`,
    )
    .all(...params) as Row[];
}

// ---------- IF-8 替代关系（关系清单，非规划结果） ----------

/**
 * 列出某主料的替代关系配置：只回答「配了哪些替代料」，不做可用量计算。
 * `warehouse_code` 给定时同时纳入全仓通用（warehouse_id IS NULL）与该仓专属的关系；
 * 未知主料 / 仓库编码返回空页（与 IF-2 一致），避免下游把「查不到」当成错误重试。
 */
export function listPublicSubstitutes(query: PublicSubstitutesQuery): PublicPaged {
  const db = getDb();
  const mainItemId = idByCode('item', query.main_item_code);
  if (mainItemId === null) return emptyPage(query);

  let warehouseId: number | undefined;
  if (query.warehouse_code) {
    const id = idByCode('warehouse', query.warehouse_code);
    if (id === null) return emptyPage(query);
    warehouseId = id;
  }
  const asOfDate = query.as_of ? asOfBusinessDate(query.as_of) : undefined;

  const where: string[] = ['s.main_item_id = ?'];
  const params: unknown[] = [mainItemId];
  if (warehouseId !== undefined) {
    where.push('(s.warehouse_id IS NULL OR s.warehouse_id = ?)');
    params.push(warehouseId);
  }
  if (query.scene) {
    where.push('s.scene = ?');
    params.push(query.scene);
  }
  if (asOfDate !== undefined) {
    // 边界含当天：effective_to = as_of 仍视为有效，NULL 为长期有效
    where.push('(s.effective_from IS NULL OR s.effective_from <= ?)');
    params.push(asOfDate);
    where.push('(s.effective_to IS NULL OR s.effective_to >= ?)');
    params.push(asOfDate);
  }

  const clause = `WHERE ${where.join(' AND ')}`;
  const base = `
    FROM item_substitute s
    JOIN item mi ON mi.id = s.main_item_id
    JOIN item si ON si.id = s.sub_item_id
    LEFT JOIN item pi ON pi.id = s.parent_item_id
    LEFT JOIN warehouse w ON w.id = s.warehouse_id`;

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${base} ${clause}`).get(...params) as {
    total: number;
  };
  const list = db
    .prepare(
      `SELECT mi.code AS main_item_code, mi.name AS main_item_name,
              si.code AS sub_item_code, si.name AS sub_item_name, si.base_unit AS sub_base_unit,
              pi.code AS parent_item_code, w.code AS warehouse_code,
              s.priority, s.ratio_num, s.ratio_den, s.scene, s.strategy,
              s.effective_from, s.effective_to, s.is_active
       ${base} ${clause}
       ORDER BY s.priority ASC, si.code ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as Row[];

  const warnings = asOfDate
    ? [
        '指定 as_of 时仅按生效期（effective_from / effective_to）筛选替代关系；本接口只返回关系配置，可用库存始终为当前时点、且不在本接口返回范围内',
      ]
    : [];
  return { list, page: pageOf(query, total), warnings };
}

// ---------- IF-9 替代规划（只读试算，整份返回） ----------

export interface PublicSubstitutionPlan {
  as_of: string;
  main_item_code: string;
  warehouse_code: string;
  scene: SubstituteScene;
  strategy: SubstituteStrategy;
  required_qty: number;
  filled_qty: number;
  gap_qty: number;
  allocations: Row[];
  skipped: { item_code: string; reason: SubstitutionSkipReason }[];
}

/**
 * 调用纯只读的 `planSubstitution` 并转成 snake_case 出参。
 * 编码一律先解析为 id：主料 / 仓库 / 客户不存在时 404（不静默回退成空规划，
 * 否则下游会把「编码写错」当成「确实没有替代料」）；父件与手工替代料同理。
 */
export function substitutionPlan(query: PublicSubstitutionPlanQuery): {
  data: PublicSubstitutionPlan;
  warnings: string[];
} {
  const mainItemId = idByCode('item', query.main_item_code);
  if (mainItemId === null) throw new ApiError(404, `物料不存在：${query.main_item_code}`);
  const warehouseId = idByCode('warehouse', query.warehouse_code);
  if (warehouseId === null) throw new ApiError(404, `仓库不存在：${query.warehouse_code}`);

  let customerId: number | null = null;
  if (query.customer_code) {
    customerId = idByCode('partner', query.customer_code);
    if (customerId === null) throw new ApiError(404, `客户不存在：${query.customer_code}`);
  }
  let parentItemId: number | null = null;
  if (query.parent_item_code) {
    parentItemId = idByCode('item', query.parent_item_code);
    if (parentItemId === null) throw new ApiError(404, `父件物料不存在：${query.parent_item_code}`);
  }

  const manualItemIds: number[] = [];
  for (const code of parseCodeList(query.manual_item_codes)) {
    const id = idByCode('item', code);
    if (id === null) throw new ApiError(404, `替代料不存在：${code}`);
    manualItemIds.push(id);
  }

  // 与 planSubstitution 内部口径一致：as_of 只作用于关系生效期，可用量永远是当前时点
  const asOfDate = query.as_of ? asOfBusinessDate(query.as_of) : businessToday();
  const plan = planSubstitution({
    mainItemId,
    warehouseId,
    requiredQty: query.required_qty,
    scene: query.scene,
    customerId,
    parentItemId,
    strategy: query.strategy,
    manualItemIds: manualItemIds.length > 0 ? manualItemIds : undefined,
    asOf: asOfDate,
  });

  const warnings = [...plan.warnings];
  // 刻意**不**在这里常驻一条「按物理量计算」的口径告警：
  // ① 下游已明确「把 reserved / available / projected 暴露出来就够了」，不需要每条响应都提醒；
  // ② _warnings 按契约是「口径近似与截断提示」，常驻会让它无法再表达"本次确有异常"；
  // ③ 会破坏下游已通过的逐字段对账。口径改由字段名（on_hand）+ OpenAPI 描述 + README 承载。
  if (query.as_of) {
    warnings.push(
      '指定 as_of 时仅按生效期（effective_from / effective_to）筛选替代关系；可用库存与成本始终为当前时点，历史时点的可用量不可还原',
    );
  }

  return {
    data: {
      as_of: asOfDate,
      main_item_code: plan.mainItemCode,
      warehouse_code: query.warehouse_code,
      scene: plan.scene,
      strategy: plan.strategy,
      required_qty: plan.requiredQty,
      filled_qty: plan.filledQty,
      gap_qty: plan.gapQty,
      allocations: plan.allocations.map((entry) => ({
        item_code: entry.itemCode,
        item_name: entry.itemName,
        quantity: entry.quantity,
        covered_qty: entry.coveredQty,
        is_main: entry.isMain,
        // 物理可用量（available 桶）＝ IF-3 的 on_hand。
        // 过渡别名 available 已于下游切换完成后移除（它借用的是 ATP 的名字）。
        on_hand: entry.onHand,
        unit_cost: entry.unitCost,
        ratio_num: entry.ratioNum,
        ratio_den: entry.ratioDen,
      })),
      skipped: plan.skipped.map((entry) => ({ item_code: entry.itemCode, reason: entry.reason })),
    },
    warnings,
  };
}