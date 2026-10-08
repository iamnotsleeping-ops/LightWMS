import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { changeStockStatus, postMovement } from './stock.engine';
import { queryBalances, queryStockList, queryTransactions } from './stock.query';

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

const now = '2026-01-01T00:00:00.000Z';

function insertPurchaseOrder(status: string, quantity: number, receivedQty: number): void {
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO purchase_order (order_no, supplier_id, order_date, status, total_amount, created_at, updated_at)
         VALUES (?, ?, '2026-01-01', ?, 0, ?, ?)`,
      )
      .run(`PO-${status}-${quantity}`, fx.supplierId, status, now, now).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO purchase_order_item
       (order_id, line_no, product_id, warehouse_id, quantity, unit_price, amount,
        received_qty, cancelled_qty, promised_date, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, 0, 0, ?, 0, '2026-01-10', ?, ?)`,
  ).run(orderId, fx.itemId, fx.warehouseId, quantity, receivedQty, now, now);
}

function insertSalesOrder(status: string, quantity: number, shippedQty: number): void {
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO sales_order (order_no, customer_id, order_date, status, total_amount, created_at, updated_at)
         VALUES (?, ?, '2026-01-01', ?, 0, ?, ?)`,
      )
      .run(`SO-${status}-${quantity}`, fx.customerId, status, now, now).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO sales_order_item
       (order_id, line_no, product_id, warehouse_id, quantity, unit_price, amount,
        shipped_qty, cancelled_qty, due_date, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, 0, 0, ?, 0, '2026-01-20', ?, ?)`,
  ).run(orderId, fx.itemId, fx.warehouseId, quantity, shippedQty, now, now);
}

function insertTransferOrder(status: string, quantity: number, shippedQty: number): void {
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO transfer_order (order_no, from_warehouse_id, to_warehouse_id, order_date, status, created_at, updated_at)
         VALUES (?, ?, ?, '2026-01-01', ?, ?, ?)`,
      )
      .run(`TR-${status}-${quantity}`, fx.portWarehouseId, fx.warehouseId, status, now, now)
      .lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO transfer_order_item
       (order_id, line_no, product_id, quantity, shipped_qty, received_qty, cancelled_qty, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, 0, 0, ?, ?)`,
  ).run(orderId, fx.itemId, quantity, shippedQty, now, now);
}

const stockQuery = { page: 1, pageSize: 20 };

describe('采购在途', () => {
  it('只统计 confirmed / partial 的未执行部分，received 与 cancelled 一律排除', () => {
    insertPurchaseOrder('confirmed', 100, 60);
    insertPurchaseOrder('received', 100, 100);
    insertPurchaseOrder('cancelled', 100, 0);

    const { list } = queryStockList(stockQuery);
    expect(list).toHaveLength(1);
    expect(list[0].in_transit).toBe(40);
    expect(list[0].on_hand).toBe(0);
    expect(list[0].projected).toBe(40);
  });

  it('在途充足时 projected 为正，不因现有库存为 0 而误判缺货', () => {
    insertPurchaseOrder('confirmed', 100, 0);
    const { list } = queryStockList(stockQuery);
    expect(list[0].on_hand).toBe(0);
    expect(list[0].projected).toBe(100);
  });
});

describe('销售预留与可用量', () => {
  it('reserved 取已确认未出库数量，available 允许为负而不做兜底裁剪', () => {
    insertSalesOrder('confirmed', 100, 40);
    insertSalesOrder('cancelled', 100, 0);

    const { list } = queryStockList(stockQuery);
    expect(list[0].reserved).toBe(60);
    expect(list[0].on_hand).toBe(0);
    expect(list[0].available).toBe(-60);
  });

  it('现有库存为 0 时不出现 reserved 为负的干扰行', () => {
    insertSalesOrder('confirmed', 50, 50);
    const { list } = queryStockList(stockQuery);
    expect(list).toHaveLength(0);
  });
});

