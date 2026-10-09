import { beforeEach, describe, expect, it } from 'vitest';
import { salesOutboundBodySchema } from '@light-erp/shared';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { queryStockList } from '../inventory/stock.query';
import { readBalanceByStatus, readWarehouseCost } from '../inventory/stock.engine';
import { receivePurchase } from '../purchase/purchase.inbound';
import {
  confirmOrder as confirmPurchase,
  createOrder as createPurchaseOrder,
  getOrderDetail as getPurchaseDetail,
} from '../purchase/purchase.service';
import { createSalesReturn, shipSales } from './sales.outbound';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  getOrderDetail,
  listOrders,
  updateOrder,
} from './sales.service';

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

const ORDER_DATE = '2026-01-05';

function salesItem(
  overrides: Partial<{ product_id: number; quantity: number; unit_price: number }> = {},
) {
  return {
    product_id: fx.itemId,
    warehouse_id: fx.warehouseId,
    quantity: 100,
    unit_price: 800,
    due_date: '2026-01-15',
    ...overrides,
  };
}

function createDraft(items = [salesItem()], orderDate = ORDER_DATE) {
  return createOrder({ customer_id: fx.customerId, order_date: orderDate, items }, null);
}

function createConfirmed(items = [salesItem()]) {
  const { id } = createDraft(items);
  confirmOrder(id);
  return id;
}

/** 通过采购入库制造物理库存（复用真实链路） */
function seedStock(quantity: number, unitPrice = 500): void {
  const { id } = createPurchaseOrder(
    {
      supplier_id: fx.supplierId,
      order_date: '2026-01-01',
      items: [
        {
          product_id: fx.itemId,
          warehouse_id: fx.warehouseId,
          quantity,
          unit_price: unitPrice,
          promised_date: '2026-01-03',
        },
      ],
    },
    null,
  );
  confirmPurchase(id);
  const itemId = getPurchaseDetail(id).items[0].id;
  receivePurchase({ orderId: id, lines: [{ orderItemId: itemId, quantity }] }, null);
}

interface StockRow {
  reserved: number | null;
  on_hand: number;
}

function stockRow(): StockRow | undefined {
  const { list } = queryStockList({
    page: 1,
    pageSize: 20,
    productId: fx.itemId,
    warehouseId: fx.warehouseId,
  });
  return list[0] as StockRow | undefined;
}

function reservedOf(): number {
  return stockRow()?.reserved ?? 0;
}

function onHandOf(): number {
  return stockRow()?.on_hand ?? 0;
}

function transactionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM stock_transaction').get() as { c: number }).c;
}

describe('单号序列', () => {
  it('同日递增、跨日重置', () => {
    const a = createDraft([salesItem()], '2026-03-01');
    const b = createDraft([salesItem()], '2026-03-01');
    const c = createDraft([salesItem()], '2026-03-02');

    expect(a.order_no).toBe('SO-20260301-0001');
    expect(b.order_no).toBe('SO-20260301-0002');
    expect(c.order_no).toBe('SO-20260302-0001');
  });
});

describe('新建草稿', () => {
  it('状态为 draft，total_amount = Σ(quantity × unit_price)', () => {
    const { id } = createDraft([
      salesItem({ quantity: 100, unit_price: 800 }),
      salesItem({ quantity: 50, unit_price: 300 }),
    ]);
    const detail = getOrderDetail(id);

    expect(detail.order.status).toBe('draft');
    expect(detail.order.total_amount).toBe(100 * 800 + 50 * 300);
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0].amount).toBe(80000);
    expect(detail.items[1].amount).toBe(15000);
  });
});

describe('状态机边界', () => {
  it('草稿直接出库、已确认改表体、已出库再出库均被拒', () => {
    seedStock(100);
    const { id } = createDraft();
    expect(() =>
      shipSales({ orderId: id, lines: [{ orderItemId: getOrderDetail(id).items[0].id, quantity: 1 }] }, null),
    ).toThrow(ApiError);

    confirmOrder(id);
    expect(() => updateOrder(id, { items: [salesItem()] })).toThrow(ApiError);

    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    expect(getOrderDetail(id).order.status).toBe('shipped');
    expect(() =>
      shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 1 }] }, null),
    ).toThrow(ApiError);
  });
});

describe('验收：100 → 60 → 40 完整链路', () => {
  it('分批出库推进状态、预占递减、库存与物理可用量正确', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;

    expect(reservedOf()).toBe(100);

    const first = shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 60 }] }, null);
    expect(first.status).toBe('partial');
    expect(getOrderDetail(id).items[0].unshipped).toBe(40);
    expect(reservedOf()).toBe(40);
    expect(onHandOf()).toBe(40);

    const second = shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 40 }] }, null);
    expect(second.status).toBe('shipped');
    expect(getOrderDetail(id).items[0].unshipped).toBe(0);
    expect(reservedOf()).toBe(0);
    expect(onHandOf()).toBe(0);
  });
});

