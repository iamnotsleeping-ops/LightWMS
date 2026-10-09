import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createAuthorizedUser, createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { changeStockStatus, postMovement } from '../inventory/stock.engine';
import { receivePurchase } from '../purchase/purchase.inbound';
import {
  confirmOrder as confirmPurchase,
  createOrder as createPurchase,
} from '../purchase/purchase.service';

let db: Db;
let fx: Fixtures;
let app: FastifyInstance;
let token: string;
let noPermToken: string;

const REPORT_VIEW = ['report.view'];

beforeEach(async () => {
  db = createTestDb();
  fx = seedFixtures(db);
  app = await buildApp();
  // 授权以数据库为准，故落真实用户 + 真实权限关联，而不是伪造 JWT 载荷
  const viewerId = createAuthorizedUser(db, REPORT_VIEW);
  const guestId = createAuthorizedUser(db, []);
  token = app.jwt.sign({ sub: viewerId, name: 'tester', roles: [], permissions: REPORT_VIEW });
  noPermToken = app.jwt.sign({ sub: guestId, name: 'guest', roles: [], permissions: [] });
});

afterEach(async () => {
  await app.close();
});

const get = (url: string, bearer: string | null = token) =>
  app.inject({
    method: 'GET',
    url,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

/** 造一笔库存流水（默认 available 桶） */
function addStock(quantity: number, direction: 1 | -1, occurredAt: string, opts?: {
  bizType?: string;
  unitCost?: number;
  warehouseId?: number;
  productId?: number;
}): void {
  postMovement({
    productId: opts?.productId ?? fx.itemId,
    warehouseId: opts?.warehouseId ?? fx.warehouseId,
    stockStatus: 'available',
    bizType: (opts?.bizType ?? 'adjust') as never,
    direction,
    quantity,
    unitCost: opts?.unitCost ?? 500,
    occurredAt,
  });
}

/** 直接建一个物料，返回其 id（用于批量构造超过一页的数据） */
function makeItem(code: string): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
         VALUES (?, ?, 'EA', 1, 0, 0, ?, ?)`,
      )
      .run(code, `物料${code}`, now, now).lastInsertRowid,
  );
}

/** 建一张已确认采购单（单行），返回 orderId 与 orderItemId */
function makeConfirmedPurchase(
  quantity: number,
  orderDate: string,
  promisedDate: string,
  supplierId = fx.supplierId,
): { orderId: number; itemId: number } {
  const { id } = createPurchase(
    {
      supplier_id: supplierId,
      order_date: orderDate,
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: fx.warehouseId,
          quantity,
          unit_price: 500,
          promised_date: promisedDate,
        },
      ],
    },
    null,
  );
  confirmPurchase(id);
  const row = db.prepare('SELECT id FROM purchase_order_item WHERE order_id = ?').get(id) as {
    id: number;
  };
  return { orderId: id, itemId: row.id };
}

function insertSupplier(code: string, name: string): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO partner (code, name, type, is_active, created_at, updated_at)
         VALUES (?, ?, 'supplier', 1, ?, ?)`,
      )
      .run(code, name, now, now).lastInsertRowid,
  );
}

describe('报表接口 · 鉴权', () => {
  it('未登录 401、无权限 403、有权限 200', async () => {
    const urls = [
      '/api/reports/inventory-ledger',
      '/api/reports/stock-snapshot',
      '/api/reports/item-movement',
      '/api/reports/supplier-lead-time',
    ];
    for (const url of urls) {
      const anonymous = await get(url, null);
      expect(anonymous.statusCode, url).toBe(401);
      expect(anonymous.json().code, url).toBe(401);

      const forbidden = await get(url, noPermToken);
      expect(forbidden.statusCode, url).toBe(403);

      const allowed = await get(url);
      expect(allowed.statusCode, url).toBe(200);
      expect(allowed.json().code, url).toBe(0);
    }
  });
});

