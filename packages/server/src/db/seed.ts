import { getDb, type Db } from './connection';
import { runMigrations } from './migrate';
import { createAlertRule } from '../modules/inventory/alert.service';
import { changeStockStatus, postMovement, readBalanceByStatus } from '../modules/inventory/stock.engine';
import {
  cancelTransfer,
  confirmTransfer,
  createTransfer,
  receiveTransfer,
  shipTransfer,
} from '../modules/inventory/transfer.service';
import { cancelStocktake, createStocktake, postStocktake } from '../modules/inventory/stocktake.service';
import { createPurchaseReturn, receivePurchase } from '../modules/purchase/purchase.inbound';
import {
  cancelOrder as cancelPurchaseOrder,
  confirmOrder as confirmPurchaseOrder,
  createOrder as createPurchaseOrder,
} from '../modules/purchase/purchase.service';
import { createSalesReturn, shipSales } from '../modules/sales/sales.outbound';
import {
  cancelOrder as cancelSalesOrder,
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
  'sys_holiday',
  // 替代料：必须先于 item / warehouse 删除。这两张表对 item 有外键且未声明级联，
  // 若漏在清空清单外，`seed --reset` 会在删 item 时报 FOREIGN KEY 约束失败。
  'item_substitute_log',
  'item_substitute',
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
  'item_substitute',
  'item_substitute_log',
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
    // 覆盖：普通分类、树形子分类（parent_id 非空）、已停用分类（is_active=0）
    const categoryIds: Record<string, number> = {};
    const insertCategory = db.prepare(
      `INSERT INTO item_category (code, name, parent_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const categories: [string, string, number | null, 0 | 1][] = [
      ['CAT-FG', '成品', null, 1],
      ['CAT-SF', '半成品', null, 1],
      ['CAT-RM', '原材料', null, 1],
      ['CAT-PK', '包装物', null, 1],
      // 演示分类树：电子料挂在原材料之下，物料可挂到子分类
      ['CAT-RM-EL', '电子料', null, 1], // parent 稍后回填
      // 演示停用分类：停用后不再出现在新建物料的下拉里，但历史物料仍引用它
      ['CAT-OLD', '历史分类（已停用）', null, 0],
    ];
    for (const [code, name, parentId, isActive] of categories) {
      categoryIds[code] = Number(
        insertCategory.run(code, name, parentId, isActive, now, now).lastInsertRowid,
      );
    }
    // 回填 CAT-RM-EL 的父分类，形成两级分类树
    db.prepare('UPDATE item_category SET parent_id = ? WHERE id = ?').run(
      categoryIds['CAT-RM'],
      categoryIds['CAT-RM-EL'],
    );

    // ---- 基础资料：物料（inspection_required=1 → 采购入库落 qc） ----
    // 覆盖：需质检/免检、启用/停用、批次管理、序列号管理、挂子分类、挂停用分类
    const itemIds: Record<string, number> = {};
    const insertItem = db.prepare(
      `INSERT INTO item
         (code, name, base_unit, category_id, is_active, qty_precision,
          inspection_required, batch_managed, serial_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    );
    const items: [string, string, string, string, number, number, number, number][] = [
      ['FG-1001', '智能网关 A', 'EA', 'CAT-FG', 0, 0, 0, 1],
      ['FG-1002', '智能网关 B', 'EA', 'CAT-FG', 0, 0, 0, 1],
      // 序列号管理：整机按序列号追踪（仅作标记，库存维度仍是 物料 × 仓库 × 状态）
      ['FG-1003', '智能网关 C（序列号管理）', 'EA', 'CAT-FG', 0, 0, 1, 1],
      ['SF-2001', '主控板组件', 'EA', 'CAT-SF', 0, 0, 0, 1],
      ['RM-3001', '主控芯片', 'EA', 'CAT-RM-EL', 1, 0, 0, 1],
      ['RM-3002', '铝合金外壳', 'EA', 'CAT-RM', 0, 0, 0, 1],
      ['RM-3003', '锂离子电芯', 'EA', 'CAT-RM-EL', 1, 0, 0, 1],
      ['RM-3004', '7 寸显示屏', 'EA', 'CAT-RM-EL', 0, 0, 0, 1],
      // 替代料专用物料：同功能不同来源/型号，成对演示替代关系
      ['RM-3005', '主控芯片（国产替代）', 'EA', 'CAT-RM-EL', 1, 0, 0, 1],
      ['RM-3006', '7 寸显示屏（备用型号）', 'EA', 'CAT-RM-EL', 0, 0, 0, 1],
      ['RM-3007', '锂离子电芯（备用供应商）', 'EA', 'CAT-RM-EL', 1, 0, 0, 1],
      // 批次管理：传感器模组按批次追踪
      ['RM-3008', '传感器模组（批次管理）', 'EA', 'CAT-RM-EL', 1, 1, 0, 1],
      ['PK-4001', '彩盒', 'EA', 'CAT-PK', 0, 0, 0, 1],
      ['PK-4002', '说明书', 'EA', 'CAT-PK', 0, 0, 0, 1],
      ['PK-4003', '彩盒（环保材料）', 'EA', 'CAT-PK', 0, 0, 0, 1],
      // 演示已停用物料 + 挂在已停用分类下：停用后不可再用于新单据，但历史数据仍可查询
      ['IT-9001', '旧型号外壳（已停用）', 'EA', 'CAT-OLD', 0, 0, 0, 0],
    ];
    for (const [code, name, unit, category, inspection, batch, serial, isActive] of items) {
      itemIds[code] = Number(
        insertItem
          .run(code, name, unit, categoryIds[category], isActive, inspection, batch, serial, now, now)
          .lastInsertRowid,
      );
    }

    // ---- 基础资料：工厂 / 仓库 ----
    // 覆盖三种仓库类型（plant / warehouse / port）与停用仓库
    const warehouseIds: Record<string, number> = {};
    const insertWarehouse = db.prepare(
      `INSERT INTO warehouse (code, name, type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const warehouses: [string, string, string, 0 | 1][] = [
      ['PLANT-01', '总装厂', 'plant', 1],
      ['WH-01', '原料仓', 'warehouse', 1],
      ['WH-02', '成品仓', 'warehouse', 1],
      ['PORT-01', '港口仓', 'port', 1],
      // 停用仓：不再出现在单据的可选仓库里，但历史单据仍引用它
      ['WH-03', '退货暂存仓（已停用）', 'warehouse', 0],
    ];
    for (const [code, name, type, isActive] of warehouses) {
      warehouseIds[code] = Number(
        insertWarehouse.run(code, name, type, isActive, now, now).lastInsertRowid,
      );
    }

    // ---- 基础资料：往来单位 ----
    // 覆盖三种类型（customer / supplier / both）与停用单位
    const partnerIds: Record<string, number> = {};
    const insertPartner = db.prepare(
      `INSERT INTO partner (code, name, type, contact, phone, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const partners: [string, string, string, string, 0 | 1][] = [
      ['SU-1001', '华芯电子', 'supplier', '王工', 1],
      ['SU-1002', '精密结构件', 'supplier', '李经理', 1],
      ['SU-1003', '新能源电池', 'supplier', '赵工', 1],
      // both：既供货又采购（演示同一伙伴可承担两种角色）
      ['SU-1004', '联创电子（购销双向）', 'both', '孙主管', 1],
      ['CU-2001', '华东经销', 'customer', '陈总', 1],
      ['CU-2002', '深圳代理', 'customer', '周经理', 1],
      // 停用客户：不能再开新单，但历史单据仍可查询
      ['CU-2003', '老客户（已停用）', 'customer', '吴经理', 0],
    ];
    for (const [code, name, type, contact, isActive] of partners) {
      partnerIds[code] = Number(
        insertPartner.run(code, name, type, contact, null, isActive, now, now).lastInsertRowid,
      );
    }

    // ---- 基础资料：替代料（P10） ----
    // 覆盖目标：三种场景（销售出库 / BOM 备料 / 采购建议）× 三种策略（按比例 / 整批全量 / 手工指定）
    // × 各种专属度（全仓通用、仓专属、父件专属）× 各种生效状态（生效中、未生效、已过期、已停用）
    // × 非 1:1 比例（2:3 会触发向上取整并在告警里给出换算过程）。
    const insertSubstitute = db.prepare(
      `INSERT INTO item_substitute
         (main_item_id, sub_item_id, parent_item_id, warehouse_id, priority, ratio_num, ratio_den,
          scene, strategy, cross_warehouse, effective_from, effective_to, is_active, remark, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    );
    // cross_warehouse 一律 0：跨仓替代未实现，造 1 会让演示看起来支持不存在的能力
    const substitutes: {
      main: string;
      sub: string;
      parent?: string;
      warehouse?: string;
      priority?: number;
      ratio?: [number, number];
      scene: string;
      strategy: string;
      from?: string;
      to?: string;
      active?: 0 | 1;
      remark: string;
    }[] = [
      // —— 销售出库：成品替代（本次演示会真实执行一次，写 item_substitute_log）——
      { main: 'FG-1001', sub: 'FG-1002', scene: 'sales_out', strategy: 'proportion', from: dateOffset(-90), remark: '同系列网关可互替发货（1:1，全仓通用）' },
      { main: 'FG-1001', sub: 'FG-1002', warehouse: 'WH-02', scene: 'sales_out', strategy: 'proportion', from: dateOffset(-90), remark: '成品仓专属规则：比全仓通用那条更专属，命中时优先使用' },
      // —— BOM 备料：非 1:1 比例 ——
      { main: 'RM-3001', sub: 'RM-3005', ratio: [2, 3], scene: 'bom_plan', strategy: 'proportion', from: dateOffset(-60), remark: '国产芯片替代进口（替代比例 2:3，会触发向上取整告警）' },
      { main: 'RM-3001', sub: 'RM-3005', parent: 'SF-2001', ratio: [1, 1], scene: 'bom_plan', strategy: 'proportion', from: dateOffset(-60), remark: '仅用于「主控板组件」这个父件的专属规则（比通用规则更专属）' },
      { main: 'RM-3001', sub: 'RM-3008', priority: 2, scene: 'bom_plan', strategy: 'proportion', from: dateOffset(-60), remark: '第二顺位替代：第一顺位不足时继续兜底' },
      // —— 采购建议 ——
      { main: 'RM-3001', sub: 'RM-3005', scene: 'purchase_hint', strategy: 'proportion', from: dateOffset(-60), remark: '采购建议场景：缺料时可改买国产替代' },
      // 刻意**只建仓库专属行、不建通配行**：这样在别的仓试算时会得到 wrong_warehouse，
      // 而不是被通配行接住（否则该跳过原因在演示库里永远复现不出来）。下游按它对账。
      { main: 'PK-4001', sub: 'PK-4003', warehouse: 'WH-01', scene: 'purchase_hint', strategy: 'proportion', from: dateOffset(-45), remark: '仅原料仓适用的采购建议：用于演示 wrong_warehouse（请求其它仓时该关系不适用）' },
      // —— 整批全量——不做混用 ——
      { main: 'RM-3004', sub: 'RM-3006', scene: 'bom_plan', strategy: 'whole_batch', from: dateOffset(-45), remark: '显示屏备用型号：整批全量，不做混用' },
      { main: 'RM-3004', sub: 'RM-3006', warehouse: 'WH-01', scene: 'bom_plan', strategy: 'whole_batch', from: dateOffset(-45), remark: '原料仓专属：在 WH-01 试算时优先于全仓通用规则' },
      // —— 手工指定 ——
      { main: 'RM-3003', sub: 'RM-3007', scene: 'bom_plan', strategy: 'manual', from: dateOffset(-30), remark: '电芯备用供应商：必须手工指定，不自动兜底' },
      // —— 停用 ——
      { main: 'PK-4001', sub: 'PK-4003', scene: 'bom_plan', strategy: 'proportion', from: dateOffset(-30), active: 0, remark: '已停用：试算时应出现在「跳过原因」里而不是被静默忽略' },
      // —— 已过期 ——
      { main: 'PK-4001', sub: 'PK-4003', scene: 'sales_out', strategy: 'proportion', from: dateOffset(-120), to: dateOffset(-10), remark: '已过期：演示 out_of_validity 跳过原因' },
      // —— 未生效 ——
      { main: 'RM-3001', sub: 'RM-3005', scene: 'sales_out', strategy: 'proportion', from: dateOffset(30), remark: '尚未生效：演示 out_of_validity（生效期在未来）' },
    ];
    for (const rule of substitutes) {
      insertSubstitute.run(
        itemIds[rule.main],
        itemIds[rule.sub],
        rule.parent ? itemIds[rule.parent] : null,
        rule.warehouse ? warehouseIds[rule.warehouse] : null,
        rule.priority ?? 1,
        rule.ratio?.[0] ?? 1,
        rule.ratio?.[1] ?? 1,
        rule.scene,
        rule.strategy,
        rule.from ?? null,
        rule.to ?? null,
        rule.active ?? 1,
        rule.remark,
        now,
        now,
      );
    }

    // ---- 基础资料：客户认证（正向认证，default-deny；只约束「替代」动作） ----
    // 覆盖：长期有效、即将过期、已过期
    const insertCertification = db.prepare(
      `INSERT INTO item_customer_certification (item_id, customer_id, certified_at, expire_at)
       VALUES (?, ?, ?, ?)`,
    );
    insertCertification.run(itemIds['FG-1001'], partnerIds['CU-2001'], dateOffset(-60), null);
    insertCertification.run(itemIds['FG-1002'], partnerIds['CU-2001'], dateOffset(-30), null);
    // 对另一客户已过期 → 演示 customer_cert_expired
    insertCertification.run(itemIds['FG-1002'], partnerIds['CU-2002'], dateOffset(-200), dateOffset(-1));
    // 未认证的组合（CU-2002 对 FG-1001）故意不建，演示 customer_not_certified

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
    // 注意：替代料必须自己有库存，否则「需求试算」永远只能报缺口，演示不出替代效果。
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
      // 替代料专用物料的期初库存（有货才演示得出「用替代料顶缺口」）
      ['WH-01', 'RM-3005', 220, 950],
      ['WH-01', 'RM-3006', 150, 3200],
      ['WH-01', 'RM-3007', 300, 2300],
      ['WH-01', 'RM-3008', 180, 1500],
      ['WH-01', 'PK-4003', 600, 95],
      // 序列号管理整机
      ['WH-02', 'FG-1003', 25, 9800],
      // 已停用物料的遗留库存：停用不等于清零，历史库存仍要能查到
      ['WH-01', 'IT-9001', 12, 280],
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

    // PO-E：已取消（演示 cancelled 状态：取消会把未入库量回填到表体 cancelled_qty）
    const poE = createPurchaseOrder(
      {
        supplier_id: partnerIds['SU-1002'],
        order_date: dateOffset(-7),
        remark: '演示：已取消采购单',
        items: [
          {
            product_id: itemIds['RM-3002'],
            warehouse_id: warehouseIds['WH-01'],
            quantity: 60,
            unit_price: 860,
            promised_date: dateOffset(5),
          },
        ],
      },
      null,
    );
    confirmPurchaseOrder(poE.id);
    cancelPurchaseOrder(poE.id);

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

    // SO-E：已取消（演示 cancelled 状态：取消会把未出库量回填到表体 cancelled_qty）
    const soE = createSalesOrder(
      {
        customer_id: partnerIds['CU-2001'],
        order_date: dateOffset(-6),
        remark: '演示：已取消销售单',
        items: [
          {
            product_id: itemIds['FG-1002'],
            warehouse_id: warehouseIds['WH-02'],
            quantity: 8,
            unit_price: 12100,
            due_date: dateOffset(3),
          },
        ],
      },
      null,
    );
    confirmSalesOrder(soE.id);
    cancelSalesOrder(soE.id);

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

    // TR-C：草稿（未确认，不占用任何库存）
    createTransfer(
      {
        from_warehouse_id: warehouseIds['WH-01'],
        to_warehouse_id: warehouseIds['WH-02'],
        order_date: dateOffset(-1),
        remark: '演示：草稿调拨单',
        items: [{ product_id: itemIds['RM-3002'], quantity: 30 }],
      },
      null,
    );

    // TR-D：已确认未发货（已确认但还没出库，库存未变）
    const trD = createTransfer(
      {
        from_warehouse_id: warehouseIds['WH-02'],
        to_warehouse_id: warehouseIds['WH-01'],
        order_date: dateOffset(-2),
        remark: '演示：已确认待发货调拨单',
        items: [{ product_id: itemIds['FG-1002'], quantity: 3 }],
      },
      null,
    );
    confirmTransfer(trD.id);

    // TR-E：已取消
    const trE = createTransfer(
      {
        from_warehouse_id: warehouseIds['WH-01'],
        to_warehouse_id: warehouseIds['WH-02'],
        order_date: dateOffset(-5),
        remark: '演示：已取消调拨单',
        items: [{ product_id: itemIds['RM-3003'], quantity: 40 }],
      },
      null,
    );
    confirmTransfer(trE.id);
    cancelTransfer(trE.id);

    // ---- 盘点单 ----
    // ST-A：WH-02 成品仓，FG-1001 实盘 = 账面 − 2，已过账
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

    // ST-B：草稿（未过账，不影响库存）
    createStocktake(
      {
        warehouse_id: warehouseIds['WH-01'],
        order_date: dateOffset(-1),
        items: [
          { product_id: itemIds['RM-3002'], stock_status: 'available', counted_qty: 100 },
        ],
      },
      null,
    );

    // ST-C：已取消
    const stocktakeC = createStocktake(
      {
        warehouse_id: warehouseIds['WH-01'],
        order_date: dateOffset(-4),
        items: [
          { product_id: itemIds['RM-3004'], stock_status: 'available', counted_qty: 10 },
        ],
      },
      null,
    );
    cancelStocktake(stocktakeC.id);

    // ST-D：覆盖 frozen / qc 两个状态桶的盘点（盘盈，过账即写 adjust 流水）
    const frozenBook = readBalanceByStatus(db, itemIds['RM-3001'], warehouseIds['WH-01']).frozen;
    const qcBook = readBalanceByStatus(db, itemIds['RM-3003'], warehouseIds['WH-01']).qc;
    const stocktakeD = createStocktake(
      {
        warehouse_id: warehouseIds['WH-01'],
        order_date: dateOffset(-1),
        items: [
          { product_id: itemIds['RM-3001'], stock_status: 'frozen', counted_qty: frozenBook },
          {
            product_id: itemIds['RM-3003'],
            stock_status: 'qc',
            counted_qty: Math.max(qcBook - 3, 0),
          },
        ],
      },
      null,
    );
    postStocktake(stocktakeD.id, isoOffset(-1));

    // ---- 库存状态：WH-01 的 RM-3001 冻结 20（演示 frozen 桶） ----
    changeStockStatus({
      productId: itemIds['RM-3001'],
      warehouseId: warehouseIds['WH-01'],
      fromStatus: 'available',
      toStatus: 'frozen',
      quantity: 20,
      occurredAt: isoOffset(-2),
    });

    // ---- 销售出库（放在业务流末尾）：主料不足时用替代料兜底 ----
    // 这两单是**唯一**会写 item_substitute_log 的路径，因此放在最后执行：
    // 前面的期初、采购、销售、调拨、盘点已经把主料库存抽到低位，此处的缺口才是真实的。
    // 需求量不写死，而是按「当前可用 + 有上界的缺口」计算，避免前面数量调整后本段失效。
    const fg1001Available = readBalanceByStatus(db, itemIds['FG-1001'], warehouseIds['WH-02']).available;
    const fg1002Available = readBalanceByStatus(db, itemIds['FG-1002'], warehouseIds['WH-02']).available;
    const desiredGap = Math.max(3, Math.min(10, Math.floor(fg1001Available / 5)));
    const substituteGap = Math.min(desiredGap, fg1002Available);

    // SO-F：自动兜底（allowSubstitute=true）——主料优先，缺口由替代料按优先级补齐
    if (fg1001Available > 0 && substituteGap > 0) {
      const soF = createSalesOrder(
        {
          customer_id: partnerIds['CU-2001'],
          order_date: dateOffset(-3),
          remark: '演示：主料不足时由替代料补缺口出库',
          items: [
            {
              product_id: itemIds['FG-1001'],
              warehouse_id: warehouseIds['WH-02'],
              quantity: fg1001Available + substituteGap,
              unit_price: 15100,
              due_date: dateOffset(1),
            },
          ],
        },
        null,
      );
      confirmSalesOrder(soF.id);
      const soFLine = db
        .prepare('SELECT id FROM sales_order_item WHERE order_id = ? ORDER BY line_no')
        .get(soF.id) as { id: number };
      shipSales(
        {
          orderId: soF.id,
          lines: [
            {
              orderItemId: soFLine.id,
              quantity: fg1001Available + substituteGap,
              allowSubstitute: true,
            },
          ],
          occurredAt: isoOffset(-3),
        },
        null,
      );

      // SO-G：手工指定替代料（substituteItemId → manual 策略：主料仍优先，缺口只用指定料）
      const fg1002Left = readBalanceByStatus(db, itemIds['FG-1002'], warehouseIds['WH-02']).available;
      const manualQty = 5;
      if (fg1002Left >= manualQty) {
        const soG = createSalesOrder(
          {
            customer_id: partnerIds['CU-2001'],
            order_date: dateOffset(-2),
            remark: '演示：手工指定替代料出库',
            items: [
              {
                product_id: itemIds['FG-1001'],
                warehouse_id: warehouseIds['WH-02'],
                quantity: manualQty,
                unit_price: 15150,
                due_date: dateOffset(4),
              },
            ],
          },
          null,
        );
        confirmSalesOrder(soG.id);
        const soGLine = db
          .prepare('SELECT id FROM sales_order_item WHERE order_id = ? ORDER BY line_no')
          .get(soG.id) as { id: number };
        shipSales(
          {
            orderId: soG.id,
            lines: [
              { orderItemId: soGLine.id, quantity: manualQty, substituteItemId: itemIds['FG-1002'] },
            ],
            occurredAt: isoOffset(-2),
          },
          null,
        );
      }
    }

    // ---- 预警规则（覆盖：低于下限、同时设上下限、仓库专属、已停用） ----
    createAlertRule({ item_id: itemIds['RM-3001'], min_qty: 200 }); // 对照：充足不触发
    createAlertRule({ item_id: itemIds['RM-3003'], min_qty: 1000 }); // below_min
    createAlertRule({ item_id: itemIds['PK-4001'], min_qty: 2000 }); // below_min
    createAlertRule({
      item_id: itemIds['FG-1001'],
      warehouse_id: warehouseIds['WH-02'],
      min_qty: 80,
      max_qty: 300,
    }); // below_min
    // 下限为 0：等价于「只关心是否超过上限」，演示「设了上限但当前未超限」
    createAlertRule({ item_id: itemIds['FG-1002'], min_qty: 0, max_qty: 5000 });
    // 已停用规则：存在但不应参与预警计算
    createAlertRule({ item_id: itemIds['RM-3002'], min_qty: 9999, is_active: false });

    // ---- 节假日 / 调休日历（kind: holiday 放假 / workday 补班） ----
    // 当前没有业务逻辑读取该表，此处提供数据是为了让日历相关的后续功能有可用的样例。
    const insertHoliday = db.prepare(
      `INSERT INTO sys_holiday (holiday_date, name, kind) VALUES (?, ?, ?)`,
    );
    insertHoliday.run(dateOffset(-40), '国庆节', 'holiday');
    insertHoliday.run(dateOffset(-33), '国庆调休补班', 'workday');
    insertHoliday.run(dateOffset(20), '元旦', 'holiday');

    // ---- 演示账号：已停用（登录即被拒，用于验证「停用即时生效」） ----
    db.prepare(
      `INSERT INTO sys_user (dingtalk_user_id, name, is_active, created_at, updated_at)
       SELECT ?, ?, 0, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM sys_user WHERE dingtalk_user_id = ?)`,
    ).run('mock:离职员工', '离职员工（已停用）', now, now, 'mock:离职员工');

    // ---- 写入标记 ----
    db.prepare(
      `INSERT INTO sys_param (key, value, description, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(SEED_MARKER_KEY, now, '演示数据种子标记（pnpm seed 写入）', now);
  })();

  return { applied: true, skipped: false, counts: countAll(db) };
}