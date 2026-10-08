import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { receivePurchase } from '../purchase/purchase.inbound';
import {
  confirmOrder as confirmPurchase,
  createOrder as createPurchaseOrder,
  getOrderDetail as getPurchaseDetail,
} from '../purchase/purchase.service';
import { readBalanceByStatus, readWarehouseCost } from './stock.engine';
import { queryStockList } from './stock.query';
import {
  cancelTransfer,
  confirmTransfer,
  createTransfer,
  deleteTransfer,
  getTransferDetail,
  receiveTransfer,
  shipTransfer,
  updateTransfer,
} from './transfer.service';

let db: Db;
let fx: Fixtures;
let targetWarehouseId: number;

const ORDER_DATE = '2026-02-10';

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
  const now = new Date().toISOString();
  targetWarehouseId = Number(
    db
      .prepare(
        `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
         VALUES ('WH-02', '二号仓', 'warehouse', 1, ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  );
});

function transferItem(overrides: Partial<{ product_id: number; quantity: number }> = {}) {
  return { product_id: fx.itemId, quantity: 100, ...overrides };
}

function createDraft(items = [transferItem()], orderDate = ORDER_DATE) {
  return createTransfer(
    {
      from_warehouse_id: fx.warehouseId,
      to_warehouse_id: targetWarehouseId,
      order_date: orderDate,
      items,
    },
    null,
  );
}

/** 通过采购入库在指定仓库制造物理库存 */
function seedStock(warehouseId: number, quantity: number, unitPrice = 500): void {
  const { id } = createPurchaseOrder(
    {
      supplier_id: fx.supplierId,
      order_date: '2026-02-01',
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: warehouseId,
          quantity,
          unit_price: unitPrice,
          promised_date: '2026-02-03',
        },
      ],
    },
    null,
  );
  confirmPurchase(id);
  const itemId = getPurchaseDetail(id).items[0].id;
  receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity }] }, null);
}

function inTransitOf(warehouseId: number): number {
  const { list } = queryStockList({
    page: 1,
    pageSize: 20,
    productId: fx.itemId,
    warehouseId,
  });
  return (list[0] as { in_transit: number | null } | undefined)?.in_transit ?? 0;
}

function transactionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM stock_transaction').get() as { c: number }).c;
}

describe('单号序列', () => {
  it('同日递增、跨日重置', () => {
    const a = createDraft([transferItem()], '2026-04-01');
    const b = createDraft([transferItem()], '2026-04-01');
    const c = createDraft([transferItem()], '2026-04-02');

    expect(a.order_no).toBe('TR-20260401-0001');
    expect(b.order_no).toBe('TR-20260401-0002');
    expect(c.order_no).toBe('TR-20260402-0001');
  });
});

describe('新建草稿', () => {
  it('状态为 draft，两端仓库不能相同', () => {
    const { id } = createDraft();
    expect(getTransferDetail(id).order.status).toBe('draft');

    expect(() =>
      createTransfer(
        {
          from_warehouse_id: fx.warehouseId,
          to_warehouse_id: fx.warehouseId,
          order_date: ORDER_DATE,
          items: [transferItem()],
        },
        null,
      ),
    ).toThrow(ApiError);
  });

  it('更新草稿：整体替换表体，非草稿不可改', () => {
    const { id } = createDraft();
    updateTransfer(id, { items: [transferItem({ quantity: 30 })] });
    expect(getTransferDetail(id).items).toHaveLength(1);
    expect(getTransferDetail(id).items[0].quantity).toBe(30);

    confirmTransfer(id);
    expect(() => updateTransfer(id, { items: [transferItem({ quantity: 10 })] })).toThrow(ApiError);
  });
});

describe('完整链路：确认 → 发货 → 收货', () => {
  it('发货扣源仓、计入目标仓在途；收货入目标仓并加权均价', () => {
    seedStock(fx.warehouseId, 100, 500);
    seedStock(targetWarehouseId, 100, 800);

    const { id } = createDraft([transferItem({ quantity: 100 })]);
    confirmTransfer(id);

    shipTransfer(id);
    const detail = getTransferDetail(id);
    expect(detail.order.status).toBe('shipped');
    expect(detail.items[0].shipped_qty).toBe(100);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(0);
    expect(inTransitOf(targetWarehouseId)).toBe(100);

    receiveTransfer(id);
    const after = getTransferDetail(id);
    expect(after.order.status).toBe('received');
    expect(after.items[0].received_qty).toBe(100);
    expect(readBalanceByStatus(db, fx.itemId, targetWarehouseId).available).toBe(200);
    expect(inTransitOf(targetWarehouseId)).toBe(0);
    // 目标仓均价 = (100×800 + 100×500) / 200 = 650；源仓均价不变
    expect(readWarehouseCost(db, fx.itemId, targetWarehouseId)).toBe(650);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
  });
});

describe('可用量不足发货', () => {
  it('源仓物理可用量不足 → 409，库存与单据无变化', () => {
    seedStock(fx.warehouseId, 60, 500);
    const { id } = createDraft([transferItem({ quantity: 100 })]);
    confirmTransfer(id);

    expect(() => shipTransfer(id)).toThrow(ApiError);
    expect(getTransferDetail(id).order.status).toBe('confirmed');
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(60);
    expect(transactionCount()).toBe(1); // 仅采购入库那一笔
  });
});

describe('状态机边界', () => {
  it('草稿不可发货、已确认不可收货、终态不可再操作', () => {
    seedStock(fx.warehouseId, 100, 500);
    const { id } = createDraft();

    expect(() => shipTransfer(id)).toThrow(ApiError); // draft 不可发货
    confirmTransfer(id);
    expect(() => receiveTransfer(id)).toThrow(ApiError); // confirmed 不可收货

    shipTransfer(id);
    expect(() => cancelTransfer(id)).toThrow(ApiError); // shipped 不可取消
    receiveTransfer(id);
    expect(() => shipTransfer(id)).toThrow(ApiError); // received 为终态
  });
});

describe('取消', () => {
  it('草稿 / 已确认可取消，且不产生任何库存流水', () => {
    const { id } = createDraft();
    cancelTransfer(id);
    expect(getTransferDetail(id).order.status).toBe('cancelled');
    expect(transactionCount()).toBe(0);

    const second = createDraft();
    confirmTransfer(second.id);
    cancelTransfer(second.id);
    expect(getTransferDetail(second.id).order.status).toBe('cancelled');
    expect(transactionCount()).toBe(0);
  });

  it('删除草稿级联表体', () => {
    const { id } = createDraft();
    deleteTransfer(id);
    expect(() => getTransferDetail(id)).toThrow(ApiError);
  });
});

describe('事务完整性', () => {
  it('多行发货前置校验失败 → 不落任何流水与状态推进', () => {
    seedStock(fx.warehouseId, 100, 500); // 仅 RM-001 有货
    const { id } = createDraft([
      transferItem({ product_id: fx.itemId, quantity: 100 }),
      transferItem({ product_id: fx.portItemId, quantity: 50 }),
    ]);
    confirmTransfer(id);

    expect(() => shipTransfer(id)).toThrow(ApiError);
    expect(getTransferDetail(id).order.status).toBe('confirmed');
    expect(transactionCount()).toBe(1);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(100);
  });
});

describe('流水与余额恒等', () => {
  it('发货 + 收货后，SUM(quantity × direction) ≡ stock_balance.quantity', () => {
    seedStock(fx.warehouseId, 100, 500);
    seedStock(targetWarehouseId, 100, 800);
    const { id } = createDraft([transferItem({ quantity: 100 })]);
    confirmTransfer(id);
    shipTransfer(id);
    receiveTransfer(id);

    const rows = db
      .prepare(
        `SELECT product_id, warehouse_id, SUM(quantity * direction) AS flow
           FROM stock_transaction GROUP BY product_id, warehouse_id`,
      )
      .all() as { product_id: number; warehouse_id: number; flow: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const balance = (
        db
          .prepare(
            'SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
          )
          .get(row.product_id, row.warehouse_id) as { q: number }
      ).q;
      expect(balance).toBe(row.flow);
    }
  });
});