describe('IF-R1 进销存明细账', () => {
  it('期初 / 入库 / 出库 / 期末数量与金额正确', async () => {
    addStock(100, 1, '2026-01-05T00:00:00.000Z', { unitCost: 500 });
    addStock(50, 1, '2026-02-10T00:00:00.000Z', { unitCost: 600 });
    addStock(30, -1, '2026-02-20T00:00:00.000Z', { bizType: 'sale_out' });

    const body = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-02-01&dateTo=2026-02-28')
    ).json();

    expect(body.page.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      product_code: 'RM-001',
      warehouse_code: 'WH-01',
      opening_qty: 100,
      in_qty: 50,
      out_qty: 30,
      closing_qty: 120,
      opening_amount: 50000,
      in_amount: 30000,
      out_amount: 15990,
      closing_amount: 64010,
    });
    expect(body._warnings.length).toBeGreaterThan(0);
  });

  it('跨区间两段流水求和正确（区间放大到覆盖全部）', async () => {
    addStock(100, 1, '2026-01-05T00:00:00.000Z', { unitCost: 500 });
    addStock(50, 1, '2026-02-10T00:00:00.000Z', { unitCost: 600 });
    addStock(30, -1, '2026-02-20T00:00:00.000Z', { bizType: 'sale_out' });

    const body = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-01-01&dateTo=2026-02-28')
    ).json();
    expect(body.data[0]).toMatchObject({
      opening_qty: 0,
      in_qty: 150,
      out_qty: 30,
      closing_qty: 120,
      in_amount: 80000,
    });
  });

  it('排除 status_change：状态转移不虚增入库 / 出库两栏', async () => {
    addStock(100, 1, '2026-03-01T00:00:00.000Z', { unitCost: 500 });
    changeStockStatus({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      fromStatus: 'available',
      toStatus: 'frozen',
      quantity: 40,
      occurredAt: '2026-03-05T00:00:00.000Z',
    });

    const body = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-03-01&dateTo=2026-03-31')
    ).json();
    expect(body.data[0]).toMatchObject({ in_qty: 100, out_qty: 0, closing_qty: 100 });
  });

  // 回归：区间曾按 UTC 取日，UTC+8 部署下本地 00:00–08:00 的流水会被算进前一天。
  // 现在 dateFrom / dateTo 归一为**业务日**（UTC+8）边界，这里把边界两侧都钉住。
  it('区间按业务日（UTC+8）划分：本地当日流水不漏，UTC 跨日不再错位', async () => {
    // 本地 2026-04-15 23:00 = 2026-04-15T15:00:00Z → 业务日 04-15
    addStock(70, 1, '2026-04-15T15:00:00.000Z', { unitCost: 500 });
    // 本地 2026-04-16 04:00 = 2026-04-15T20:00:00Z → 业务日 04-16（UTC 日期仍是 04-15）
    addStock(30, 1, '2026-04-15T20:00:00.000Z', { unitCost: 500 });

    const day15 = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-04-15&dateTo=2026-04-15')
    ).json();
    expect(day15.data[0]).toMatchObject({ in_qty: 70, closing_qty: 70 });

    const day16 = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-04-16&dateTo=2026-04-16')
    ).json();
    expect(day16.data[0]).toMatchObject({ opening_qty: 70, in_qty: 30, closing_qty: 100 });
  });

  it('业务日起点边界：本地 00:00:00.000（UTC 前一日 16:00Z）计入当日', async () => {
    addStock(12, 1, '2026-04-14T16:00:00.000Z', { unitCost: 500 });

    const body = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-04-15&dateTo=2026-04-15')
    ).json();
    expect(body.data[0]).toMatchObject({ in_qty: 12, closing_qty: 12 });
  });
});

describe('IF-R2 库存现状表', () => {
  it('实物量三桶独立成列、金额列正确；asOf 时金额为 null 且给出告警', async () => {
    addStock(100, 1, '2026-06-01T00:00:00.000Z', { unitCost: 500 });
    for (const [status, qty] of [
      ['frozen', 20],
      ['qc', 300],
    ] as const) {
      postMovement({
        productId: fx.itemId,
        warehouseId: fx.warehouseId,
        stockStatus: status,
        bizType: 'adjust',
        direction: 1,
        quantity: qty,
        unitCost: 500,
        occurredAt: '2026-06-01T00:00:00.000Z',
      });
    }

    const current = (await get('/api/reports/stock-snapshot')).json();
    expect(current.page.total).toBe(1);
    expect(current.data[0]).toMatchObject({
      product_code: 'RM-001',
      warehouse_code: 'WH-01',
      on_hand: 100,
      frozen: 20,
      qc: 300,
      total_qty: 420,
      avg_cost: 500,
      // 按流水累计：100×500 + 20×500 + 300×500（三桶合计，与 total_qty 配对）
      stock_amount: 210000,
    });

    const historical = (await get('/api/reports/stock-snapshot?asOf=2026-07-01')).json();
    expect(historical.data[0]).toMatchObject({
      on_hand: 100,
      frozen: 20,
      qc: 300,
      total_qty: 420,
      reserved: null,
      in_transit: null,
      available: null,
      projected: null,
      // 均价不可还原，但金额由流水累计而来，历史时点同样可算
      avg_cost: null,
      stock_amount: 210000,
    });
    expect(historical._warnings.length).toBeGreaterThan(0);
  });
});

