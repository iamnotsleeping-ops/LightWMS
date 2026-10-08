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
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  queryAlerts,
  updateAlertRule,
} from './alert.service';

let db: Db;
let fx: Fixtures;
let secondWarehouseId: number;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
  const now = new Date().toISOString();
  secondWarehouseId = Number(
    db
      .prepare(
        `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
         VALUES ('WH-02', '二号仓', 'warehouse', 1, ?, ?)`,
      )
      .run(now, now).lastInsertRowid,
  );
});

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

describe('规则 CRUD 与唯一性', () => {
  it('同物料 + 同仓库唯一；全局规则（仓库为空）在服务层保证唯一', () => {
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 10 });
    expect(() =>
      createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 20 }),
    ).toThrow(ApiError);

    createAlertRule({ item_id: fx.itemId, warehouse_id: null, min_qty: 5 });
    expect(() => createAlertRule({ item_id: fx.itemId, warehouse_id: null, min_qty: 8 })).toThrow(
      ApiError,
    );
  });

  it('上限小于下限 → 400；更新与删除', () => {
    expect(() =>
      createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 50, max_qty: 10 }),
    ).toThrow(ApiError);

    const { id } = createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 10 });
    updateAlertRule(id, { min_qty: 30, max_qty: 90 });
    const { list } = listAlertRules({ page: 1, pageSize: 20 });
    expect(list[0].min_qty).toBe(30);
    expect(list[0].max_qty).toBe(90);

    deleteAlertRule(id);
    expect(listAlertRules({ page: 1, pageSize: 20 }).list).toHaveLength(0);
  });
});

describe('预警判定', () => {
  it('低于下限 → below_min；区间内不告警', () => {
    seedStock(fx.warehouseId, 30);
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 50 });

    const alerts = queryAlerts({});
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe('below_min');
    expect(alerts[0].current_qty).toBe(30);

    // 阈值调低到下限以内 → 不告警
    updateAlertRule(alerts[0].rule_id, { min_qty: 10 });
    expect(queryAlerts({})).toHaveLength(0);
  });

  it('高于上限 → above_max', () => {
    seedStock(fx.warehouseId, 150);
    createAlertRule({ item_id: fx.itemId, warehouse_id: fx.warehouseId, min_qty: 10, max_qty: 100 });

    const alerts = queryAlerts({});
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe('above_max');
  });

  it('停用规则不参与判定，可按类型筛选', () => {
    seedStock(fx.warehouseId, 30);
    createAlertRule({
      item_id: fx.itemId,
      warehouse_id: fx.warehouseId,
      min_qty: 50,
      is_active: false,
    });
    expect(queryAlerts({})).toHaveLength(0);

    createAlertRule({ item_id: fx.portItemId, warehouse_id: fx.warehouseId, min_qty: 50 });
    // portItem 无库存 → below_min
    expect(queryAlerts({ alertType: 'below_min' })).toHaveLength(1);
    expect(queryAlerts({ alertType: 'above_max' })).toHaveLength(0);
  });
});

describe('全局规则口径', () => {
  it('仓库为空时按该物料跨仓 on_hand 汇总', () => {
    seedStock(fx.warehouseId, 30);
    seedStock(secondWarehouseId, 40);
    createAlertRule({ item_id: fx.itemId, warehouse_id: null, min_qty: 100 });

    const alerts = queryAlerts({});
    expect(alerts).toHaveLength(1);
    expect(alerts[0].current_qty).toBe(70);
    expect(alerts[0].warehouse_id).toBeNull();
  });
});