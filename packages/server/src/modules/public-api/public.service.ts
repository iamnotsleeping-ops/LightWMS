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
  type PublicWarehousesQuery,
} from '@light-erp/shared';
import { getDb } from '../../db/connection';
import { RECEIPT_CTE, daysBetween, mean, round } from '../../lib/leadtime';
import { ApiError, type PageInfo } from '../../lib/response';
import { explodeBom, listBoms } from '../masterdata/bom.service';
import { queryStockList } from '../inventory/stock.query';

type Row = Record<string, unknown>;

export interface PublicPaged {
  list: Row[];
  page: PageInfo;
  warnings: string[];
}

const IN_TRANSIT_DEFAULT_STATUSES = ['confirmed', 'partial'];

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
    reserved: row.reserved,
    in_transit: row.in_transit,
    available: row.available,
    projected: row.projected,
  }));

  const warnings = result.asOf
    ? [
        '指定 as_of 时 reserved / in_transit / available / projected 为单据派生量，历史时点不可还原，返回 null；on_hand / frozen 已按 stock_transaction 重算',
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
    JOIN item p ON p.id = i.product_id`;

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
              r.first_received_at, r.last_received_at, a.max_promised_date
       ${base} ${clause}
       ORDER BY o.order_date DESC, o.id DESC, i.line_no
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as (Row & {
    order_date: string;
    first_received_at: string;
    last_received_at: string;
    max_promised_date: string;
  })[];

  const list: Row[] = rows.map((row) => {
    const lastDay = row.last_received_at.slice(0, 10);
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

  const leadTimes = orders.map((row) => daysBetween(row.order_date, row.last_received_at.slice(0, 10)));
  const promisedLeadTimes = orders.map((row) => daysBetween(row.order_date, row.max_promised_date));
  const onTimeCount = orders.filter(
    (row) => row.last_received_at.slice(0, 10) <= row.max_promised_date,
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
 * 字段口径：订单号 / 行号 / 客户（脱敏为客户编码）/ 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 订单状态。
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
      `SELECT so.order_no, soi.line_no, c.code AS customer_code,
              i.code AS item_code, w.code AS warehouse_code,
              soi.quantity, soi.shipped_qty,
              soi.quantity - soi.shipped_qty - soi.cancelled_qty AS unshipped,
              soi.due_date, so.status
       ${base} ${clause} ORDER BY so.order_no, soi.line_no LIMIT ? OFFSET ?`,
    )
    .all(...params, query.page_size, (query.page - 1) * query.page_size) as Row[];

  return { list: rows, page: pageOf(query, total), warnings: [] };
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