// 回归：此前「库存金额」用 数量 × 移动加权均价，而明细账期末金额用流水累计，
// 两者会因均价逐笔取整而分离。这里用仓库自带的漂移算例把两表钉在同一个数上。
describe('金额口径对账：现状表与明细账必须一致', () => {
  it('stock_amount ≡ 明细账 closing_amount（均价取整漂移场景）', async () => {
    addStock(100, 1, '2026-02-05T00:00:00.000Z', { unitCost: 500 });
    addStock(50, 1, '2026-02-10T00:00:00.000Z', { unitCost: 600 });
    addStock(30, -1, '2026-02-20T00:00:00.000Z', { bizType: 'sale_out' });

    const ledger = (
      await get('/api/reports/inventory-ledger?dateFrom=2026-02-01&dateTo=2026-02-28')
    ).json();
    const snapshot = (await get('/api/reports/stock-snapshot')).json();

    // 均价 = round(80000 / 150) = 533；120 × 533 = 63960，而流水累计为 64010。
    // 旧实现的 on_hand_amount 会报 63960，两张报表对同一状态相差 50 分。
    expect(snapshot.data[0].avg_cost).toBe(533);
    expect(snapshot.data[0].total_qty).toBe(120);
    expect(snapshot.data[0].stock_amount).toBe(64010);
    expect(snapshot.data[0].stock_amount).toBe(ledger.data[0].closing_amount);
  });
});

describe('IF-R3 商品收发明细', () => {
  it('bizType / productId 过滤生效，amount = quantity × unit_cost', async () => {
    addStock(10, 1, '2026-05-01T00:00:00.000Z', { bizType: 'adjust', unitCost: 500 });
    addStock(20, 1, '2026-05-02T00:00:00.000Z', { bizType: 'purchase_in', unitCost: 700 });

    const body = (await get(`/api/reports/item-movement?productId=${fx.itemId}&bizType=purchase_in`)).json();
    expect(body.page.total).toBe(1);
    const row = body.data[0];
    expect(row.biz_type).toBe('purchase_in');
    expect(row.quantity).toBe(20);
    expect(row.unit_cost).toBe(700);
    expect(row.amount).toBe(14000);
  });
});

describe('IF-R4 供应商提前期分析', () => {
  it('多供应商分组聚合正确，未到货单不计入提前期均值', async () => {
    const supplier2 = insertSupplier('SU-02', '二号供应商');

    // SU-01：两单，一单准时一单超期
    const a = makeConfirmedPurchase(40, '2026-01-01', '2026-01-10');
    receivePurchase(
      { orderId: a.orderId, lines: [{ orderItemId: a.itemId, quantity: 40 }], occurredAt: '2026-01-05T00:00:00.000Z' },
      null,
    );
    const b = makeConfirmedPurchase(40, '2026-02-01', '2026-02-10');
    receivePurchase(
      { orderId: b.orderId, lines: [{ orderItemId: b.itemId, quantity: 40 }], occurredAt: '2026-02-20T00:00:00.000Z' },
      null,
    );
    // SU-02：一单已到货，一单未到货（不计入）
    const c = makeConfirmedPurchase(30, '2026-01-15', '2026-01-25', supplier2);
    receivePurchase(
      { orderId: c.orderId, lines: [{ orderItemId: c.itemId, quantity: 30 }], occurredAt: '2026-01-20T00:00:00.000Z' },
      null,
    );
    makeConfirmedPurchase(10, '2026-03-01', '2026-03-10', supplier2);

    const body = (await get('/api/reports/supplier-lead-time')).json();
    expect(body.page.total).toBe(2);

    const su1 = body.data.find((row: { supplier_code: string }) => row.supplier_code === 'SU-01');
    expect(su1).toMatchObject({
      order_count: 2,
      line_count: 2,
      received_line_count: 2,
      avg_lead_time_days: 11.5,
      min_lead_time_days: 4,
      max_lead_time_days: 19,
      avg_promised_lead_time_days: 9,
      on_time_rate: 0.5,
      last_order_date: '2026-02-01',
    });

    const su2 = body.data.find((row: { supplier_code: string }) => row.supplier_code === 'SU-02');
    expect(su2).toMatchObject({
      order_count: 1,
      line_count: 1,
      avg_lead_time_days: 5,
      avg_promised_lead_time_days: 10,
      on_time_rate: 1,
      last_order_date: '2026-01-15',
    });
  });
});

