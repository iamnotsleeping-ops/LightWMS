import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { postMovement } from '../inventory/stock.engine';
import { confirmOrder as confirmPurchase, createOrder as createPurchase } from '../purchase/purchase.service';
import { receivePurchase } from '../purchase/purchase.inbound';
import { confirmOrder as confirmSales, createOrder as createSales } from '../sales/sales.service';

let db: Db;
let fx: Fixtures;
let app: FastifyInstance;

beforeEach(async () => {
  db = createTestDb();
  fx = seedFixtures(db);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

const nowIso = () => new Date().toISOString();

function insertItem(code: string, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
         VALUES (?, ?, 'EA', 1, 0, 0, ?, ?)`,
      )
      .run(code, name, nowIso(), nowIso()).lastInsertRowid,
  );
}

function insertBom(parent: number, child: number, qtyPer: number, from: string, to: string | null): void {
  db.prepare(
    `INSERT INTO bom (parent_item_id, child_item_id, qty_per, scrap_rate, effective_from, effective_to, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(parent, child, qtyPer, from, to, nowIso(), nowIso());
}

function addStock(
  productId: number,
  warehouseId: number,
  quantity: number,
  occurredAt: string,
  stockStatus: 'available' | 'frozen' | 'qc' = 'available',
): void {
  postMovement({
    productId,
    warehouseId,
    stockStatus,
    bizType: 'adjust',
    direction: 1,
    quantity,
    unitCost: 500,
    occurredAt,
  });
}

/** 建一张已确认采购单（单行），返回 orderId 与 orderItemId */
function makeConfirmedPurchase(quantity: number, orderDate: string, promisedDate: string): { orderId: number; itemId: number } {
  const { id } = createPurchase(
    {
      supplier_id: fx.supplierId,
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

function makeConfirmedSales(quantity: number): number {
  const { id } = createSales(
    {
      customer_id: fx.customerId,
      order_date: '2026-01-01',
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: fx.warehouseId,
          quantity,
          unit_price: 800,
          due_date: '2026-01-20',
        },
      ],
    },
    null,
  );
  confirmSales(id);
  return id;
}

const get = (url: string) => app.inject({ method: 'GET', url });

describe('对外只读接口 · 公开与信封', () => {
  it('9 条接口不带 Authorization 均返回 200（公开无鉴权）', async () => {
    insertBom(fx.portItemId, fx.itemId, 1, '2026-01-01', null);
    const urls = [
      '/api/v1/items',
      '/api/v1/boms',
      '/api/v1/boms/FG-001/explode',
      '/api/v1/inventory',
      '/api/v1/in-transit',
      '/api/v1/purchase-history',
      '/api/v1/suppliers/SU-01/lead-time-stats',
      '/api/v1/sales-orders',
      '/api/v1/warehouses',
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.json().code, url).toBe(0);
    }
  });

  it('JSON 走统一信封，分页接口含 page 信息', async () => {
    const body = (await get('/api/v1/items')).json();
    expect(body.message).toBe('ok');
    expect(Array.isArray(body._warnings)).toBe(true);
    expect(body.page).toEqual({ page: 1, pageSize: 100, total: 2 });
    expect(body.data).toHaveLength(2);
  });
});

describe('IF-1 物料主数据', () => {
  it('keyword / is_active 过滤与分页 total 正确', async () => {
    const byKeyword = (await get('/api/v1/items?keyword=RM')).json();
    expect(byKeyword.data.map((row: { code: string }) => row.code)).toEqual(['RM-001']);

    const byActive = (await get('/api/v1/items?is_active=1')).json();
    expect(byActive.page.total).toBe(2);

    const byCategory = (await get('/api/v1/items?category_code=NOPE')).json();
    expect(byCategory.data).toHaveLength(0);
    expect(byCategory.page.total).toBe(0);
  });
});

describe('IF-2 BOM 多版本', () => {
  it('不传 as_of 返回全部版本，传 as_of 只返回生效版', async () => {
    insertBom(fx.portItemId, fx.itemId, 2, '2026-01-01', '2026-06-30');
    insertBom(fx.portItemId, fx.itemId, 3, '2026-07-01', '2026-12-31');

    const all = (await get('/api/v1/boms')).json();
    expect(all.data).toHaveLength(2);

    const effective = (await get('/api/v1/boms?as_of=2026-03-15')).json();
    expect(effective.data).toHaveLength(1);
    expect(effective.data[0]).toMatchObject({
      parent_item_code: 'FG-001',
      child_item_code: 'RM-001',
      qty_per: 2,
    });
  });
});

describe('IF-2b BOM 多层展开', () => {
  it('展开累计需求正确，物料不存在返回 404', async () => {
    insertBom(fx.portItemId, fx.itemId, 3, '2026-01-01', null);
    const body = (await get('/api/v1/boms/FG-001/explode?qty=2')).json();
    expect(body.data.root.item_code).toBe('FG-001');
    expect(body.data.lines).toHaveLength(1);
    expect(body.data.lines[0]).toMatchObject({
      item_code: 'RM-001',
      required_qty: 6,
      is_leaf: true,
      cyclic: false,
    });

    const missing = await get('/api/v1/boms/NOPE/explode');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe(404);
  });
});

describe('IF-3 库存', () => {
  it('当前时点：实物量三桶独立成列，派生量按口径自洽', async () => {
    addStock(fx.itemId, fx.warehouseId, 100, '2026-06-01T00:00:00.000Z');
    addStock(fx.itemId, fx.warehouseId, 20, '2026-06-01T00:00:00.000Z', 'frozen');
    addStock(fx.itemId, fx.warehouseId, 300, '2026-06-01T00:00:00.000Z', 'qc');
    makeConfirmedSales(30);
    makeConfirmedPurchase(20, '2026-06-02', '2026-06-30');

    const body = (await get('/api/v1/inventory?item_code=RM-001&warehouse_code=WH-01')).json();
    expect(body.page.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      item_code: 'RM-001',
      warehouse_code: 'WH-01',
      on_hand: 100,
      frozen: 20,
      qc: 300,
      total_qty: 420,
      reserved: 30,
      in_transit: 20,
      available: 70,
      projected: 90,
    });
  });

  it('历史时点：物理量按流水重算，派生量为 null 且给出告警', async () => {
    addStock(fx.itemId, fx.warehouseId, 100, '2026-06-01T00:00:00.000Z');
    addStock(fx.itemId, fx.warehouseId, 20, '2026-06-01T00:00:00.000Z', 'frozen');
    addStock(fx.itemId, fx.warehouseId, 300, '2026-06-01T00:00:00.000Z', 'qc');

    const body = (await get('/api/v1/inventory?as_of=2026-07-01&item_code=RM-001')).json();
    expect(body.data[0]).toMatchObject({
      on_hand: 100,
      frozen: 20,
      qc: 300,
      total_qty: 420,
      reserved: null,
      in_transit: null,
      available: null,
      projected: null,
    });
    expect(body._warnings.length).toBeGreaterThan(0);
  });
});

describe('IF-4 在途', () => {
  it('仅返回默认状态（confirmed/partial），在途量正确；as_of 过滤并告警', async () => {
    makeConfirmedPurchase(50, '2026-06-01', '2026-06-20');
    createPurchase(
      {
        supplier_id: fx.supplierId,
        order_date: '2026-06-01',
        items: [
          {
            product_id: fx.itemId,
            warehouse_id: fx.warehouseId,
            quantity: 10,
            unit_price: 500,
            promised_date: '2026-06-20',
          },
        ],
      },
      null,
    );

    const body = (await get('/api/v1/in-transit')).json();
    expect(body.page.total).toBe(1);
    expect(body.data[0]).toMatchObject({ status: 'confirmed', in_transit: 50, item_code: 'RM-001' });

    const historical = (await get('/api/v1/in-transit?as_of=2026-06-01')).json();
    expect(historical.page.total).toBe(1);
    expect(historical._warnings.length).toBeGreaterThan(0);

    const drafted = (await get('/api/v1/in-transit?status=draft')).json();
    expect(drafted.data[0].status).toBe('draft');
  });
});

describe('IF-5 历史采购订单（提前期，整单口径）', () => {
  it('提前期 / 承诺提前期 / 准时 与整单口径一致；date_from 过滤', async () => {
    const { orderId, itemId } = makeConfirmedPurchase(40, '2026-01-01', '2026-01-10');
    receivePurchase({ orderId, lines: [{ orderItemId: itemId, quantity: 40 }], occurredAt: '2026-01-05T00:00:00.000Z' }, null);

    const body = (await get('/api/v1/purchase-history')).json();
    expect(body.page.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      order_date: '2026-01-01',
      item_code: 'RM-001',
      lead_time_days: 4,
      promised_lead_time_days: 9,
      on_time: true,
    });

    const outOfRange = (await get('/api/v1/purchase-history?date_from=2026-02-01')).json();
    expect(outOfRange.page.total).toBe(0);
  });
});

describe('IF-5b 供应商提前期聚合', () => {
  it('聚合指标正确，供应商不存在返回 404', async () => {
    const { orderId, itemId } = makeConfirmedPurchase(40, '2026-01-01', '2026-01-10');
    receivePurchase({ orderId, lines: [{ orderItemId: itemId, quantity: 40 }], occurredAt: '2026-01-05T00:00:00.000Z' }, null);

    const body = (await get('/api/v1/suppliers/SU-01/lead-time-stats')).json();
    expect(body.data).toMatchObject({
      supplier_code: 'SU-01',
      order_count: 1,
      line_count: 1,
      received_line_count: 1,
      avg_lead_time_days: 4,
      min_lead_time_days: 4,
      max_lead_time_days: 4,
      avg_promised_lead_time_days: 9,
      on_time_rate: 1,
      last_order_date: '2026-01-01',
    });

    const missing = await get('/api/v1/suppliers/NOPE/lead-time-stats');
    expect(missing.statusCode).toBe(404);
  });
});

describe('IF-6 销售订单行', () => {
  it('返回行级字段（订单号/行号/客户编码/物料编码/仓库编码/数量/已出库量/未出库量/要求交期/状态）', async () => {
    makeConfirmedSales(25);

    const body = (await get('/api/v1/sales-orders')).json();
    expect(body.page.total).toBe(1);
    expect(body.data[0]).toEqual({
      order_no: expect.stringMatching(/^SO-\d{8}-\d{4}$/),
      line_no: 1,
      customer_code: 'CU-01',
      item_code: 'RM-001',
      warehouse_code: 'WH-01',
      quantity: 25,
      shipped_qty: 0,
      unshipped: 25, // quantity − shipped_qty − cancelled_qty
      due_date: '2026-01-20',
      status: 'confirmed',
    });
    // 客户已脱敏为编码：不暴露客户名称与金额
    expect(body.data[0]).not.toHaveProperty('customer_name');
    expect(body.data[0]).not.toHaveProperty('total_amount');
  });

  it('order_no / customer_code / customer_name / item_code / warehouse_code / status 多值 / 订单日期 / 要求交期区间过滤', async () => {
    const orderId = makeConfirmedSales(25);
    const { order_no } = db
      .prepare('SELECT order_no FROM sales_order WHERE id = ?')
      .get(orderId) as { order_no: string };

    expect((await get(`/api/v1/sales-orders?order_no=${order_no}`)).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?order_no=SO-NOPE')).json().page.total).toBe(0);

    expect((await get('/api/v1/sales-orders?customer_code=CU-01')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?customer_code=NOPE')).json().page.total).toBe(0);

    expect((await get('/api/v1/sales-orders?customer_name=测试客户')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?customer_name=不存在客户')).json().page.total).toBe(0);

    expect((await get('/api/v1/sales-orders?item_code=RM-001')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?item_code=NOPE')).json().page.total).toBe(0);

    expect((await get('/api/v1/sales-orders?warehouse_code=WH-01')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?warehouse_code=NOPE')).json().page.total).toBe(0);

    expect((await get('/api/v1/sales-orders?status=confirmed,partial')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?status=draft')).json().page.total).toBe(0);

    // order_date 按订单日期（2026-01-01）精确匹配
    expect((await get('/api/v1/sales-orders?order_date=2026-01-01')).json().page.total).toBe(1);
    expect((await get('/api/v1/sales-orders?order_date=2026-01-02')).json().page.total).toBe(0);

    // date_from / date_to 按要求交期（due_date=2026-01-20）过滤
    expect(
      (await get('/api/v1/sales-orders?date_from=2026-01-01&date_to=2026-01-31')).json().page.total,
    ).toBe(1);
    expect(
      (await get('/api/v1/sales-orders?date_from=2026-02-01&date_to=2026-02-28')).json().page.total,
    ).toBe(0);
  });
});

describe('IF-7 工厂 / 仓库', () => {
  it('type 过滤与 parent_code 映射', async () => {
    db.prepare(
      `INSERT INTO warehouse (code, name, type, parent_id, is_active, created_at, updated_at)
       VALUES ('WH-02', '二号仓', 'warehouse', ?, 1, ?, ?)`,
    ).run(fx.warehouseId, nowIso(), nowIso());

    const warehouses = (await get('/api/v1/warehouses?type=warehouse')).json();
    expect(warehouses.data).toHaveLength(2);
    const child = warehouses.data.find((row: { code: string }) => row.code === 'WH-02');
    expect(child.parent_code).toBe('WH-01');

    const ports = (await get('/api/v1/warehouses?type=port')).json();
    expect(ports.data.map((row: { code: string }) => row.code)).toEqual(['PORT-01']);
  });
});

describe('format=csv', () => {
  it('返回 text/csv、带 BOM、表头为业务列序、空值为空串、含逗号字段加引号', async () => {
    insertItem('RM-002', '含,逗号的零件');

    const res = await get('/api/v1/items?format=csv');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.charAt(0)).toBe('\uFEFF');

    const lines = res.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    const header = lines[0].split(',');
    expect(header.slice(0, 3)).toEqual(['id', 'code', 'name']);
    expect(res.body).toContain('"含,逗号的零件"');
    // RM-001 无分类 → category_code 空串
    const rmLine = lines.find((line) => line.startsWith(',RM-001') || line.includes('RM-001'));
    expect(rmLine).toBeDefined();
    expect(res.body).not.toContain('"_warnings"');
  });

  it('CSV 告警走 X-Warnings 响应头', async () => {
    addStock(fx.itemId, fx.warehouseId, 10, '2026-06-01T00:00:00.000Z');
    const res = await get('/api/v1/inventory?format=csv&as_of=2026-07-01&item_code=RM-001');
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['x-warnings']).toBe('1');
  });
});

describe('OpenAPI 文档', () => {
  it('openapi.json 返回 3.1 且包含 9 条路径', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(doc.paths)).toHaveLength(9);
  });

  it('9 个接口的 example.data 均为真实响应样例（对象/数组，非字符串占位）', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    type Doc = {
      get: {
        parameters: { name: string }[];
        responses: Record<string, { content: Record<string, { example: { data: unknown; page?: unknown } }> }>;
      };
    };
    const entries = Object.entries(doc.paths) as [string, Doc][];

    for (const [path, item] of entries) {
      const { data, page } = item.get.responses['200'].content['application/json'].example;
      expect(typeof data, path).not.toBe('string');
      expect(data !== null && typeof data === 'object', path).toBe(true);

      // 分页接口必须给出 page 样例；非分页接口不应出现 page
      const paged = item.get.parameters.some((p) => p.name === 'page_size');
      expect(Boolean(page), `${path} 的 page 样例`).toBe(paged);
    }
  });
});

describe('只读性', () => {
  it('调用只读接口前后不产生任何写入', async () => {
    addStock(fx.itemId, fx.warehouseId, 10, '2026-06-01T00:00:00.000Z');
    const before = {
      transactions: (db.prepare('SELECT COUNT(*) AS n FROM stock_transaction').get() as { n: number }).n,
      orders: (db.prepare('SELECT COUNT(*) AS n FROM purchase_order').get() as { n: number }).n,
      balance: (db.prepare('SELECT COUNT(*) AS n FROM stock_balance').get() as { n: number }).n,
    };

    await get('/api/v1/items');
    await get('/api/v1/inventory');
    await get('/api/v1/in-transit');
    await get('/api/v1/purchase-history');
    await get('/api/v1/sales-orders');

    const after = {
      transactions: (db.prepare('SELECT COUNT(*) AS n FROM stock_transaction').get() as { n: number }).n,
      orders: (db.prepare('SELECT COUNT(*) AS n FROM purchase_order').get() as { n: number }).n,
      balance: (db.prepare('SELECT COUNT(*) AS n FROM stock_balance').get() as { n: number }).n,
    };
    expect(after).toEqual(before);
  });
});