describe('取消单据', () => {
  it('取消已确认单据后在途预占统计中该单数量消失', () => {
    seedStock(100);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const before = listOrders({ page: 1, pageSize: 20 }).list.find((row) => row.id === id);
    expect(before?.unshipped).toBe(100);
    expect(reservedOf()).toBe(100);

    cancelOrder(id);
    const after = listOrders({ page: 1, pageSize: 20 }).list.find((row) => row.id === id);
    expect(after?.status).toBe('cancelled');
    expect(after?.unshipped).toBe(0);
    expect(reservedOf()).toBe(0);
  });
});

describe('超量出库', () => {
  it('超过未出库量被拒，shipped_qty 与库存无变化', () => {
    seedStock(100);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    const txBefore = transactionCount();

    expect(() =>
      shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 101 }] }, null),
    ).toThrow(ApiError);
    expect(getOrderDetail(id).items[0].shipped_qty).toBe(0);
    expect(transactionCount()).toBe(txBefore);
    expect(onHandOf()).toBe(100);
  });
});

describe('可用量不足出库', () => {
  it('物理可用量不足被拒，库存无变化', () => {
    seedStock(50);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;

    expect(() =>
      shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 60 }] }, null),
    ).toThrow(ApiError);
    expect(getOrderDetail(id).items[0].shipped_qty).toBe(0);
    expect(onHandOf()).toBe(50);
  });
});

describe('事务完整性', () => {
  it('一次出库第二行超量时，第一行的流水 / 余额 / shipped_qty 全部回滚', () => {
    seedStock(1000);
    const id = createConfirmed([salesItem({ quantity: 100 }), salesItem({ quantity: 100 })]);
    const [first, second] = getOrderDetail(id).items;
    const txBefore = transactionCount();

    expect(() =>
      shipSales(
        {
          orderId: id,
          lines: [
            { orderItemId: first.id, quantity: 50 },
            { orderItemId: second.id, quantity: 999 },
          ],
        },
        null,
      ),
    ).toThrow(ApiError);

    expect(transactionCount()).toBe(txBefore);
    expect(getOrderDetail(id).items.map((item) => item.shipped_qty)).toEqual([0, 0]);
    expect(onHandOf()).toBe(1000);
  });
});

describe('销售退货', () => {
  it('出库 100 后退 30：库存 +30、流水为 sale_return / +1 / 按退货前均价、均价不变', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    expect(onHandOf()).toBe(0);

    const result = createSalesReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] },
      null,
    );
    expect(result.return_no).toBe('SR-20260120-0001');
    expect(onHandOf()).toBe(30);

    const move = db
      .prepare('SELECT biz_type, direction, quantity, unit_cost FROM stock_transaction WHERE id = ?')
      .get(result.transactionIds[0]) as {
      biz_type: string;
      direction: number;
      quantity: number;
      unit_cost: number;
    };
    expect(move).toEqual({ biz_type: 'sale_return', direction: 1, quantity: 30, unit_cost: 500 });
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
  });

  it('超过可退量被拒；可退量为 shipped_qty 减历史退货量；退货量为 0 被拒', () => {
    seedStock(200, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    createSalesReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] },
      null,
    );

    expect(() =>
      createSalesReturn(
        { orderId: id, returnDate: '2026-01-21', lines: [{ orderItemId: itemId, quantity: 71 }] },
        null,
      ),
    ).toThrow(ApiError);

    expect(() =>
      createSalesReturn(
        { orderId: id, returnDate: '2026-01-21', lines: [{ orderItemId: itemId, quantity: 0 }] },
        null,
      ),
    ).toThrow(ApiError);

    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(130);
  });
});

describe('退货不改单据状态', () => {
  it('shipped 单退货后仍为 shipped', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    createSalesReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] },
      null,
    );

    expect(getOrderDetail(id).order.status).toBe('shipped');
  });
});

describe('验收：流水与余额恒等', () => {
  it('出库 + 退货后 SUM(quantity × direction) 仍等于 stock_balance.quantity', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 60 }] }, null);
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 40 }] }, null);
    createSalesReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 30 }] },
      null,
    );

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

