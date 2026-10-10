import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Db } from '../db/connection';
import { hasSeedMarker, seedDemoData } from '../db/seed';
import { addBusinessDays, businessToday } from '../lib/time';
import { queryAlerts } from '../modules/inventory/alert.service';
import { createTestDb } from './db';
import { planSubstitution } from '../modules/substitute/substitute.plan';

/**
 * P9 端到端验收：在空库上跑 seed 后，逐阶段核对各交付物。
 * 覆盖 主数据(P1/P6) → 库存引擎(P2) → 采购(P3) → 销售(P4) → 调拨/盘点/预警(P5)
 *      → 报表(P8) → 看板(P8) → 对外接口(P7)。
 */

let db: Db;
let app: FastifyInstance;
let token: string;

/**
 * 授权以数据库为准（plugins/auth.ts 的 loadAuthState），故需真实用户 + 真实权限关联。
 * 这里**复用内置 viewer 角色**而不是新建角色，避免污染「空库 sys_role = 5」的验收断言。
 */
function createAcceptanceUser(permissionCodes: string[]): number {
  const now = new Date().toISOString();
  const userId = Number(
    db
      .prepare('INSERT INTO sys_user (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)')
      .run('验收用户', now, now).lastInsertRowid,
  );
  const viewerRoleId = (
    db.prepare("SELECT id FROM sys_role WHERE code = 'viewer'").get() as { id: number }
  ).id;
  db.prepare('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)').run(
    userId,
    viewerRoleId,
  );
  const grant = db.prepare(
    `INSERT OR IGNORE INTO sys_role_permission (role_id, permission_id)
     SELECT ?, id FROM sys_permission WHERE code = ?`,
  );
  for (const code of permissionCodes) grant.run(viewerRoleId, code);
  return userId;
}

beforeEach(async () => {
  db = createTestDb();
  app = await buildApp();
  const acceptanceUserId = createAcceptanceUser(['report.view', 'masterdata.bom.view']);
  token = app.jwt.sign({
    sub: acceptanceUserId,
    name: 'acceptance',
    roles: ['viewer'],
    permissions: ['report.view', 'masterdata.bom.view'],
  });
});

afterEach(async () => {
  await app.close();
});

/** 相对今日的天数 → YYYY-MM-DD（与服务端一致，按业务时区 UTC+8 取日） */
function day(days: number): string {
  return addBusinessDays(businessToday(), days);
}

function countTable(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 演示数据里的物料条数：多处断言引用，避免每次扩充演示数据都要改一堆魔法数字 */
const SEED_ITEMS = 16;

/** 某列在演示数据里实际出现的取值（升序），用于断言枚举覆盖 */
function coveredValues(table: string, column: string): (string | number)[] {
  const rows = db
    .prepare(`SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" IS NOT NULL ORDER BY v`)
    .all() as { v: string | number }[];
  return rows.map((row) => row.v);
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
    expect(first.counts.item).toBe(SEED_ITEMS);

    const snapshot = { ...first.counts };
    const second = seedDemoData();
    expect(second.applied).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.counts).toEqual(snapshot);
    expect(countTable('item')).toBe(SEED_ITEMS);
  });

  it('--reset 清空业务数据后重建，且保留 sys_*（角色 / 权限）', () => {
    seedDemoData();
    const rolesBefore = countTable('sys_role');
    const permsBefore = countTable('sys_permission');

    db.prepare('INSERT INTO item (code, name, base_unit, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(
      'TMP-X',
      '临时物料',
      'EA',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    expect(countTable('item')).toBe(SEED_ITEMS + 1);

    const result = seedDemoData({ reset: true });
    expect(result.applied).toBe(true);
    expect(countTable('item')).toBe(SEED_ITEMS); // 临时物料与旧数据一并被清掉
    expect(countTable('sys_role')).toBe(rolesBefore);
    expect(countTable('sys_permission')).toBe(permsBefore);
  });
});

