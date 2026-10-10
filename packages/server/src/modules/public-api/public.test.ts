import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  publicBomExplodeQuerySchema,
  publicBomsQuerySchema,
  publicInTransitQuerySchema,
  publicInventoryQuerySchema,
  publicItemsQuerySchema,
  publicLeadTimeStatsQuerySchema,
  publicPurchaseHistoryQuerySchema,
  publicSalesOrdersQuerySchema,
  publicSubstitutesQuerySchema,
  publicSubstitutionPlanQuerySchema,
  publicWarehousesQuerySchema,
} from '@light-erp/shared';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { postMovement } from '../inventory/stock.engine';
import { confirmOrder as confirmPurchase, createOrder as createPurchase } from '../purchase/purchase.service';
import { receivePurchase } from '../purchase/purchase.inbound';
import {
  cancelOrder as cancelSales,
  confirmOrder as confirmSales,
  createOrder as createSales,
} from '../sales/sales.service';

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

interface SubstituteOptions {
  parentItemId?: number | null;
  warehouseId?: number | null;
  priority?: number;
  ratioNum?: number;
  ratioDen?: number;
  scene?: 'sales_out' | 'bom_plan' | 'purchase_hint';
  strategy?: 'proportion' | 'whole_batch' | 'manual';
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive?: number;
}

