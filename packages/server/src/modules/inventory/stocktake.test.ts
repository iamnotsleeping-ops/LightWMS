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
import { changeStockStatus, readBalanceByStatus, readWarehouseCost } from './stock.engine';
import {
  cancelStocktake,
  createStocktake,
  deleteStocktake,
  getStocktakeDetail,
  postStocktake,
  updateStocktake,
} from './stocktake.service';

let db: Db;
let fx: Fixtures;

const ORDER_DATE = '2026-02-10';

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

type Status = 'available' | 'frozen' | 'qc';

function stItem(
  overrides: Partial<{ product_id: number; stock_status: Status; counted_qty: number }> = {},
) {
  return {
    product_id: fx.itemId,
    stock_status: 'available' as Status,
    counted_qty: 0,
    ...overrides,
  };
}

function createDraft(items = [stItem({ counted_qty: 0 })], orderDate = ORDER_DATE) {
  return createStocktake(
    { warehouse_id: fx.warehouseId, order_date: orderDate, items },
    null,
  );
}

/** 通过采购入库制造物理库存 */
function seedStock(quantity: number, unitPrice = 500): void {
  const { id } = createPurchaseOrder(
    {
      supplier_id: fx.supplierId,
      order_date: '2026-02-01',
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: fx.warehouseId,
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

function balance(status: Status): number {
  return readBalanceByStatus(db, fx.itemId, fx.warehouseId)[status];
}

function adjustCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM stock_transaction WHERE biz_type = 'adjust'")
      .get() as { c: number }
  ).c;
}

describe('单号序列', () => {
  it('同日递增、跨日重置', () => {
    const a = createDraft([stItem()], '2026-05-01');
    const b = createDraft([stItem()], '2026-05-01');
    const c = createDraft([stItem()], '2026-05-02');

    expect(a.order_no).toBe('CK-20260501-0001');
    expect(b.order_no).toBe('CK-20260501-0002');
    expect(c.order_no).toBe('CK-20260502-0001');
  });
});

describe('新建草稿', () => {
  it('快照账面量，diff = 实盘 − 账面', () => {
    seedStock(100);
    const { id } = createDraft([stItem({ counted_qty: 120 })]);
    const detail = getStocktakeDetail(id);

    expect(detail.order.status).toBe('draft');
    expect(detail.items[0].book_qty).toBe(100);
    expect(detail.items[0].counted_qty).toBe(120);
    expect(detail.items[0].diff_qty).toBe(20);
  });
});

describe('过账：盘盈', () => {
  it('写 adjust(+1) 流水、余额增加、均价不变', () => {
    seedStock(100, 500);
    const { id } = createDraft([stItem({ counted_qty: 120 })]);
    postStocktake(id);

    expect(getStocktakeDetail(id).order.status).toBe('posted');
    expect(balance('available')).toBe(120);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
    expect(adjustCount()).toBe(1);

    const flow = db
      .prepare("SELECT direction, quantity, unit_cost FROM stock_transaction WHERE biz_type = 'adjust'")
      .get() as { direction: number; quantity: number; unit_cost: number };
    expect(flow.direction).toBe(1);
    expect(flow.quantity).toBe(20);
    expect(flow.unit_cost).toBe(500);
  });
});

describe('过账：盘亏', () => {
  it('写 adjust(-1) 流水、余额减少、均价不变', () => {
    seedStock(100, 500);
    const { id } = createDraft([stItem({ counted_qty: 80 })]);
    postStocktake(id);

    expect(balance('available')).toBe(80);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);

    const flow = db
      .prepare("SELECT direction, quantity FROM stock_transaction WHERE biz_type = 'adjust'")
      .get() as { direction: number; quantity: number };
    expect(flow.direction).toBe(-1);
    expect(flow.quantity).toBe(20);
  });

  it('盘至 0 不产生负库存', () => {
    seedStock(100, 500);
    const { id } = createDraft([stItem({ counted_qty: 0 })]);
    postStocktake(id);
    expect(balance('available')).toBe(0);
  });
});

describe('过账时对齐实盘（消除库存漂移）', () => {
  it('创建后再入库，过账仍以实盘量为准并回写账面/差异', () => {
    seedStock(100, 500);
    const { id } = createDraft([stItem({ counted_qty: 120 })]);

    seedStock(50, 500); // 账面变为 150
    postStocktake(id);

    expect(balance('available')).toBe(120);
    const item = getStocktakeDetail(id).items[0];
    expect(item.book_qty).toBe(150);
    expect(item.diff_qty).toBe(-30);
  });
});

describe('终态与状态保护', () => {
  it('已过账不可改、不可删、不可重复过账', () => {
    seedStock(100);
    const { id } = createDraft([stItem({ counted_qty: 100 })]);
    postStocktake(id);

    expect(() => updateStocktake(id, { items: [stItem({ counted_qty: 90 })] })).toThrow(ApiError);
    expect(() => deleteStocktake(id)).toThrow(ApiError);
    expect(() => postStocktake(id)).toThrow(ApiError);
    expect(adjustCount()).toBe(0); // counted == book，无差异流水
  });

  it('仅草稿可取消', () => {
    const draft = createDraft([stItem({ counted_qty: 0 })]);
    cancelStocktake(draft.id);
    expect(getStocktakeDetail(draft.id).order.status).toBe('cancelled');
    expect(() => postStocktake(draft.id)).toThrow(ApiError);
  });
});

describe('三状态独立盘点', () => {
  it('available / frozen / qc 分别调整互不影响', () => {
    seedStock(100, 500);
    changeStockStatus({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      fromStatus: 'available',
      toStatus: 'frozen',
      quantity: 30,
    });
    changeStockStatus({
      productId: fx.itemId,
      warehouseId: fx.warehouseId,
      fromStatus: 'available',
      toStatus: 'qc',
      quantity: 10,
    });

    const { id } = createDraft([
      stItem({ stock_status: 'available', counted_qty: 80 }),
      stItem({ stock_status: 'frozen', counted_qty: 20 }),
      stItem({ stock_status: 'qc', counted_qty: 5 }),
    ]);
    postStocktake(id);

    expect(balance('available')).toBe(80);
    expect(balance('frozen')).toBe(20);
    expect(balance('qc')).toBe(5);
  });
});