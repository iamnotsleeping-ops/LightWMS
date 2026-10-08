import { getDb } from '../../db/connection';
import { queryAlerts, type AlertRow } from '../inventory/alert.service';
import { readPortStockAsInventory } from '../inventory/stock.query';

export interface DashboardKpi {
  on_hand_qty: number;
  on_hand_amount: number;
  item_count: number;
  in_transit_qty: number;
  alert_count: number;
}

export interface DashboardTrendPoint {
  date: string;
  in_qty: number;
  out_qty: number;
}

export interface DashboardTodos {
  purchase_draft: number;
  purchase_pending_inbound: number;
  sales_draft: number;
  sales_pending_outbound: number;
  transfer_in_transit: number;
}

export interface DashboardOverview {
  kpi: DashboardKpi;
  trend: DashboardTrendPoint[];
  alerts: AlertRow[];
  todos: DashboardTodos;
}

const TREND_DAYS = 30;
const ALERT_LIMIT = 10;

function countPurchaseOrderByStatus(db: ReturnType<typeof getDb>, statuses: string[]): number {
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM purchase_order WHERE status IN (${placeholders})`)
    .get(...statuses) as { n: number };
  return row.n;
}

function countSalesOrderByStatus(db: ReturnType<typeof getDb>, statuses: string[]): number {
  const placeholders = statuses.map(() => '?').join(', ');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sales_order WHERE status IN (${placeholders})`)
    .get(...statuses) as { n: number };
  return row.n;
}

/**
 * 首页看板聚合（登录即可）。kpi 遵循系统参数 port_stock_as_inventory（默认排除港口仓）；
 * 趋势排除 status_change；无流水的日期补 0，保证 30 个点。
 */
export function dashboardOverview(): DashboardOverview {
  const db = getDb();
  const portAsInventory = readPortStockAsInventory(db);
  const portFlag = portAsInventory ? 1 : 0;

  // ---------- kpi ----------
  const hand = db
    .prepare(
      `SELECT COALESCE(SUM(b.quantity), 0) AS qty,
              COALESCE(SUM(b.quantity * b.avg_cost), 0) AS amount
         FROM stock_balance b
         JOIN warehouse w ON w.id = b.warehouse_id
        WHERE b.stock_status = 'available'
          AND (@portAsInventory = 1 OR w.type <> 'port')`,
    )
    .get({ portAsInventory: portFlag }) as { qty: number; amount: number };

  const itemCount = (db.prepare('SELECT COUNT(*) AS n FROM item WHERE is_active = 1').get() as {
    n: number;
  }).n;

  const purchaseTransit = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity - i.received_qty - i.cancelled_qty), 0) AS qty
         FROM purchase_order_item i
         JOIN purchase_order o ON o.id = i.order_id
         JOIN warehouse w ON w.id = i.warehouse_id
        WHERE o.status IN ('confirmed', 'partial')
          AND (@portAsInventory = 1 OR w.type <> 'port')`,
    )
    .get({ portAsInventory: portFlag }) as { qty: number };

  const transferTransit = db
    .prepare(
      `SELECT COALESCE(SUM(i.shipped_qty - i.received_qty), 0) AS qty
         FROM transfer_order_item i
         JOIN transfer_order o ON o.id = i.order_id
         JOIN warehouse w ON w.id = o.to_warehouse_id
        WHERE o.status = 'shipped'
          AND (@portAsInventory = 1 OR w.type <> 'port')`,
    )
    .get({ portAsInventory: portFlag }) as { qty: number };

  const alerts = queryAlerts({});

  const kpi: DashboardKpi = {
    on_hand_qty: hand.qty,
    on_hand_amount: hand.amount,
    item_count: itemCount,
    in_transit_qty: purchaseTransit.qty + transferTransit.qty,
    alert_count: alerts.length,
  };

  // ---------- trend（近 30 个自然日，含今日） ----------
  const dayMs = 86_400_000;
  const today = new Date();
  const startMs =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) -
    (TREND_DAYS - 1) * dayMs;
  const startIso = new Date(startMs).toISOString();

  const daily = db
    .prepare(
      `SELECT substr(t.occurred_at, 1, 10) AS day,
              SUM(CASE WHEN t.direction = 1 THEN t.quantity ELSE 0 END) AS in_qty,
              SUM(CASE WHEN t.direction = -1 THEN t.quantity ELSE 0 END) AS out_qty
         FROM stock_transaction t
        WHERE t.biz_type <> 'status_change' AND t.occurred_at >= @from
        GROUP BY day`,
    )
    .all({ from: startIso }) as { day: string; in_qty: number; out_qty: number }[];

  const byDay = new Map(daily.map((row) => [row.day, row]));
  const trend: DashboardTrendPoint[] = [];
  for (let i = 0; i < TREND_DAYS; i += 1) {
    const date = new Date(startMs + i * dayMs).toISOString().slice(0, 10);
    const found = byDay.get(date);
    trend.push({ date, in_qty: found?.in_qty ?? 0, out_qty: found?.out_qty ?? 0 });
  }

  // ---------- alerts（below_min 优先，取前 10） ----------
  const topAlerts = [...alerts]
    .sort((a, b) => {
      if (a.alert_type !== b.alert_type) return a.alert_type === 'below_min' ? -1 : 1;
      return a.product_code.localeCompare(b.product_code);
    })
    .slice(0, ALERT_LIMIT);

  // ---------- todos ----------
  const todos: DashboardTodos = {
    purchase_draft: countPurchaseOrderByStatus(db, ['draft']),
    purchase_pending_inbound: countPurchaseOrderByStatus(db, ['confirmed', 'partial']),
    sales_draft: countSalesOrderByStatus(db, ['draft']),
    sales_pending_outbound: countSalesOrderByStatus(db, ['confirmed', 'partial']),
    transfer_in_transit: (
      db.prepare("SELECT COUNT(*) AS n FROM transfer_order WHERE status = 'shipped'").get() as {
        n: number;
      }
    ).n,
  };

  return { kpi, trend, alerts: topAlerts, todos };
}