describe('调拨在途', () => {
  it('已发货未收货的数量归属调入仓', () => {
    insertTransferOrder('shipped', 20, 20);

    const { list } = queryStockList(stockQuery);
    const toRow = list.find((row) => row.warehouse_id === fx.warehouseId);
    expect(toRow?.in_transit).toBe(20);
    expect(toRow?.projected).toBe(20);
  });

  it('调拨已收货后不再计入在途', () => {
    insertTransferOrder('received', 20, 20);
    const { list } = queryStockList(stockQuery);
    expect(list.find((row) => row.warehouse_id === fx.warehouseId)?.in_transit ?? 0).toBe(0);
  });
});

describe('港口仓口径', () => {
  beforeEach(() => {
    postMovement({
      productId: fx.portItemId,
      warehouseId: fx.portWarehouseId,
      stockStatus: 'available',
      bizType: 'purchase_in',
      direction: 1,
      quantity: 50,
      unitCost: 100,
    });
  });

  it('port_stock_as_inventory=false 时港口仓不计入库存', () => {
    const result = queryStockList(stockQuery);
    expect(result.portAsInventory).toBe(false);
    expect(result.list.some((row) => row.warehouse_id === fx.portWarehouseId)).toBe(false);
  });

  it('port_stock_as_inventory=true 时港口仓计入库存', () => {
    db.prepare("UPDATE sys_param SET value = 'true' WHERE key = 'port_stock_as_inventory'").run();

    const result = queryStockList(stockQuery);
    expect(result.portAsInventory).toBe(true);
    const portRow = result.list.find((row) => row.warehouse_id === fx.portWarehouseId);
    expect(portRow?.on_hand).toBe(50);
  });
});

describe('as_of 历史时点', () => {
  beforeEach(() => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-02-01T00:00:00.000Z';
    const t3 = '2026-03-01T00:00:00.000Z';
    const base = {
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      stockStatus: 'available' as const,
    };
    // 故意乱序写入：先出库后入库，验证结果只由 occurred_at 决定
    postMovement({ ...base, bizType: 'sale_out', direction: -1, quantity: 30, occurredAt: t2 });
    postMovement({ ...base, bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500, occurredAt: t1 });
    postMovement({ ...base, bizType: 'purchase_in', direction: 1, quantity: 10, unitCost: 500, occurredAt: t3 });
  });

  it('从流水重算而非近似当前余额', () => {
    const current = queryStockList(stockQuery);
    expect(current.list[0].on_hand).toBe(80);

    const atFirst = queryStockList({ ...stockQuery, asOf: '2026-01-15' });
    expect(atFirst.list[0].on_hand).toBe(100);

    const atSecond = queryStockList({ ...stockQuery, asOf: '2026-02-01' });
    expect(atSecond.asOf).toBe('2026-02-01T23:59:59.999Z');
    expect(atSecond.list[0].on_hand).toBe(70);
  });

  it('历史时点的预留与在途不可还原，返回 null', () => {
    insertPurchaseOrder('confirmed', 100, 0);
    const result = queryStockList({ ...stockQuery, asOf: '2026-02-01' });

    expect(result.list[0].reserved).toBeNull();
    expect(result.list[0].in_transit).toBeNull();
    expect(result.list[0].available).toBeNull();
    expect(result.list[0].projected).toBeNull();
  });
});

describe('余额明细与流水查询', () => {
  it('余额按三状态拆分并保留仓库成本', () => {
    postMovement({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      stockStatus: 'available',
      bizType: 'purchase_in',
      direction: 1,
      quantity: 100,
      unitCost: 500,
    });
    changeStockStatus({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      fromStatus: 'available',
      toStatus: 'qc',
      quantity: 30,
    });

    const rows = queryBalances({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      available_qty: 70,
      frozen_qty: 0,
      qc_qty: 30,
      total_qty: 100,
      avg_cost: 500,
    });
  });

  it('流水查询支持按业务类型筛选与分页', () => {
    const base = {
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      stockStatus: 'available' as const,
    };
    postMovement({ ...base, bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    postMovement({ ...base, bizType: 'sale_out', direction: -1, quantity: 20 });

    expect(queryTransactions({ page: 1, pageSize: 10 }).page.total).toBe(2);
    const filtered = queryTransactions({ page: 1, pageSize: 10, bizType: 'purchase_in' });
    expect(filtered.page.total).toBe(1);
    expect(filtered.list[0].biz_type).toBe('purchase_in');
  });
});