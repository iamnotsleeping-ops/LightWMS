import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/connection';
import { hasSeedMarker, seedDemoData } from '../db/seed';
import { queryAlerts } from '../modules/inventory/alert.service';
import { createTestDb } from './db';

/**
 * P9 端到端验收：在空库上跑 seed 后，逐阶段核对各交付物。
 * 覆盖 主数据(P1/P6) → 库存引擎(P2) → 采购(P3) → 销售(P4) → 调拨/盘点/预警(P5)
 *      → 报表(P8) → 看板(P8) → 对外接口(P7)。
 */

let db: Db;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  db = createTestDb();
  app = await buildApp();
  token = app.jwt.sign({
    sub: 1,
    name: 'acceptance',
    roles: ['sys_admin'],
    permissions: ['report.view', 'masterdata.bom.view'],
  });
});

afterEach(async () => {
  await app.close();
});

/** 相对今日的天数 → YYYY-MM-DD（与服务端一致，按 UTC 取日） */
function day(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function countTable(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function itemIdOf(code: string): number {
  return (db.prepare('SELECT id FROM item WHERE code = ?').get(code) as { id: number }).id;
}

function authGet(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('P9 空库基线', () => {
  it('迁移后业务表为空，RBAC 已由 0002 就位，且无种子标记', () => {
    expect(countTable('item')).toBe(0);
    expect(countTable('warehouse')).toBe(0);
    expect(countTable('purchase_order')).toBe(0);
    expect(countTable('stock_transaction')).toBe(0);
    expect(countTable('sys_role')).toBe(5);
    expect(countTable('sys_permission')).toBeGreaterThan(30);
    expect(hasSeedMarker(db)).toBe(false);
  });
});

describe('P9 种子 · 幂等与重建', () => {
  it('首次灌入 applied=true；再次调用跳过且计数不变', () => {
    const first = seedDemoData();
    expect(first.applied).toBe(true);
    expect(first.skipped).toBe(false);
    expect(first.counts.item).toBe(9);

    const snapshot = { ...first.counts };
    const second = seedDemoData();
    expect(second.applied).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.counts).toEqual(snapshot);
    expect(countTable('item')).toBe(9);
  });

  it('--reset 清空业务数据后重建，且保留 sys_*（角色 / 权限）', () => {
    seedDemoData();
    const rolesBefore = countTable('sys_role');
    const permsBefore = countTable('sys_permission');

    db.prepare('INSERT INTO item (code, name, base_unit, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(
      'TMP-X',
      '临时物料',
      '件',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(countTable('item')).toBe(10);

    const result = seedDemoData({ reset: true });
    expect(result.applied).toBe(true);
    expect(countTable('item')).toBe(9); // 临时物料与旧数据一并被清掉
    expect(countTable('sys_role')).toBe(rolesBefore);
    expect(countTable('sys_permission')).toBe(permsBefore);
  });
});

describe('P9 验收 · 全链路', () => {
  beforeEach(() => {
    seedDemoData();
  });

  it('主数据（P1/P6）：分类 / 物料 / 仓库 / 往来 / BOM 计数正确，BOM 多版本按 as_of 生效', async () => {
    expect(countTable('item_category')).toBe(4);
    expect(countTable('item')).toBe(9);
    expect(countTable('warehouse')).toBe(4);
    expect(countTable('partner')).toBe(5);
    expect(countTable('bom')).toBe(10);
    expect(countTable('item_customer_certification')).toBe(1);

    // 2026-03-15 落在 FG-1001 生效窗口（2026-01-01 ~ 2026-06-30），RM-3004 用量为 1
    const v1 = (await authGet('/api/masterdata/boms?asOf=2026-03-15&parentItemId=' + itemIdOf('FG-1001'))).json();
    expect(v1.code).toBe(0);
    const v1Qty = v1.data.find((row: { child_item_id: number }) => row.child_item_id === itemIdOf('RM-3004'))?.qty_per;
    expect(v1Qty).toBe(1);

    // 2026-08-01 落在 v2 窗口，RM-3004 用量改为 2
    const v2 = (await authGet('/api/masterdata/boms?asOf=2026-08-01&parentItemId=' + itemIdOf('FG-1001'))).json();
    const v2Qty = v2.data.find((row: { child_item_id: number }) => row.child_item_id === itemIdOf('RM-3004'))?.qty_per;
    expect(v2Qty).toBe(2);

    // 多层展开：SF-2001 → RM-3001 / RM-3003
    const explode = (
      await app.inject({ method: 'GET', url: `/api/v1/boms/SF-2001/explode?qty=1&as_of=2026-08-01` })
    ).json();
    expect(explode.code).toBe(0);
    const childCodes = (explode.data.lines as { item_code: string }[]).map((c) => c.item_code);
    expect(childCodes).toContain('RM-3001');
    expect(childCodes).toContain('RM-3003');
  });

  it('库存引擎（P2）：六项口径非空，存在 frozen / qc 桶，余额与流水净额一致', () => {
    const stocks = (
      db.prepare(
        `SELECT SUM(quantity) AS on_hand FROM stock_balance WHERE stock_status = 'available'`,
      ).get() as { on_hand: number }
    ).on_hand;
    expect(stocks).toBeGreaterThan(0);

    const frozen = (
      db.prepare(`SELECT SUM(quantity) AS q FROM stock_balance WHERE stock_status = 'frozen'`).get() as {
        q: number;
      }
    ).q;
    expect(frozen).toBe(20); // WH-01 RM-3001 冻结 20

    const qc = (
      db.prepare(`SELECT SUM(quantity) AS q FROM stock_balance WHERE stock_status = 'qc'`).get() as {
        q: number;
      }
    ).q;
    expect(qc).toBe(450); // RM-3001 300(qc) + RM-3003 150(qc)

    // 每个 (物料, 仓库, 状态) 的余额 = 该维度流水 direction×quantity 之和
    const mismatch = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT b.product_id, b.warehouse_id, b.stock_status,
                  b.quantity AS bal,
                  COALESCE((SELECT SUM(t.direction * t.quantity) FROM stock_transaction t
                             WHERE t.product_id = b.product_id AND t.warehouse_id = b.warehouse_id
                               AND t.stock_status = b.stock_status), 0) AS flow
             FROM stock_balance b
         ) x WHERE x.bal <> x.flow`,
      )
      .get() as { n: number };
    expect(mismatch.n).toBe(0);
    expect(countTable('stock_transaction')).toBe(21);
  });

  it('采购（P3）：四单状态齐全，在途 750，含采购退货', () => {
    expect(countTable('purchase_order')).toBe(4);
    expect(countTable('purchase_return')).toBe(1);

    const byStatus = db
      .prepare('SELECT status, COUNT(*) AS n FROM purchase_order GROUP BY status')
      .all() as { status: string; n: number }[];
    const map = Object.fromEntries(byStatus.map((row) => [row.status, row.n]));
    expect(map).toMatchObject({ received: 1, partial: 1, confirmed: 1, draft: 1 });

    const inTransit = (
      db
        .prepare(
          `SELECT COALESCE(SUM(quantity - received_qty - cancelled_qty), 0) AS q
             FROM purchase_order_item i JOIN purchase_order o ON o.id = i.order_id
            WHERE o.status IN ('confirmed', 'partial')`,
        )
        .get() as { q: number }
    ).q;
    expect(inTransit).toBe(750); // PO-B 250 + PO-C 500

    const returnTx = db
      .prepare("SELECT direction FROM stock_transaction WHERE biz_type = 'purchase_return'")
      .all() as { direction: number }[];
    expect(returnTx).toHaveLength(1);
    expect(returnTx[0].direction).toBe(-1);
  });

  it('销售（P4）：四单状态齐全，预留 55，含销售退货', () => {
    expect(countTable('sales_order')).toBe(4);
    expect(countTable('sales_return')).toBe(1);

    const byStatus = db
      .prepare('SELECT status, COUNT(*) AS n FROM sales_order GROUP BY status')
      .all() as { status: string; n: number }[];
    const map = Object.fromEntries(byStatus.map((row) => [row.status, row.n]));
    expect(map).toMatchObject({ shipped: 1, partial: 1, confirmed: 1, draft: 1 });

    const reserved = (
      db
        .prepare(
          `SELECT COALESCE(SUM(quantity - shipped_qty - cancelled_qty), 0) AS q
             FROM sales_order_item i JOIN sales_order o ON o.id = i.order_id
            WHERE o.status IN ('confirmed', 'partial')`,
        )
        .get() as { q: number }
    ).q;
    expect(reserved).toBe(55); // SO-B 25 + SO-C 30

    const returnTx = db
      .prepare("SELECT direction FROM stock_transaction WHERE biz_type = 'sale_return'")
      .all() as { direction: number }[];
    expect(returnTx).toHaveLength(1);
    expect(returnTx[0].direction).toBe(1);
  });

  it('调拨 / 盘点 / 预警（P5）：调拨在途 50、盘点盘亏 2、当前预警 3 条', () => {
    expect(countTable('transfer_order')).toBe(2);
    const transferStatuses = db
      .prepare('SELECT status, COUNT(*) AS n FROM transfer_order GROUP BY status')
      .all() as { status: string; n: number }[];
    expect(Object.fromEntries(transferStatuses.map((r) => [r.status, r.n]))).toMatchObject({
      received: 1,
      shipped: 1,
    });
    const transferInTransit = (
      db
        .prepare('SELECT COALESCE(SUM(shipped_qty - received_qty), 0) AS q FROM transfer_order_item')
        .get() as { q: number }
    ).q;
    expect(transferInTransit).toBe(50);

    expect(countTable('stocktake_order')).toBe(1);
    const diff = db
      .prepare('SELECT diff_qty FROM stocktake_order_item ORDER BY line_no')
      .all() as { diff_qty: number }[];
    expect(diff).toHaveLength(1);
    expect(diff[0].diff_qty).toBe(-2);

    const alerts = queryAlerts({});
    expect(alerts).toHaveLength(3);
    expect(alerts.every((a) => a.alert_type === 'below_min')).toBe(true);
    const codes = alerts.map((a) => a.product_code).sort();
    expect(codes).toEqual(['FG-1001', 'PK-4001', 'RM-3003']);
  });

  it('报表（P8）：明细账自洽 / 现状表带金额 / 收发明细金额一致 / 提前期 6 天', async () => {
    const ledger = (
      await authGet(`/api/reports/inventory-ledger?dateFrom=${day(-40)}&dateTo=${day(0)}&pageSize=200`)
    ).json();
    expect(ledger.code).toBe(0);
    expect(ledger.data.length).toBeGreaterThan(0);
    for (const row of ledger.data) {
      expect(row.closing_qty).toBe(row.opening_qty + row.in_qty - row.out_qty);
      expect(row.closing_amount).toBe(row.opening_amount + row.in_amount - row.out_amount);
    }

    const snapshot = (await authGet('/api/reports/stock-snapshot?pageSize=200')).json();
    expect(snapshot.code).toBe(0);
    expect(snapshot.data.length).toBeGreaterThan(0);
    expect(typeof snapshot.data[0].on_hand_amount).toBe('number');

    const movement = (
      await authGet(`/api/reports/item-movement?dateFrom=${day(-40)}&dateTo=${day(0)}&pageSize=200`)
    ).json();
    expect(movement.code).toBe(0);
    expect(movement.data.length).toBeGreaterThan(0);
    for (const row of movement.data) {
      expect(row.amount).toBe(row.quantity * row.unit_cost);
    }

    const lead = (await authGet('/api/reports/supplier-lead-time?pageSize=200')).json();
    const su1001 = lead.data.find((row: { supplier_code: string }) => row.supplier_code === 'SU-1001');
    expect(su1001).toBeDefined();
    expect(su1001.avg_lead_time_days).toBe(6);
    expect(su1001.on_time_rate).toBe(1);
  });

  it('看板（P8）：kpi / trend(30) / alerts / todos 均有数据且口径正确', async () => {
    const body = (await authGet('/api/dashboard/overview')).json();
    expect(body.code).toBe(0);

    expect(body.data.kpi.item_count).toBe(9);
    expect(body.data.kpi.in_transit_qty).toBe(800); // 采购 750 + 调拨 50
    expect(body.data.kpi.alert_count).toBe(3);
    expect(body.data.kpi.on_hand_qty).toBeGreaterThan(0);

    expect(body.data.trend).toHaveLength(30);
    expect(body.data.trend[29].date).toBe(day(0));

    expect(body.data.alerts).toHaveLength(3);

    expect(body.data.todos).toEqual({
      purchase_draft: 1,
      purchase_pending_inbound: 2,
      sales_draft: 1,
      sales_pending_outbound: 2,
      transfer_in_transit: 1,
    });
  });

  it('对外接口（P7）：8 条只读接口 200 + 信封，CSV 带 BOM，OpenAPI 3.1', async () => {
    const endpoints = [
      '/api/v1/items',
      '/api/v1/boms?as_of=2026-08-01',
      '/api/v1/inventory',
      '/api/v1/in-transit',
      '/api/v1/purchase-history',
      '/api/v1/suppliers/SU-1001/lead-time-stats',
      '/api/v1/sales-orders',
      '/api/v1/warehouses',
    ];
    for (const url of endpoints) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().code, url).toBe(0);
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/warehouses' })).json().data).toHaveLength(4);

    const csv = await app.inject({ method: 'GET', url: '/api/v1/items?format=csv' });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.startsWith('\uFEFF')).toBe(true);
    expect(csv.body).not.toContain('"code"');

    const openapi = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(String(openapi.openapi).startsWith('3.')).toBe(true);
  });

  it('只读性：查询类调用前后账本行数不变', async () => {
    const before = countTable('stock_transaction');
    const balancesBefore = countTable('stock_balance');
    await authGet(`/api/reports/inventory-ledger?dateFrom=${day(-40)}&dateTo=${day(0)}`);
    await authGet('/api/reports/stock-snapshot');
    await authGet('/api/dashboard/overview');
    await app.inject({ method: 'GET', url: '/api/v1/inventory' });
    expect(countTable('stock_transaction')).toBe(before);
    expect(countTable('stock_balance')).toBe(balancesBefore);
  });
});