import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { readBalanceByStatus, readWarehouseCost } from '../inventory/stock.engine';
import { createPurchaseReturn, receivePurchase } from './purchase.inbound';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  getOrderDetail,
  listOrders,
  updateOrder,
} from './purchase.service';

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

const ORDER_DATE = '2026-01-05';

function itemBody(overrides: Partial<{ product_id: number; quantity: number; unit_price: number }> = {}) {
  return {
    product_id: fx.itemId,
    warehouse_id: fx.warehouseId,
    quantity: 100,
    unit_price: 500,
    promised_date: '2026-01-10',
    ...overrides,
  };
}

function createDraft(items = [itemBody()], orderDate = ORDER_DATE) {
  return createOrder(
    { supplier_id: fx.supplierId, order_date: orderDate, items },
    null,
  );
}

function createConfirmed(items = [itemBody()]) {
  const { id } = createDraft(items);
  confirmOrder(id);
  return id;
}

function stockBalanceCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM stock_balance').get() as { c: number }).c;
}

function transactionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM stock_transaction').get() as { c: number }).c;
}

describe('单号序列', () => {
  it('同日递增、跨日重置', () => {
    const a = createDraft([itemBody()], '2026-03-01');
    const b = createDraft([itemBody()], '2026-03-01');
    const c = createDraft([itemBody()], '2026-03-02');

    expect(a.order_no).toBe('PO-20260301-0001');
    expect(b.order_no).toBe('PO-20260301-0002');
    expect(c.order_no).toBe('PO-20260302-0001');
  });
});

describe('新建草稿', () => {
  it('状态为 draft，total_amount = Σ(quantity × unit_price)', () => {
    const { id } = createDraft([itemBody({ quantity: 100, unit_price: 500 }), itemBody({ quantity: 50, unit_price: 300 })]);
    const detail = getOrderDetail(id);

    expect(detail.order.status).toBe('draft');
    expect(detail.order.total_amount).toBe(100 * 500 + 50 * 300);
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0].amount).toBe(50000);
    expect(detail.items[1].amount).toBe(15000);
  });
});

describe('状态机边界', () => {
  it('草稿直接入库、已确认改表体、已入库再入库均被拒', () => {
    const { id } = createDraft();
    expect(() => receivePurchase({ orderId: id, lines: [{ orderItemId: getOrderDetail(id).items[0].id, quantity: 1 }] }, null)).toThrow(ApiError);

    confirmOrder(id);
    expect(() => updateOrder(id, { items: [itemBody()] })).toThrow(ApiError);

    const itemId = getOrderDetail(id).items[0].id;
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    expect(getOrderDetail(id).order.status).toBe('received');
    expect(() => receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 1 }] }, null)).toThrow(ApiError);
  });
});

describe('验收 2：100 → 60 → 40 完整链路', () => {
  it('分批入库推进状态、在途归零、库存与均价正确', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;

    const first = receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 60 }] }, null);
    expect(first.status).toBe('partial');
    expect(getOrderDetail(id).items[0].in_transit).toBe(40);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(60);

    const second = receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 40 }] }, null);
    expect(second.status).toBe('received');
    expect(getOrderDetail(id).items[0].in_transit).toBe(0);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(100);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
  });
});

describe('验收 6：取消已确认单据', () => {
  it('取消后在途统计中该单数量消失', () => {
    const id = createConfirmed([itemBody({ quantity: 100 })]);
    const before = listOrders({ page: 1, pageSize: 20 }).list.find((row) => row.id === id);
    expect(before?.in_transit).toBe(100);

    cancelOrder(id);
    const after = listOrders({ page: 1, pageSize: 20 }).list.find((row) => row.id === id);
    expect(after?.status).toBe('cancelled');
    expect(after?.in_transit).toBe(0);
  });
});

