import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import {
  changeStockStatus,
  postMovement,
  readBalanceByStatus,
  readWarehouseCost,
} from './stock.engine';

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

const warehouse = () => ({ productId: fx.itemId, warehouseId: fx.warehouseId });

function transactionCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM stock_transaction').get() as { c: number }).c;
}

function totalQuantity(): number {
  return (
    db
      .prepare(
        'SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
      )
      .get(fx.itemId, fx.warehouseId) as { qty: number }
  ).qty;
}

describe('移动加权平均成本', () => {
  it('两次不同单价入库后按加权平均计价，出库按当前成本结转且不重算', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);

    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 700 });
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(600);

    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'sale_out', direction: -1, quantity: 50 });
    const last = db
      .prepare('SELECT unit_cost FROM stock_transaction ORDER BY id DESC LIMIT 1')
      .get() as { unit_cost: number };
    expect(last.unit_cost).toBe(600);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(600);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(150);
  });

  it('库存归零后保留最后一次成本，不清零', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'sale_out', direction: -1, quantity: 100 });

    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId).available).toBe(0);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
  });

  it('成本按 (物料, 仓库) 维度，跨库存状态保持一致', () => {
    postMovement({ ...warehouse(), stockStatus: 'qc', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 700 });

    const rows = db
      .prepare('SELECT DISTINCT avg_cost FROM stock_balance WHERE product_id = ? AND warehouse_id = ?')
      .all(fx.itemId, fx.warehouseId) as { avg_cost: number }[];
    expect(rows).toEqual([{ avg_cost: 600 }]);
  });
});

describe('流水与余额恒等', () => {
  it('SUM(quantity * direction) 按 物料+仓库+状态 分组恒等于 stock_balance.quantity', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 50, unitCost: 600 });
    changeStockStatus({ ...warehouse(), fromStatus: 'available', toStatus: 'qc', quantity: 30 });
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'sale_out', direction: -1, quantity: 20 });
    changeStockStatus({ ...warehouse(), fromStatus: 'qc', toStatus: 'available', quantity: 10 });

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

describe('库存状态隔离', () => {
  it('送检后可用量减少、总量不变、成本不变；放行后恢复', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });

    changeStockStatus({ ...warehouse(), fromStatus: 'available', toStatus: 'qc', quantity: 10 });
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId)).toEqual({ available: 90, frozen: 0, qc: 10 });
    expect(totalQuantity()).toBe(100);
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);

    changeStockStatus({ ...warehouse(), fromStatus: 'qc', toStatus: 'available', quantity: 10 });
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId)).toEqual({ available: 100, frozen: 0, qc: 0 });
    expect(readWarehouseCost(db, fx.itemId, fx.warehouseId)).toBe(500);
  });

  it('状态转移写两笔 status_change 流水', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });
    const ids = changeStockStatus({ ...warehouse(), fromStatus: 'available', toStatus: 'frozen', quantity: 40 });

    expect(ids).toHaveLength(2);
    const rows = db
      .prepare("SELECT direction, quantity FROM stock_transaction WHERE biz_type = 'status_change' ORDER BY id")
      .all();
    expect(rows).toEqual([
      { direction: -1, quantity: 40 },
      { direction: 1, quantity: 40 },
    ]);
  });

  it('拒绝非法转移与来源数量不足', () => {
    postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 100, unitCost: 500 });

    expect(() => changeStockStatus({ ...warehouse(), fromStatus: 'available', toStatus: 'available', quantity: 1 })).toThrow(ApiError);
    expect(() => changeStockStatus({ ...warehouse(), fromStatus: 'frozen', toStatus: 'qc', quantity: 1 })).toThrow(ApiError);
    expect(() => changeStockStatus({ ...warehouse(), fromStatus: 'available', toStatus: 'frozen', quantity: 101 })).toThrow(ApiError);
    expect(readBalanceByStatus(db, fx.itemId, fx.warehouseId)).toEqual({ available: 100, frozen: 0, qc: 0 });
  });
});

describe('事务完整性', () => {
  it('外层事务中途抛错时，已写入的流水与余额一并回滚', () => {
    const tx = db.transaction(() => {
      postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 10, unitCost: 100 });
      throw new Error('boom');
    });

    expect(() => tx()).toThrow('boom');
    expect(transactionCount()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS c FROM stock_balance').get()).toEqual({ c: 0 });
  });

  it('数量必须为正整数', () => {
    expect(() => postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: 0, unitCost: 100 })).toThrow(ApiError);
    expect(() => postMovement({ ...warehouse(), stockStatus: 'available', bizType: 'purchase_in', direction: 1, quantity: -5, unitCost: 100 })).toThrow(ApiError);
    expect(transactionCount()).toBe(0);
  });
});