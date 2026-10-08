import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { createAlertRule, queryAlerts } from '../inventory/alert.service';
import { changeStockStatus, postMovement } from '../inventory/stock.engine';
import {
  confirmTransfer,
  createTransfer,
  shipTransfer,
} from '../inventory/transfer.service';
import {
  confirmOrder as confirmPurchase,
  createOrder as createPurchase,
} from '../purchase/purchase.service';
import {
  confirmOrder as confirmSales,
  createOrder as createSales,
} from '../sales/sales.service';

let db: Db;
let fx: Fixtures;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  db = createTestDb();
  fx = seedFixtures(db);
  app = await buildApp();
  // 看板仅需登录，无权限码
  token = app.jwt.sign({ sub: 1, name: 'tester', roles: ['viewer'], permissions: [] });
});

afterEach(async () => {
  await app.close();
});

const get = (bearer: string | null = token) =>
  app.inject({
    method: 'GET',
    url: '/api/dashboard/overview',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

function addStock(
  quantity: number,
  warehouseId: number = fx.warehouseId,
  productId: number = fx.itemId,
  occurredAt: string = new Date().toISOString(),
): void {
  postMovement({
    productId,
    warehouseId,
    stockStatus: 'available',
    bizType: 'adjust',
    direction: 1,
    quantity,
    unitCost: 500,
    occurredAt,
  });
}

function makeConfirmedPurchase(quantity: number): number {
  const { id } = createPurchase(
    {
      supplier_id: fx.supplierId,
      order_date: '2026-01-01',
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: fx.warehouseId,
          quantity,
          unit_price: 500,
          promised_date: '2026-01-20',
        },
      ],
    },
    null,
  );
  confirmPurchase(id);
  return id;
}

function makeSales(quantity: number, confirm: boolean): number {
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
  if (confirm) confirmSales(id);
  return id;
}

describe('看板 · 鉴权', () => {
  it('未登录 401、登录 200', async () => {
    const anonymous = await get(null);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().code).toBe(401);

    const allowed = await get();
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().code).toBe(0);
  });
});

describe('IF-D1 kpi', () => {
  it('on_hand_qty / on_hand_amount / item_count / in_transit_qty / alert_count 与造数一致', async () => {
    addStock(100);
    makeConfirmedPurchase(20);
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 150, max_qty: null });

    const body = (await get()).json();
    expect(body.data.kpi).toEqual({
      on_hand_qty: 100,
      on_hand_amount: 50000,
      item_count: 2,
      in_transit_qty: 20,
      alert_count: 1,
    });
  });
});

describe('IF-D1 trend', () => {
  it('长度为 30、日期连续升序、按日聚合并排除 status_change', async () => {
    addStock(100);
    changeStockStatus({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      fromStatus: 'available',
      toStatus: 'frozen',
      quantity: 40,
    });

    const body = (await get()).json();
    const trend = body.data.trend as { date: string; in_qty: number; out_qty: number }[];
    expect(trend).toHaveLength(30);

    for (let i = 1; i < trend.length; i += 1) {
      const prev = Date.parse(`${trend[i - 1].date}T00:00:00.000Z`);
      const curr = Date.parse(`${trend[i].date}T00:00:00.000Z`);
      expect(curr - prev).toBe(86_400_000);
    }
    expect(trend[29].date).toBe(new Date().toISOString().slice(0, 10));

    // 今日仅计入 adjust 入库 100，status_change 的成对出入被排除
    expect(trend[29]).toMatchObject({ in_qty: 100, out_qty: 0 });
  });
});

describe('IF-D1 alerts / todos', () => {
  it('alerts 条数与 queryAlerts 一致，below_min 优先', async () => {
    addStock(100, fx.warehouseId);
    addStock(100, fx.portWarehouseId);
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 150, max_qty: null });
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.portWarehouseId, min_qty: 0, max_qty: 50 });

    const body = (await get()).json();
    expect(body.data.alerts).toHaveLength(queryAlerts({}).length);
    expect(body.data.alerts).toHaveLength(2);
    expect(body.data.alerts[0].alert_type).toBe('below_min');
    expect(body.data.alerts[1].alert_type).toBe('above_max');
  });

  it('todos 各计数与单据状态一致', async () => {
    createPurchase(
      {
        supplier_id: fx.supplierId,
        order_date: '2026-01-01',
        items: [
          { product_id: fx.itemId, warehouse_id: fx.warehouseId, quantity: 5, unit_price: 500, promised_date: '2026-01-20' },
        ],
      },
      null,
    );
    makeConfirmedPurchase(10);
    makeSales(5, false);
    makeSales(5, true);

    addStock(100);
    const { id } = createTransfer(
      {
        from_warehouse_id: fx.warehouseId,
        to_warehouse_id: fx.portWarehouseId,
        order_date: '2026-01-01',
        items: [{ product_id: fx.itemId, quantity: 10 }],
      },
      null,
    );
    confirmTransfer(id);
    shipTransfer(id);

    const body = (await get()).json();
    expect(body.data.todos).toEqual({
      purchase_draft: 1,
      purchase_pending_inbound: 1,
      sales_draft: 1,
      sales_pending_outbound: 1,
      transfer_in_transit: 1,
    });
  });
});