/** 直接落一条替代关系（替代关系必须在物料存在之后插入） */
function insertSubstitute(mainItemId: number, subItemId: number, options: SubstituteOptions = {}): void {
  db.prepare(
    `INSERT INTO item_substitute
       (main_item_id, sub_item_id, parent_item_id, warehouse_id, priority, ratio_num, ratio_den,
        scene, strategy, cross_warehouse, effective_from, effective_to, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    mainItemId,
    subItemId,
    options.parentItemId ?? null,
    options.warehouseId ?? null,
    options.priority ?? 1,
    options.ratioNum ?? 1,
    options.ratioDen ?? 1,
    options.scene ?? 'sales_out',
    options.strategy ?? 'proportion',
    options.effectiveFrom ?? null,
    options.effectiveTo ?? null,
    options.isActive ?? 1,
    nowIso(),
    nowIso(),
  );
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
  it('11 条接口不带 Authorization 均返回 200（公开无鉴权）', async () => {
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
      '/api/v1/substitutes?main_item_code=RM-001',
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=1',
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
  it('返回行级字段（订单号/行号/订单日期/客户编码/物料编码/仓库编码/数量/已出库量/未出库量/要求交期/状态）', async () => {
    makeConfirmedSales(25);

    const body = (await get('/api/v1/sales-orders')).json();
    expect(body.page.total).toBe(1);
    expect(body.data[0]).toEqual({
      order_no: expect.stringMatching(/^SO-\d{8}-\d{4}$/),
      line_no: 1,
      order_date: '2026-01-01',
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

  // 回归：缺省曾返回全部状态，导致 draft / cancelled 订单的整行数量被计入「未出库量」，
  // 下游按 unshipped 求和的待出库需求被系统性高估（与内部 reserved 口径不一致）。
  it('缺省只返回未结需求（confirmed / partial），draft 与 cancelled 不计入，并给出告警', async () => {
    const salesBody = (quantity: number) => ({
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
    });

    const confirmedId = createSales(salesBody(25), null).id;
    confirmSales(confirmedId);
    createSales(salesBody(40), null); // 保持 draft
    const cancelledId = createSales(salesBody(60), null).id;
    confirmSales(cancelledId);
    cancelSales(cancelledId);

    const defaultBody = (await get('/api/v1/sales-orders')).json();
    expect(defaultBody.page.total).toBe(1);
    expect(defaultBody.data[0]).toMatchObject({ quantity: 25, unshipped: 25, status: 'confirmed' });
    // 未出库量合计只反映未结需求 25，而不是 25 + 40 + 60
    expect(
      defaultBody.data.reduce((sum: number, row: { unshipped: number }) => sum + row.unshipped, 0),
    ).toBe(25);
    expect(defaultBody._warnings.join('\n')).toContain('缺省仅返回未结需求');

    // 需要历史全量时显式传 status（含逗号分隔多值）
    const explicit = (await get('/api/v1/sales-orders?status=draft,confirmed,cancelled')).json();
    expect(explicit.page.total).toBe(3);
    expect(explicit._warnings).toEqual([]);
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

describe('IF-8 替代关系（关系清单）', () => {
  it('只返回该主料的关系；仓过滤含全仓通用；parent_item_code 映射与优先级排序正确', async () => {
    const subA = insertItem('RM-002', '替代料甲');
    const subB = insertItem('RM-003', '替代料乙');
    const subC = insertItem('RM-004', '替代料丙');
    // 另一主料（FG-001）的关系：不应出现在 RM-001 的结果里
    insertSubstitute(fx.portItemId, subA, { priority: 1 });
    // 全仓通用（warehouse_id / parent_item_id 均为 NULL），优先级 2
    insertSubstitute(fx.itemId, subA, { priority: 2 });
    // 该仓 + 该父件专属，优先级 1
    insertSubstitute(fx.itemId, subB, {
      priority: 1,
      warehouseId: fx.warehouseId,
      parentItemId: fx.portItemId,
      scene: 'bom_plan',
    });
    // 其它仓库专属：按 WH-01 过滤时应被排除
    insertSubstitute(fx.itemId, subC, { priority: 3, warehouseId: fx.portWarehouseId });

    const all = (await get('/api/v1/substitutes?main_item_code=RM-001')).json();
    expect(all.code).toBe(0);
    expect(all.page.total).toBe(3);
    expect(all.data.map((row: { sub_item_code: string }) => row.sub_item_code)).toEqual([
      'RM-003',
      'RM-002',
      'RM-004',
    ]);

    const filtered = (await get('/api/v1/substitutes?main_item_code=RM-001&warehouse_code=WH-01')).json();
    expect(filtered.page.total).toBe(2);
    expect(filtered.data.map((row: { sub_item_code: string }) => row.sub_item_code)).toEqual([
      'RM-003',
      'RM-002',
    ]);
    // 仓专属行：父件映射为编码、仓库映射为编码
    expect(filtered.data[0]).toEqual({
      main_item_code: 'RM-001',
      main_item_name: '测试零件',
      sub_item_code: 'RM-003',
      sub_item_name: '替代料乙',
      sub_base_unit: 'EA',
      parent_item_code: 'FG-001',
      warehouse_code: 'WH-01',
      priority: 1,
      ratio_num: 1,
      ratio_den: 1,
      scene: 'bom_plan',
      strategy: 'proportion',
      effective_from: null,
      effective_to: null,
      is_active: 1,
    });
    // 通用行：父件 / 仓库均为 null
    expect(filtered.data[1]).toMatchObject({
      sub_item_code: 'RM-002',
      parent_item_code: null,
      warehouse_code: null,
    });

    // scene 过滤
    const bomScene = (await get('/api/v1/substitutes?main_item_code=RM-001&scene=bom_plan')).json();
    expect(bomScene.data.map((row: { sub_item_code: string }) => row.sub_item_code)).toEqual(['RM-003']);
  });

  it('未知 main_item_code 返回空列表且 code=0', async () => {
    const body = (await get('/api/v1/substitutes?main_item_code=NOPE')).json();
    expect(body.code).toBe(0);
    expect(body.data).toEqual([]);
    expect(body.page.total).toBe(0);
  });

  it('as_of 过滤生效期：当天到期仍有效，前一天到期已失效', async () => {
    const subA = insertItem('RM-002', '替代料甲');
    const subB = insertItem('RM-003', '替代料乙');
    insertSubstitute(fx.itemId, subA, {
      priority: 1,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30',
    });
    insertSubstitute(fx.itemId, subB, {
      priority: 2,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-29',
    });

    // effective_to = as_of 当天视为仍有效
    const onLastDay = (await get('/api/v1/substitutes?main_item_code=RM-001&as_of=2026-06-30')).json();
    expect(onLastDay.data.map((row: { sub_item_code: string }) => row.sub_item_code)).toEqual(['RM-002']);
    // 关系清单接口的 as_of 只筛生效期，需明示可用量不在本接口范围内
    expect(onLastDay._warnings.join('\n')).toContain('可用库存始终为当前时点');

    const afterBoth = (await get('/api/v1/substitutes?main_item_code=RM-001&as_of=2026-07-01')).json();
    expect(afterBoth.data).toEqual([]);
  });
});

describe('IF-9 替代规划（只读试算）', () => {
  /** 主料 30、替代料 subStock，1:1 比例关系 */
  function seedMainPlusSubstitute(subStock: number): number {
    const subId = insertItem('RM-002', '替代料甲');
    insertSubstitute(fx.itemId, subId, { priority: 1, strategy: 'proportion' });
    addStock(fx.itemId, fx.warehouseId, 30, '2026-06-01T00:00:00.000Z');
    addStock(subId, fx.warehouseId, subStock, '2026-06-01T00:00:00.000Z');
    return subId;
  }

  it('proportion：主料 30 + 替代料 200 满足需求 100，缺口为 0', async () => {
    seedMainPlusSubstitute(200);

    const body = (
      await get('/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100')
    ).json();
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      main_item_code: 'RM-001',
      warehouse_code: 'WH-01',
      scene: 'sales_out',
      strategy: 'proportion',
      required_qty: 100,
      filled_qty: 100,
      gap_qty: 0,
    });
    expect(body.data.allocations).toEqual([
      {
        item_code: 'RM-001',
        item_name: '测试零件',
        quantity: 30,
        covered_qty: 30,
        is_main: true,
        on_hand: 30,
        unit_cost: 500,
        ratio_num: 1,
        ratio_den: 1,
      },
      {
        item_code: 'RM-002',
        item_name: '替代料甲',
        quantity: 70,
        covered_qty: 70,
        is_main: false,
        on_hand: 200,
        unit_cost: 500,
        ratio_num: 1,
        ratio_den: 1,
      },
    ]);
    expect(body.data.skipped).toEqual([]);
    // 规划不写任何常驻告警：口径由字段名 on_hand + OpenAPI/README 承载
    expect(body._warnings).toEqual([]);
  });

  it('whole_batch：无单一物料可整批覆盖时不混用，gap_qty=需求量 且给出告警', async () => {
    const subId = insertItem('RM-002', '替代料甲');
    insertSubstitute(fx.itemId, subId, { priority: 1, strategy: 'whole_batch' });
    addStock(fx.itemId, fx.warehouseId, 30, '2026-06-01T00:00:00.000Z');
    addStock(subId, fx.warehouseId, 50, '2026-06-01T00:00:00.000Z');

    const body = (
      await get(
        '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100&strategy=whole_batch',
      )
    ).json();
    expect(body.data.strategy).toBe('whole_batch');
    expect(body.data.filled_qty).toBe(0);
    expect(body.data.gap_qty).toBe(100);
    // 宁可缺料也不拆批：未分配任何物料
    expect(body.data.allocations).toEqual([]);
    expect(body._warnings.join('\n')).toContain('整批全量策略');
  });

  it('主料 / 仓库 / 客户 / 父件编码未知均返回 404', async () => {
    const missingItem = await get(
      '/api/v1/substitution-plan?main_item_code=NOPE&warehouse_code=WH-01&required_qty=10',
    );
    expect(missingItem.statusCode).toBe(404);
    expect(missingItem.json().code).toBe(404);
    expect(missingItem.json().message).toContain('物料不存在');

    const missingWarehouse = await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=NOPE&required_qty=10',
    );
    expect(missingWarehouse.statusCode).toBe(404);
    expect(missingWarehouse.json().message).toContain('仓库不存在');

    const missingCustomer = await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=10&customer_code=NOPE',
    );
    expect(missingCustomer.statusCode).toBe(404);
    expect(missingCustomer.json().message).toContain('客户不存在');

    const missingParent = await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=10&parent_item_code=NOPE',
    );
    expect(missingParent.statusCode).toBe(404);
    expect(missingParent.json().message).toContain('父件物料不存在');
  });

  it('format=csv 返回 text/csv、带 BOM、一行 = 一条分配', async () => {
    seedMainPlusSubstitute(200);

    const res = await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100&format=csv',
    );
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.charAt(0)).toBe('\uFEFF');

    const lines = res.body.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('item_code');
    expect(lines[0]).toContain('is_main');
    expect(lines).toHaveLength(3); // 表头 + 主料 1 行 + 替代料 1 行
    expect(lines[1]).toContain('RM-001');
    expect(lines[2]).toContain('RM-002');
    // CSV 不套信封
    expect(res.body).not.toContain('"_warnings"');
  });

  it('指定 as_of 时给出「可用量仍为当前时点」的告警', async () => {
    seedMainPlusSubstitute(200);

    const body = (
      await get(
        '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100&as_of=2026-06-15',
      )
    ).json();
    expect(body.data.as_of).toBe('2026-06-15');
    expect(body._warnings.join('\n')).toContain('可用库存与成本始终为当前时点');
    // as_of 不影响可用量取数：分配照常给出
    expect(body.data.allocations).toHaveLength(2);
    expect(body.data.gap_qty).toBe(0);
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
  it('openapi.json 返回 3.1 且包含 11 条路径', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(doc.paths)).toHaveLength(11);
  });

  /**
   * 「数据接口」页由 OpenAPI 渲染，本断言保证它永远渲染得完整。
   *
   * 此前该页在前端硬编码接口清单，新增 IF-8 / IF-9 后页面仍显示 9 条（双源漂移）。
   * 现在页面只读 OpenAPI，因此这里把「渲染所需字段」变成契约的一部分：
   * 缺 summary（IF-x 编号 + 标题）或 x-returns 的接口会让页面出现残缺行——
   * 与其在页面上兜底，不如让漏写在测试阶段就失败。
   */
  /**
   * 提前期口径是下游对账的依赖项（专门问过"整单口径还是行级"），
   * 所以把结论钉在文档里，防止有人日后顺手把 description 删掉、又回到靠口头对齐。
   */
  it('IF-5 / IF-5b 的 description 写明提前期口径（整单口径、样本偏乐观）', async () => {
    const body = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const doc = body.json() as {
      paths: Record<string, { get: { description?: string } }>;
    };
    const if5 = doc.paths['/purchase-history'].get.description ?? '';
    const if5b = doc.paths['/suppliers/{code}/lead-time-stats'].get.description ?? '';
    // IF-5：整单口径 + 同一订单各行相同 + 行级字段清单 + 无行级到货时刻
    expect(if5).toContain('整单口径');
    expect(if5).toContain('必然相同');
    expect(if5).toContain('不含行号');
    // IF-5b：承诺口径 vs 实际口径 + 样本只含已到货（偏乐观）+ 不设最小样本量
    expect(if5b).toContain('承诺');
    expect(if5b).toContain('偏乐观');
    expect(if5b).toContain('不设最小样本量');
  });

  it('每个对外接口都带 IF-x 编号的 summary 与 x-returns（数据接口页据此渲染）', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    type Doc = { get: { summary?: string; 'x-returns'?: string } };
    const entries = Object.entries(doc.paths) as [string, Doc][];
    expect(entries).toHaveLength(11);

    for (const [path, operations] of entries) {
      expect(operations.get.summary, `${path} 缺 summary`).toBeTruthy();
      expect(operations.get.summary, `${path} 的 summary 未以 IF-x 开头`).toMatch(/^IF-\S+\s+\S/);
      expect(operations.get['x-returns'], `${path} 缺 x-returns`).toBeTruthy();
      expect(operations.get['x-returns']?.length ?? 0).toBeGreaterThan(1);
    }

    // 编号不得重复，否则页面上会出现两行同名条目
    const ifNos = entries.map(([, operations]) => operations.get.summary?.split(' ')[0]);
    expect(new Set(ifNos).size).toBe(ifNos.length);
  });

  /**
   * OpenAPI 的参数列表必须与鉴权/校验用的 zod schema 完全一致。
   *
   * 起因：`/items` 实际支持 `is_active`（schema 与 SQL 都有），但 openapi.ts 漏写，
   * 于是「数据接口」页少显示一个参数、下游照文档也筛不了。文档与契约分离时这类遗漏
   * 不会有任何测试失败，因此这里直接把两者绑死（对齐方向：以 schema 为准）。
   */
  it('每个对外接口的 OpenAPI 参数与 zod schema 逐字一致（含 is_active 这类易漏项）', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    const routeToSchema: [string, { shape: Record<string, unknown> }][] = [
      ['/items', publicItemsQuerySchema],
      ['/boms', publicBomsQuerySchema],
      ['/boms/{itemCode}/explode', publicBomExplodeQuerySchema],
      ['/inventory', publicInventoryQuerySchema],
      ['/in-transit', publicInTransitQuerySchema],
      ['/purchase-history', publicPurchaseHistoryQuerySchema],
      ['/suppliers/{code}/lead-time-stats', publicLeadTimeStatsQuerySchema],
      ['/sales-orders', publicSalesOrdersQuerySchema],
      ['/warehouses', publicWarehousesQuerySchema],
      ['/substitutes', publicSubstitutesQuerySchema],
      ['/substitution-plan', publicSubstitutionPlanQuerySchema],
    ];

    for (const [path, schema] of routeToSchema) {
      const documented = (doc.paths[path].get.parameters as { name: string; in: string }[])
        .filter((param) => param.in === 'query')
        .map((param) => param.name)
        .sort();
      expect(documented, `${path} 的 OpenAPI 查询参数与 schema 不一致`).toEqual(
        Object.keys(schema.shape).sort(),
      );
    }
  });

  it('11 个接口的 example.data 均为真实响应样例（对象/数组，非字符串占位）', async () => {
    const doc = (await get('/api/v1/openapi.json')).json();
    type Doc = {
      get: {
        parameters: { name: string }[];
        responses: Record<string, { content: Record<string, { example: { data: unknown; page?: unknown } }> }>;
      };
    };
    const entries = Object.entries(doc.paths) as [string, Doc][];
    // 返回 page 的分页接口；IF-9 虽接收 page / page_size 但整体返回，不带 page
    const pagedPaths = new Set([
      '/items',
      '/inventory',
      '/in-transit',
      '/purchase-history',
      '/sales-orders',
      '/substitutes',
    ]);

    for (const [path, item] of entries) {
      const { data, page } = item.get.responses['200'].content['application/json'].example;
      expect(typeof data, path).not.toBe('string');
      expect(data !== null && typeof data === 'object', path).toBe(true);
      expect(Boolean(page), `${path} 的 page 样例`).toBe(pagedPaths.has(path));
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

  it('IF-8 / IF-9 调用前后 stock_transaction / stock_balance / item_substitute 行数不变', async () => {
    const subId = insertItem('RM-002', '替代料甲');
    insertSubstitute(fx.itemId, subId, { priority: 1 });
    addStock(fx.itemId, fx.warehouseId, 30, '2026-06-01T00:00:00.000Z');
    addStock(subId, fx.warehouseId, 200, '2026-06-01T00:00:00.000Z');

    const counts = () => ({
      transactions: (db.prepare('SELECT COUNT(*) AS n FROM stock_transaction').get() as { n: number }).n,
      balance: (db.prepare('SELECT COUNT(*) AS n FROM stock_balance').get() as { n: number }).n,
      substitutes: (db.prepare('SELECT COUNT(*) AS n FROM item_substitute').get() as { n: number }).n,
    });
    const before = counts();

    await get('/api/v1/substitutes?main_item_code=RM-001');
    await get('/api/v1/substitutes?main_item_code=RM-001&warehouse_code=WH-01&format=csv');
    await get('/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100');
    await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100&format=csv',
    );
    await get(
      '/api/v1/substitution-plan?main_item_code=RM-001&warehouse_code=WH-01&required_qty=100&customer_code=CU-01&as_of=2026-06-15',
    );

    expect(counts()).toEqual(before);
  });
});