import { getDb, type Db } from './connection';
import { runMigrations } from './migrate';
import { createAlertRule } from '../modules/inventory/alert.service';
import { changeStockStatus, postMovement, readBalanceByStatus } from '../modules/inventory/stock.engine';
import { createStocktake, postStocktake } from '../modules/inventory/stocktake.service';
import {
  confirmTransfer,
  createTransfer,
  receiveTransfer,
  shipTransfer,
} from '../modules/inventory/transfer.service';
import { createPurchaseReturn, receivePurchase } from '../modules/purchase/purchase.inbound';
import {
  confirmOrder as confirmPurchaseOrder,
  createOrder as createPurchaseOrder,
} from '../modules/purchase/purchase.service';
import { createSalesReturn, shipSales } from '../modules/sales/sales.outbound';
import {
  confirmOrder as confirmSalesOrder,
  createOrder as createSalesOrder,
} from '../modules/sales/sales.service';

/** 种子标记：sys_param 中该键存在即认为演示数据已灌入 */
export const SEED_MARKER_KEY = 'demo_seed';

export interface SeedResult {
  /** 本次是否实际写入数据 */
  applied: boolean;
  /** 是否因标记存在而跳过 */
  skipped: boolean;
  counts: Record<string, number>;
}

/** 清空时按外键依赖「从子到父」顺序删除的业务表 */
const BUSINESS_TABLES = [
  'sales_return_item',
  'sales_return',
  'purchase_return_item',
  'purchase_return',
  'sales_order_item',
  'sales_order',
  'purchase_order_item',
  'purchase_order',
  'transfer_order_item',
  'transfer_order',
  'stocktake_order_item',
  'stocktake_order',
  'stock_alert_rule',
  'stock_transaction',
  'stock_balance',
  'bom',
  'item_customer_certification',
  'item',
  'item_category',
  'warehouse',
  'partner',
  'doc_sequence',
  'export_task',
];

/** 摘要口径：展示各表行数 */
const COUNT_TABLES = [
  'item_category',
  'item',
  'warehouse',
  'partner',
  'bom',
  'stock_transaction',
  'stock_balance',
  'purchase_order',
  'purchase_return',
  'sales_order',
  'sales_return',
  'transfer_order',
  'stocktake_order',
  'stock_alert_rule',
];

// ---------- 时间工具：相对「今日」 ----------