describe('P9 验收 · 全链路', () => {
  beforeEach(() => {
    seedDemoData();
  });

  it('主数据（P1/P6）：分类 / 物料 / 仓库 / 往来 / BOM 计数正确，BOM 多版本按 as_of 生效', async () => {
    expect(countTable('item_category')).toBe(6);
    expect(countTable('item')).toBe(16);
    expect(countTable('warehouse')).toBe(5);
    expect(countTable('partner')).toBe(7);
    expect(countTable('bom')).toBe(10);
    // 认证：FG-1001/CU-2001（长期）、FG-1002/CU-2001（长期）、FG-1002/CU-2002（已过期）
    expect(countTable('item_customer_certification')).toBe(3);
    // P10 替代料：12 条关系覆盖三种场景 × 三种策略 × 通用/仓专属/父件专属 × 生效/未生效/已过期/已停用
    expect(countTable('item_substitute')).toBe(13);
    // 替代执行追溯：SO-F（主料+替代料混用）与 SO-G（整行由替代料满足）各写 1 条
    expect(countTable('item_substitute_log')).toBe(2);

    // 「行级提前期」的可判定样例：整单口径把同一张单所有行的到货摊在一起，
    // **单行订单区分不出来**（两者恰好相等，下游曾因此复现不出判据）。
    // 这里断言演示数据里确实存在一条"多行、逐行到货日不同"的采购单，
    // 且这些到货在账本里带 biz_line_id（迁移 0010 的行级归属）。
    const lineReceipts = db
      .prepare(
        `SELECT poi.order_id, poi.id AS line_id, MAX(substr(t.occurred_at, 1, 10)) AS last_day
           FROM purchase_order_item poi
           JOIN stock_transaction t
             ON t.biz_line_id = poi.id AND t.biz_type = 'purchase_in'
          GROUP BY poi.id`,
      )
      .all() as { order_id: number; line_id: number; last_day: string }[];
    const daysByOrder = new Map<number, string[]>();
    for (const row of lineReceipts) {
      daysByOrder.set(row.order_id, [...(daysByOrder.get(row.order_id) ?? []), row.last_day]);
    }
    const discriminable = [...daysByOrder.values()].filter(
      (days) => days.length >= 2 && new Set(days).size >= 2,
    );
    expect(discriminable.length).toBeGreaterThan(0);

    // 演示数据必须覆盖到枚举全集（除刻意排除项），否则前端各页面的「其它情况」看不到
    expect(coveredValues('item_substitute', 'scene')).toEqual(['bom_plan', 'purchase_hint', 'sales_out']);
    expect(coveredValues('item_substitute', 'strategy')).toEqual([
      'manual',
      'proportion',
      'whole_batch',
    ]);
    expect(coveredValues('item_substitute', 'is_active')).toEqual([0, 1]);
    expect(coveredValues('sys_holiday', 'kind')).toEqual(['holiday', 'workday']);
    expect(coveredValues('partner', 'type')).toEqual(['both', 'customer', 'supplier']);

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

  it('库存引擎（P2）：八列口径非空，存在 frozen / qc 桶，余额与流水净额一致', () => {
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
    expect(qc).toBe(447); // RM-3001 300(qc) + RM-3003 150(qc) − 盘点盘亏 3（ST-D 盘 qc 桶）

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
    expect(countTable('stock_transaction')).toBe(34);
  });

  it('采购（P3）：五种状态齐全（含已取消），在途 750，含采购退货', () => {
    expect(countTable('purchase_order')).toBe(6);
    expect(countTable('purchase_return')).toBe(1);

    // 断言「枚举齐全」而不是「恰好几单」：后者每次扩充演示数据都会碎，且不表达真实意图
    expect(coveredValues('purchase_order', 'status')).toEqual([
      'cancelled',
      'confirmed',
      'draft',
      'partial',
      'received',
    ]);

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

  it('销售（P4）：五种状态齐全（含已取消），预留 55，含销售退货与替代出库', () => {
    expect(countTable('sales_order')).toBe(7);
    expect(countTable('sales_return')).toBe(1);

    expect(coveredValues('sales_order', 'status')).toEqual([
      'cancelled',
      'confirmed',
      'draft',
      'partial',
      'shipped',
    ]);

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

  it('调拨 / 盘点 / 预警（P5）：五种调拨状态齐全、调拨在途 50、盘点盘亏 2、当前预警 3 条', () => {
    expect(countTable('transfer_order')).toBe(5);
    expect(coveredValues('transfer_order', 'status')).toEqual([
      'cancelled',
      'confirmed',
      'draft',
      'received',
      'shipped',
    ]);
    const transferInTransit = (
      db
        .prepare('SELECT COALESCE(SUM(shipped_qty - received_qty), 0) AS q FROM transfer_order_item')
        .get() as { q: number }
    ).q;
    expect(transferInTransit).toBe(50);

    expect(countTable('stocktake_order')).toBe(4);
    expect(coveredValues('stocktake_order', 'status')).toEqual(['cancelled', 'draft', 'posted']);
    // 盘点表体覆盖三个状态桶（available / frozen / qc），且盘亏 -2 的那行仍在
    expect(coveredValues('stocktake_order_item', 'stock_status')).toEqual([
      'available',
      'frozen',
      'qc',
    ]);
    const diff = db
      .prepare("SELECT diff_qty FROM stocktake_order_item WHERE stock_status = 'available'")
      .all() as { diff_qty: number }[];
    expect(diff.some((row) => row.diff_qty === -2)).toBe(true);

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
    expect(typeof snapshot.data[0].stock_amount).toBe('number');

    // 金额口径对账：只要有实物库存（total_qty ≠ 0），现状表的 stock_amount 必须等于
    // 明细账同维度的期末金额。
    //   · 只比对 total_qty ≠ 0 的行：现状表还会列出「仅存在预留/在途、实物为 0」的维度，
    //     这些维度的金额为 0，而明细账的 activeWhere 会把全零行整个过滤掉，故无对应行。
    //   · 对比「现状表 ⊆ 明细账」而非总和：明细账不排除港口仓，现状表默认排除。
    const ledgerAmountByDimension = new Map<string, number>(
      (ledger.data as { product_code: string; warehouse_code: string; closing_amount: number }[]).map(
        (row) => [`${row.product_code}:${row.warehouse_code}`, row.closing_amount],
      ),
    );
    const stocked = (
      snapshot.data as {
        product_code: string;
        warehouse_code: string;
        total_qty: number;
        stock_amount: number;
      }[]
    ).filter((row) => row.total_qty !== 0);
    expect(stocked.length).toBeGreaterThan(0);

    for (const row of stocked) {
      const key = `${row.product_code}:${row.warehouse_code}`;
      expect(ledgerAmountByDimension.get(key), key).toBe(row.stock_amount);
    }

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

    expect(body.data.kpi.item_count).toBe(SEED_ITEMS - 1); // KPI 只统计启用物料（演示数据里有 1 个停用物料）
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
    expect((await app.inject({ method: 'GET', url: '/api/v1/warehouses' })).json().data).toHaveLength(5);

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
/**
 * 演示数据的枚举覆盖度检查。
 *
 * 目的：演示库要能让人看到「各种情况」，所以每个 `CHECK (col IN (...))` 枚举都应在种子数据里
 * 至少出现一次。这里**从 schema 自动推导枚举**而不是手写清单——新增一个枚举值后，本测试会
 * 直接失败，逼着种子数据或下面的排除表跟上；手写清单则会静默漏掉新值。
 *
 * 确实无法造数据的枚举（功能未实现 / 表未启用）必须在 EXCLUDED 里显式登记并写明理由，
 * 不允许用「跳过不检查」的方式蒙过去。
 */
describe('P9 演示数据 · 枚举覆盖度', () => {
  beforeEach(() => {
    seedDemoData();
  });

  /** 刻意不造数据的枚举取值：造了会让演示看起来支持并不存在的能力 */
  const EXCLUDED: { table: string; column: string; reason: string }[] = [
    {
      table: 'item_substitute',
      column: 'cross_warehouse',
      reason: '跨仓替代未实现，该字段恒为 0（预留字段）',
    },
    {
      table: 'item_substitute_log',
      column: 'biz_type',
      reason: '仅销售出库会写该表，purchase_in / plan 无写入路径',
    },
    {
      table: 'export_task',
      column: 'status',
      reason: '导出任务表未启用（报表走同步 CSV 导出）',
    },
  ];

  it('每个 CHECK 枚举在演示数据里都有取值（除显式登记的例外）', () => {
    const excludedKeys = new Set(EXCLUDED.map((item) => `${item.table}.${item.column}`));
    const ddlRows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string | null }[];

    const gaps: string[] = [];
    let checkedColumns = 0;

    for (const row of ddlRows) {
      const ddl = row.sql ?? '';
      for (const match of ddl.matchAll(/(\w+)\s+IN\s*\(([^)]*)\)/g)) {
        const column = match[1];
        const values = match[2]
          .split(',')
          .map((value) => value.trim().replace(/^'|'$/g, ''))
          .filter((value) => /^[\w-]+$/.test(value));
        if (values.length === 0) continue; // 非字面量枚举（如 IN (SELECT ...)）
        if (excludedKeys.has(`${row.name}.${column}`)) continue;

        checkedColumns += 1;
        const present = new Set(
          coveredValues(row.name, column).map((value) => String(value)),
        );
        for (const value of values) {
          if (!present.has(value)) gaps.push(`${row.name}.${column} 缺 ${value}`);
        }
      }
    }

    // 断言确实扫到了足够多的枚举列，避免正则失效后本测试变成空测
    expect(checkedColumns).toBeGreaterThan(15);
    expect(gaps).toEqual([]);
  });

  /**
   * 演示数据要能复现规划里的各个 skipped 原因，否则下游对账时无处构造判据。
   * 这里只用「不指名」的普通规划：规则层不可用的关系会以 skipped 出现（手工指名会升为 400）。
   */
  it('演示数据可复现 wrong_warehouse / relation_inactive / out_of_validity / customer_cert_expired', () => {
    const mainPk = itemIdOf('PK-4001');
    const mainRm = itemIdOf('RM-3001');
    const warehouseWh02 = (
      db.prepare("SELECT id FROM warehouse WHERE code = 'WH-02'").get() as { id: number }
    ).id;

    const reasonsOf = (request: Parameters<typeof planSubstitution>[0]): string[] =>
      planSubstitution(request, db).skipped.map((entry) => entry.reason);

    // PK-4001 → PK-4003 的 purchase_hint 行只在 WH-01：请求 WH-02 应得 wrong_warehouse
    expect(
      reasonsOf({
        mainItemId: mainPk,
        warehouseId: warehouseWh02,
        requiredQty: 10,
        scene: 'purchase_hint',
      }),
    ).toContain('wrong_warehouse');

    // PK-4001 → PK-4003 的 bom_plan 行已停用
    expect(
      reasonsOf({ mainItemId: mainPk, warehouseId: warehouseWh02, requiredQty: 10, scene: 'bom_plan' }),
    ).toContain('relation_inactive');

    // RM-3001 → RM-3005 的 sales_out 行尚未生效
    expect(
      reasonsOf({ mainItemId: mainRm, warehouseId: warehouseWh02, requiredQty: 10, scene: 'sales_out' }),
    ).toContain('out_of_validity');

    // FG-1002 对 CU-2002 的认证已于昨日过期
    const customerCu2002 = (
      db.prepare("SELECT id FROM partner WHERE code = 'CU-2002'").get() as { id: number }
    ).id;
    const fg1001 = itemIdOf('FG-1001');
    expect(
      reasonsOf({
        mainItemId: fg1001,
        warehouseId: warehouseWh02,
        requiredQty: 10,
        scene: 'sales_out',
        customerId: customerCu2002,
      }),
    ).toContain('customer_cert_expired');
  });

  it('登记为「刻意排除」的枚举确实仍然没有被造数据（排除表不会过期）', () => {
    for (const item of EXCLUDED) {
      const present = coveredValues(item.table, item.column).map((value) => String(value));
      expect(present.length, `${item.table}.${item.column}：${item.reason}`).toBeLessThanOrEqual(1);
    }
  });
});