describe('超量入库', () => {
  it('超过在途量被拒，received_qty 与库存无变化', () => {
    const id = createConfirmed([itemBody({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;

    expect(() => receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 101 }] }, null)).toThrow(ApiError);
    expect(getOrderDetail(id).items[0].received_qty).toBe(0);
    expect(transactionCount()).toBe(0);
    expect(stockBalanceCount()).toBe(0);
  });
});

describe('验收 15 前半：质检隔离', () => {
  it('需检验物料入库落 qc，可用量不变、冻结(含质检) 增加', () => {
    db.prepare('UPDATE item SET inspection_required = 1 WHERE id = ?').run(fx.itemId);
    const id = createConfirmed([itemBody({ quantity: 40 })]);
    const itemId = getOrderDetail(id).items[0].id;

    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 40 }] }, null);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId)).toEqual({ available: 0, frozen: 0, qc: 40 });
  });
});

describe('验收 5：事务完整性', () => {
  it('一次入库第二行超量时，第一行的流水 / 余额 / received_qty 全部回滚', () => {
    const id = createConfirmed([itemBody({ quantity: 100 }), itemBody({ quantity: 100 })]);
    const [first, second] = getOrderDetail(id).items;

    expect(() =>
      receivePurchase(
        { orderId: id, lines: [{ orderItemId: first.id, quantity: 50 }, { orderItemId: second.id, quantity: 999 }] },
        null,
      ),
    ).toThrow(ApiError);

    expect(transactionCount()).toBe(0);
    expect(stockBalanceCount()).toBe(0);
    expect(getOrderDetail(id).items.map((item) => item.received_qty)).toEqual([0, 0]);
  });
});

describe('采购退货', () => {
  it('入库 100 后退 30：库存 70、流水为 purchase_return / -1 / 按当前均价结转', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);

    const result = createPurchaseReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] },
      null,
    );
    expect(result.return_no).toBe('PR-20260120-0001');
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(70);

    const move = db
      .prepare("SELECT biz_type, direction, quantity, unit_cost FROM stock_transaction WHERE id = ?")
      .get(result.transactionIds[0]) as { biz_type: string; direction: number; quantity: number; unit_cost: number };
    expect(move).toEqual({ biz_type: 'purchase_return', direction: -1, quantity: 30, unit_cost: 500 });
  });

  it('超过可退量被拒；可退量为 received_qty 减历史退货量', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    createPurchaseReturn({ orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] }, null);

    expect(() =>
      createPurchaseReturn({ orderId: id, returnDate: '2026-01-21', lines: [{ orderItemId: itemId, quantity: 71 }] }, null),
    ).toThrow(ApiError);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(70);
  });

  it('源仓可用不足时拒绝退货', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;
    // 入质检状态：可用量为 0
    db.prepare('UPDATE item SET inspection_required = 1 WHERE id = ?').run(fx.itemId);
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);

    expect(() =>
      createPurchaseReturn({ orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 10 }] }, null),
    ).toThrow(ApiError);
  });
});

describe('退货不改单据状态', () => {
  it('received 单退货后仍为 received', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    createPurchaseReturn({ orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] }, null);

    expect(getOrderDetail(id).order.status).toBe('received');
  });
});

describe('验收 3：流水与余额恒等', () => {
  it('入库 + 退货后 SUM(quantity × direction) 仍等于 stock_balance.quantity', () => {
    const id = createConfirmed([itemBody({ quantity: 100, unit_price: 500 })]);
    const itemId = getOrderDetail(id).items[0].id;
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 60 }] }, null);
    receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity: 40 }] }, null);
    createPurchaseReturn({ orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] }, null);

    const ledger = db
      .prepare(
        `SELECT product_id, warehouse_id, stock_status, SUM(quantity * direction) AS qty
           FROM stock_transaction GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      )
      .all();
    const balances = db
      .prepare(
        `SELECT product_id, warehouse_id, stock_status, quantity AS qty
           FROM stock_balance ORDER BY 1, 2, 3`,
      )
      .all();

    expect(ledger).toEqual(balances);
  });
});