describe('取消单：行级回填取消量', () => {
  // 回归：cancelled_qty 此前无任何写入路径、恒为 0（见 purchase.test.ts 同名说明）
  it('取消后 cancelled_qty = 未执行量，预留归零', () => {
    const id = createConfirmed([salesItem({ quantity: 80 })]);
    const itemId = getOrderDetail(id).items[0].id;

    cancelOrder(id);

    const item = db
      .prepare('SELECT quantity, shipped_qty, cancelled_qty FROM sales_order_item WHERE id = ?')
      .get(itemId) as { quantity: number; shipped_qty: number; cancelled_qty: number };
    expect(item).toEqual({ quantity: 80, shipped_qty: 0, cancelled_qty: 80 });
    expect(getOrderDetail(id).order.status).toBe('cancelled');
    // 取消后不再计入预留
    expect(
      db
        .prepare(
          `SELECT COALESCE(SUM(i.quantity - i.shipped_qty - i.cancelled_qty), 0) AS qty
             FROM sales_order_item i JOIN sales_order o ON o.id = i.order_id
            WHERE o.status IN ('confirmed', 'partial') AND o.id = ?`,
        )
        .get(id),
    ).toEqual({ qty: 0 });
  });
});

// 回归：同一请求内重复提交同一个 orderItemId 曾可绕过「未出库量 / 可退量」校验。
// 出库路径的物理可用量会按 (物料, 仓库) 合并后再比对，故不会把库存扣成负数，
// 但 shipped_qty 仍会超过订单量；退货是入库、没有可用量校验，会直接凭空增加库存。
describe('回归：同一订单行不得重复提交', () => {
  it('入参层：重复 orderItemId 被 schema 拒绝', () => {
    const parsed = salesOutboundBodySchema.safeParse({
      orderId: 1,
      lines: [
        { orderItemId: 7, quantity: 60 },
        { orderItemId: 7, quantity: 60 },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        '同一订单行不能重复提交，请合并数量后重试',
      );
    }
  });

  it('服务层：重复提交同一行出库被拦截，shipped_qty 不超订单量', () => {
    seedStock(200, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;

    expect(() =>
      shipSales(
        {
          orderId: id,
          lines: [
            { orderItemId: itemId, quantity: 100 },
            { orderItemId: itemId, quantity: 100 },
          ],
        },
        null,
      ),
    ).toThrow(ApiError);

    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(200);
    const item = db
      .prepare('SELECT shipped_qty FROM sales_order_item WHERE id = ?')
      .get(itemId) as { shipped_qty: number };
    expect(item.shipped_qty).toBe(0);
  });

  it('服务层：重复提交同一行退货被拦截，库存不被凭空放大', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(0);

    expect(() =>
      createSalesReturn(
        {
          orderId: id,
          returnDate: '2026-01-20',
          lines: [
            { orderItemId: itemId, quantity: 100 },
            { orderItemId: itemId, quantity: 100 },
          ],
        },
        null,
      ),
    ).toThrow(ApiError);

    // 未产生销售退货单，库存保持出库后的 0（缺陷版本会变成 100）
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM sales_return').get() as { c: number }).c,
    ).toBe(0);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(0);
  });

  it('累计退货量不得超过已出库量（守恒而非仅逐行）', () => {
    seedStock(100, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;
    shipSales({ orderId: id, lines: [{ orderItemId: itemId, quantity: 100 }] }, null);
    createSalesReturn(
      { orderId: id, returnDate: '2026-01-20', lines: [{ orderItemId: itemId, quantity: 70 }] },
      null,
    );

    // 已退 70，再退 31 应被拒（可退 30）
    expect(() =>
      createSalesReturn(
        { orderId: id, returnDate: '2026-01-21', lines: [{ orderItemId: itemId, quantity: 31 }] },
        null,
      ),
    ).toThrow(ApiError);

    const returned = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS qty FROM sales_return_item WHERE order_item_id = ?')
      .get(itemId) as { qty: number };
    expect(returned.qty).toBe(70);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(70);
  });

  it('数据库层兜底：直接写入超过订单量的 shipped_qty 被触发器拒绝', () => {
    seedStock(200, 500);
    const id = createConfirmed([salesItem({ quantity: 100 })]);
    const itemId = getOrderDetail(id).items[0].id;

    expect(() =>
      db.prepare('UPDATE sales_order_item SET shipped_qty = 101 WHERE id = ?').run(itemId),
    ).toThrow(/已执行量不得超过订单量/);
    expect(() =>
      db.prepare('UPDATE sales_order_item SET shipped_qty = 100, cancelled_qty = 1 WHERE id = ?').run(itemId),
    ).toThrow(/已执行量不得超过订单量/);

    expect(() =>
      db.prepare('UPDATE sales_order_item SET shipped_qty = 100 WHERE id = ?').run(itemId),
    ).not.toThrow();
  });
});