/** YYYY-MM-DD，offset 为相对今日的天数（负数表示过去） */
function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** 相对今日某天的 ISO 时间戳（默认当地 10:00），用于库存流水的 occurred_at */
function isoOffset(days: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------- 标记 / 清理 ----------

export function hasSeedMarker(db: Db = getDb()): boolean {
  const row = db.prepare('SELECT value FROM sys_param WHERE key = ?').get(SEED_MARKER_KEY);
  return row !== undefined;
}

/**
 * 清空业务数据，保留全部 sys_*（角色 / 权限 / 角色权限 / 系统参数 / 节假日 / 用户 / 用户角色）。
 * 整段在单事务内执行；删除 warehouse 前先解除 parent_id 自引用。
 */
export function clearBusinessData(db: Db = getDb()): void {
  db.transaction(() => {
    db.prepare('UPDATE warehouse SET parent_id = NULL').run();
    for (const table of BUSINESS_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare('DELETE FROM sys_param WHERE key = ?').run(SEED_MARKER_KEY);
  })();
}

function countAll(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}

// ---------- 主入口 ----------

/**
 * 灌入演示数据（小型电子产品组装厂）。
 *
 * - 幂等：`sys_param.demo_seed` 存在且未传 `reset` 时直接跳过。
 * - `reset=true`：先清空业务数据（保留 sys_*）再重建。
 * - 主数据用参数化 INSERT（无 service 层）；业务单据一律调用既有 service，
 *   与线上同一条代码路径，且全部包在单事务内，失败整体回滚。
 */
export function seedDemoData(options: { reset?: boolean } = {}): SeedResult {
  const db = getDb();
  runMigrations();

  if (hasSeedMarker(db) && !options.reset) {
    return { applied: false, skipped: true, counts: countAll(db) };
  }
  if (options.reset) clearBusinessData(db);

  db.transaction(() => {
    const now = new Date().toISOString();

    // ---- 基础资料：物料分类 ----
    const categoryIds: Record<string, number> = {};
    const insertCategory = db.prepare(
      `INSERT INTO item_category (code, name, is_active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
    );
    const categories: [string, string][] = [
      ['CAT-FG', '成品'],
      ['CAT-SF', '半成品'],
      ['CAT-RM', '原材料'],
      ['CAT-PK', '包装物'],
    ];
    for (const [code, name] of categories) {
      categoryIds[code] = Number(insertCategory.run(code, name, now, now).lastInsertRowid);
    }

    // ---- 基础资料：物料（inspection_required=1 → 采购入库落 qc） ----
    const itemIds: Record<string, number> = {};
    const insertItem = db.prepare(
      `INSERT INTO item
         (code, name, base_unit, category_id, is_active, qty_precision,
          inspection_required, batch_managed, serial_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, 0, 0, ?, ?)`,
    );
    const items: [string, string, string, string, number][] = [
      ['FG-1001', '智能网关 A', '件', 'CAT-FG', 0],
      ['FG-1002', '智能网关 B', '件', 'CAT-FG', 0],
      ['SF-2001', '主控板组件', '件', 'CAT-SF', 0],
      ['RM-3001', '主控芯片', '只', 'CAT-RM', 1],
      ['RM-3002', '铝合金外壳', '个', 'CAT-RM', 0],
      ['RM-3003', '锂离子电芯', '只', 'CAT-RM', 1],
      ['RM-3004', '7 寸显示屏', '块', 'CAT-RM', 0],
      ['PK-4001', '彩盒', '个', 'CAT-PK', 0],
      ['PK-4002', '说明书', '张', 'CAT-PK', 0],
    ];
    for (const [code, name, unit, category, inspection] of items) {
      itemIds[code] = Number(
        insertItem.run(code, name, unit, categoryIds[category], inspection, now, now).lastInsertRowid,
      );
    }

    // ---- 基础资料：工厂 / 仓库 ----
    const warehouseIds: Record<string, number> = {};
    const insertWarehouse = db.prepare(
      `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const warehouses: [string, string, string][] = [
      ['PLANT-01', '总装厂', 'plant'],
      ['WH-01', '原料仓', 'warehouse'],
      ['WH-02', '成品仓', 'warehouse'],
      ['PORT-01', '港口仓', 'port'],
    ];
    for (const [code, name, type] of warehouses) {
      warehouseIds[code] = Number(insertWarehouse.run(code, name, type, now, now).lastInsertRowid);
    }

    // ---- 基础资料：往来单位 ----
    const partnerIds: Record<string, number> = {};
    const insertPartner = db.prepare(
      `INSERT INTO partner (code, name, type, contact, phone, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const partners: [string, string, string, string][] = [
      ['SU-1001', '华芯电子', 'supplier', '王工'],
      ['SU-1002', '精密结构件', 'supplier', '李经理'],
      ['SU-1003', '新能源电池', 'supplier', '赵工'],
      ['CU-2001', '华东经销', 'customer', '陈总'],
      ['CU-2002', '深圳代理', 'customer', '周经理'],
    ];
    for (const [code, name, type, contact] of partners) {
      partnerIds[code] = Number(
        insertPartner.run(code, name, type, contact, null, now, now).lastInsertRowid,
      );
    }

    // ---- 基础资料：需客户认证的客户关联 ----
    db.prepare(
      `INSERT INTO item_customer_certification (item_id, customer_id, certified_at)
       VALUES (?, ?, ?)`,
    ).run(itemIds['FG-1001'], partnerIds['CU-2001'], dateOffset(-60));

    // ---- 基础资料：BOM（多版本 + 多层） ----
    const insertBom = db.prepare(
      `INSERT INTO bom
         (parent_item_id, child_item_id, qty_per, scrap_rate, effective_from, effective_to, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    );
    const boms: [string, string, number, string | null, string | null][] = [
      ['FG-1001', 'SF-2001', 1, '2026-01-01', '2026-06-30'],
      ['FG-1001', 'RM-3002', 1, '2026-01-01', '2026-06-30'],
      ['FG-1001', 'RM-3004', 1, '2026-01-01', '2026-06-30'],
      ['FG-1001', 'SF-2001', 1, '2026-07-01', null],
      ['FG-1001', 'RM-3002', 1, '2026-07-01', null],
      ['FG-1001', 'RM-3004', 2, '2026-07-01', null],
      ['SF-2001', 'RM-3001', 2, '2026-01-01', null],
      ['SF-2001', 'RM-3003', 1, '2026-01-01', null],
      ['FG-1002', 'SF-2001', 2, '2026-01-01', null],
      ['FG-1002', 'RM-3002', 1, '2026-01-01', null],
    ];
    for (const [parent, child, qtyPer, from, to] of boms) {
      insertBom.run(itemIds[parent], itemIds[child], qtyPer, from, to, now, now);
    }

    // ---- 期初库存（adjust，29 天前） ----
    const openingAt = isoOffset(-29);
    const openings: [string, string, number, number][] = [
      ['WH-01', 'RM-3001', 500, 1200],
      ['WH-01', 'RM-3002', 800, 300],
      ['WH-01', 'RM-3003', 600, 2500],
      ['WH-01', 'RM-3004', 400, 4000],
      ['WH-01', 'PK-4001', 1000, 80],
      ['WH-01', 'PK-4002', 2000, 10],
      ['WH-02', 'FG-1001', 120, 9000],
      ['WH-02', 'FG-1002', 60, 7000],
    ];
    for (const [warehouse, item, quantity, unitCost] of openings) {
      postMovement({
        productId: itemIds[item],
        warehouseId: warehouseIds[warehouse],
        stockStatus: 'available',
        bizType: 'adjust',
        direction: 1,
        quantity,
        unitCost,
        occurredAt: openingAt,
      });
    }

    // ---- 采购单 ----
    // PO-A：全额入库（RM-3001 需质检 → 入 qc），供提前期统计（6 天、准时）
    const poA = createPurchaseOrder(
      {
        supplier_id: partnerIds['SU-1001'],
        order_date: dateOffset(-25),
        remark: '演示：主控芯片采购',
        items: [
          {
            product_id: itemIds['RM-3001'],
            warehouse_id: warehouseIds['WH-01'],
            quantity: 300,
            unit_price: 1180,
            promised_date: dateOffset(-18),
          },
        ],
      },
      null,
    );
    confirmPurchaseOrder(poA.id);
    const poALine = db
      .prepare('SELECT id FROM purchase_order_item WHERE order_id = ? ORDER BY line_no')
      .get(poA.id) as { id: number };
    receivePurchase(
      { orderId: poA.id, lines: [{ orderItemId: poALine.id, quantity: 300 }], occurredAt: isoOffset(-19) },
      null,
    );
    // 采购退货：基于 PO-A 退 20
    createPurchaseReturn(
      {
        orderId: poA.id,
        returnDate: dateOffset(-15),
        remark: '演示：来料不良退货',
        lines: [{ orderItemId: poALine.id, quantity: 20 }],
      },
      null,
    );

    // PO-B：部分入库（RM-3003 需质检），剩 250 在途
    const poB = createPurchaseOrder(
      {
        supplier_id: partnerIds['SU-1003'],
        order_date: dateOffset(-12),
        remark: '演示：电芯分批到货',
        items: [
          {
            product_id: itemIds['RM-3003'],
            warehouse_id: warehouseIds['WH-01'],
            quantity: 400,
            unit_price: 2480,
            promised_date: dateOffset(-6),
          },
        ],
      },
      null,
    );
    confirmPurchaseOrder(poB.id);
    const poBLine = db
      .prepare('SELECT id FROM purchase_order_item WHERE order_id = ? ORDER BY line_no')
      .get(poB.id) as { id: number };
    receivePurchase(
      { orderId: poB.id, lines: [{ orderItemId: poBLine.id, quantity: 150 }], occurredAt: isoOffset(-6) },
      null,
    );

    // PO-C：已确认未入库（在途 500）
    const poC = createPurchaseOrder(
      {
        supplier_id: partnerIds['SU-1002'],
        order_date: dateOffset(-3),
        remark: '演示：外壳采购在途',
        items: [
          {
            product_id: itemIds['RM-3002'],
            warehouse_id: warehouseIds['WH-01'],
            quantity: 500,
            unit_price: 310,
            promised_date: dateOffset(5),
          },
        ],
      },
      null,
    );
    confirmPurchaseOrder(poC.id);

    // PO-D：草稿
    createPurchaseOrder(
      {
        supplier_id: partnerIds['SU-1001'],
        order_date: dateOffset(-1),
        remark: '演示：草稿采购单',
        items: [
          {
            product_id: itemIds['RM-3001'],
            warehouse_id: warehouseIds['WH-01'],
            quantity: 100,
            unit_price: 1190,
            promised_date: dateOffset(10),
          },
        ],
      },
      null,
    );

    // ---- 销售单 ----
    // SO-A：全部出库
    const soA = createSalesOrder(
      {
        customer_id: partnerIds['CU-2001'],
        order_date: dateOffset(-20),
        remark: '演示：成品销售',
        items: [
          {
            product_id: itemIds['FG-1001'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 50,
            unit_price: 15000,
            due_date: dateOffset(-10),
          },
          {
            product_id: itemIds['FG-1002'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 20,
            unit_price: 12000,
            due_date: dateOffset(-10),
          },
        ],
      },
      null,
    );
    confirmSalesOrder(soA.id);
    const soALines = db
      .prepare('SELECT id, product_id FROM sales_order_item WHERE order_id = ? ORDER BY line_no')
      .all(soA.id) as { id: number; product_id: number }[];
    const soAFgLine = soALines.find((line) => line.product_id === itemIds['FG-1001'])!;
    shipSales(
      {
        orderId: soA.id,
        lines: soALines.map((line) => ({ orderItemId: line.id, quantity: line.product_id === itemIds['FG-1001'] ? 50 : 20 })),
        occurredAt: isoOffset(-18),
      },
      null,
    );
    // 销售退货：基于 SO-A 退 FG-1001 × 5
    createSalesReturn(
      {
        orderId: soA.id,
        returnDate: dateOffset(-10),
        remark: '演示：客户退货',
        lines: [{ orderItemId: soAFgLine.id, quantity: 5 }],
      },
      null,
    );

    // SO-B：部分出库，剩 25 预留
    const soB = createSalesOrder(
      {
        customer_id: partnerIds['CU-2002'],
        order_date: dateOffset(-8),
        remark: '演示：分批出库',
        items: [
          {
            product_id: itemIds['FG-1001'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 40,
            unit_price: 15200,
            due_date: dateOffset(2),
          },
        ],
      },
      null,
    );
    confirmSalesOrder(soB.id);
    const soBLine = db
      .prepare('SELECT id FROM sales_order_item WHERE order_id = ? ORDER BY line_no')
      .get(soB.id) as { id: number };
    shipSales(
      { orderId: soB.id, lines: [{ orderItemId: soBLine.id, quantity: 15 }], occurredAt: isoOffset(-5) },
      null,
    );

    // SO-C：已确认未出库（预留 30）
    const soC = createSalesOrder(
      {
        customer_id: partnerIds['CU-2001'],
        order_date: dateOffset(-2),
        remark: '演示：待出库销售单',
        items: [
          {
            product_id: itemIds['FG-1002'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 30,
            unit_price: 12500,
            due_date: dateOffset(8),
          },
        ],
      },
      null,
    );
    confirmSalesOrder(soC.id);

    // SO-D：草稿
    createSalesOrder(
      {
        customer_id: partnerIds['CU-2002'],
        order_date: dateOffset(-1),
        remark: '演示：草稿销售单',
        items: [
          {
            product_id: itemIds['FG-1001'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 10,
            unit_price: 15300,
            due_date: dateOffset(12),
          },
        ],
      },
      null,
    );

    // ---- 调拨单 ----
    // TR-A：WH-02 → PORT-01，已收货（演示港口仓默认不计入库存口径）
    const trA = createTransfer(
      {
        from_warehouse_id: warehouseIds['WH-02'],
        to_warehouse_id: warehouseIds['PORT-01'],
        order_date: dateOffset(-4),
        remark: '演示：成品发港口仓',
        items: [{ product_id: itemIds['FG-1001'], quantity: 20 }],
      },
      null,
    );
    confirmTransfer(trA.id);
    shipTransfer(trA.id, isoOffset(-4));
    receiveTransfer(trA.id, isoOffset(-2));

    // TR-B：WH-01 → WH-02，已发货未收货（在途 50）
    const trB = createTransfer(
      {
        from_warehouse_id: warehouseIds['WH-01'],
        to_warehouse_id: warehouseIds['WH-02'],
        order_date: dateOffset(-1),
        remark: '演示：显示屏调拨在途',
        items: [{ product_id: itemIds['RM-3004'], quantity: 50 }],
      },
      null,
    );
    confirmTransfer(trB.id);
    shipTransfer(trB.id, isoOffset(-1));

    // ---- 盘点单：WH-02 成品仓，FG-1001 实盘 = 账面 − 2，当日过账 ----
    const bookQty = readBalanceByStatus(db, itemIds['FG-1001'], warehouseIds['WH-02']).available;
    const stocktake = createStocktake(
      {
        warehouse_id: warehouseIds['WH-02'],
        order_date: dateOffset(-3),
        items: [
          {
            product_id: itemIds['FG-1001'],
            stock_status: 'available',
            counted_qty: Math.max(bookQty - 2, 0),
          },
        ],
      },
      null,
    );
    postStocktake(stocktake.id, isoOffset(-3));

    // ---- 库存状态：WH-01 的 RM-3001 冻结 20（演示 frozen 桶） ----
    changeStockStatus({
      productId: itemIds['RM-3001'],
      warehouseId: warehouseIds['WH-01'],
      fromStatus: 'available',
      toStatus: 'frozen',
      quantity: 20,
      occurredAt: isoOffset(-2),
    });

    // ---- 预警规则（3 条当前触发） ----
    createAlertRule({ item_id: itemIds['RM-3001'], min_qty: 200 }); // 对照：充足不触发
    createAlertRule({ item_id: itemIds['RM-3003'], min_qty: 1000 }); // below_min
    createAlertRule({ item_id: itemIds['PK-4001'], min_qty: 2000 }); // below_min
    createAlertRule({
      item_id: itemIds['FG-1001'],
      warehouse_id: warehouseIds['WH-02'],
      min_qty: 80,
      max_qty: 300,
    }); // below_min

    // ---- 写入标记 ----
    db.prepare(
      `INSERT INTO sys_param (key, value, description, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(SEED_MARKER_KEY, now, '演示数据种子标记（pnpm seed 写入）', now);
  })();

  return { applied: true, skipped: false, counts: countAll(db) };
}