describe('format=csv', () => {
  it('4 张报表返回 text/csv、带 BOM、业务列序、不套信封', async () => {
    addStock(25, 1, '2026-06-01T00:00:00.000Z', { unitCost: 400 });
    const { orderId, itemId } = makeConfirmedPurchase(15, '2026-01-01', '2026-01-10');
    receivePurchase(
      { orderId, lines: [{ orderItemId: itemId, quantity: 15 }], occurredAt: '2026-01-05T00:00:00.000Z' },
      null,
    );

    const cases: [string, string][] = [
      ['/api/reports/inventory-ledger?format=csv&dateFrom=2026-01-01&dateTo=2026-12-31', 'product_id'],
      ['/api/reports/stock-snapshot?format=csv', 'product_id'],
      ['/api/reports/item-movement?format=csv', 'id'],
      ['/api/reports/supplier-lead-time?format=csv', 'supplier_code'],
    ];

    for (const [url, firstColumn] of cases) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/csv');
      expect(res.body.charAt(0), url).toBe('\uFEFF');
      const header = res.body.replace(/^\uFEFF/, '').split('\r\n')[0].split(',');
      expect(header[0], url).toBe(firstColumn);
      expect(res.body, url).not.toContain('"_warnings"');
    }
  });

  // 回归：导出曾按默认分页（pageSize=20）只输出第一页，用户点「导出 CSV」得到被静默截断的文件
  it('导出 CSV 不受分页限制：行数超过默认 pageSize(20) 时仍导出全部行', async () => {
    const itemCount = 25;
    for (let index = 1; index <= itemCount; index += 1) {
      const productId = makeItem(`RM-CSV-${String(index).padStart(3, '0')}`);
      addStock(10, 1, '2026-06-01T00:00:00.000Z', { unitCost: 500, productId });
    }
    const range = 'dateFrom=2026-01-01&dateTo=2026-12-31';

    // 浏览仍分页：JSON 只返回 20 行，但 total 是全量
    const browsing = (await get(`/api/reports/inventory-ledger?${range}`)).json();
    expect(browsing.page.total).toBe(itemCount);
    expect(browsing.data).toHaveLength(20);

    // 导出走全量：表头 + 全部数据行
    const csvCases: [string, string][] = [
      [`/api/reports/inventory-ledger?format=csv&${range}`, 'RM-CSV-025'],
      ['/api/reports/item-movement?format=csv', 'RM-CSV-025'],
      ['/api/reports/stock-snapshot?format=csv', 'RM-CSV-025'],
    ];

    for (const [url, lastCode] of csvCases) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      const lines = res.body.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
      expect(lines.length, url).toBe(itemCount + 1);
      expect(res.body, url).toContain('RM-CSV-001');
      expect(res.body, url).toContain(lastCode);
    }
  });
});

describe('只读性', () => {
  it('调用 4 张报表前后不产生任何写入', async () => {
    addStock(10, 1, '2026-06-01T00:00:00.000Z', { unitCost: 500 });
    const before = {
      transactions: (db.prepare('SELECT COUNT(*) AS n FROM stock_transaction').get() as { n: number }).n,
      balance: (db.prepare('SELECT COUNT(*) AS n FROM stock_balance').get() as { n: number }).n,
      orders: (db.prepare('SELECT COUNT(*) AS n FROM purchase_order').get() as { n: number }).n,
    };

    await get('/api/reports/inventory-ledger');
    await get('/api/reports/stock-snapshot');
    await get('/api/reports/item-movement');
    await get('/api/reports/supplier-lead-time');

    const after = {
      transactions: (db.prepare('SELECT COUNT(*) AS n FROM stock_transaction').get() as { n: number }).n,
      balance: (db.prepare('SELECT COUNT(*) AS n FROM stock_balance').get() as { n: number }).n,
      orders: (db.prepare('SELECT COUNT(*) AS n FROM purchase_order').get() as { n: number }).n,
    };
    expect(after).toEqual(before);
  });
});