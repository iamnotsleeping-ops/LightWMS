/**
 * 库存状态：可用 / 冻结 / 质检中
 * 可用量口径只统计 available，frozen 与 qc 一律不计入
 */
export const STOCK_STATUSES = ['available', 'frozen', 'qc'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  available: '可用',
  frozen: '冻结',
  qc: '质检中',
};

/** 库存流水业务类型 */
export const BIZ_TYPES = [
  'purchase_in',
  'sale_out',
  'purchase_return',
  'sale_return',
  'transfer_out',
  'transfer_in',
  'adjust',
  'status_change',
] as const;
export type BizType = (typeof BIZ_TYPES)[number];

/** 流水方向：1 入库 / -1 出库；quantity 恒为正数 */
export const DIRECTIONS = { IN: 1, OUT: -1 } as const;
export type Direction = (typeof DIRECTIONS)[keyof typeof DIRECTIONS];

/** 采购单状态机：draft → confirmed → partial → received，draft/confirmed 可 → cancelled */
export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partial',
  'received',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  partial: '部分入库',
  received: '已入库',
  cancelled: '已取消',
};

/** 销售单状态机：draft → confirmed → partial → shipped，draft/confirmed 可 → cancelled */
export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partial',
  'shipped',
  'cancelled',
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

export const SALES_ORDER_STATUS_LABELS: Record<SalesOrderStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  partial: '部分出库',
  shipped: '已出库',
  cancelled: '已取消',
};

/** 调拨单状态机：draft → confirmed → shipped → received，confirmed 前可 → cancelled */
export const TRANSFER_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'shipped',
  'received',
  'cancelled',
] as const;
export type TransferOrderStatus = (typeof TRANSFER_ORDER_STATUSES)[number];

export const TRANSFER_ORDER_STATUS_LABELS: Record<TransferOrderStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  shipped: '在途',
  received: '已收货',
  cancelled: '已取消',
};

/** 盘点单：draft → posted，draft 可 → cancelled */
export const STOCKTAKE_ORDER_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type StocktakeOrderStatus = (typeof STOCKTAKE_ORDER_STATUSES)[number];

export const STOCKTAKE_ORDER_STATUS_LABELS: Record<StocktakeOrderStatus, string> = {
  draft: '草稿',
  posted: '已过账',
  cancelled: '已取消',
};

/** 库存预警类型：低于下限 / 高于上限 */
export const ALERT_TYPES = ['below_min', 'above_max'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/* ---------- 替代料（P10） ---------- */

/** 替代关系生效场景。本项目无生产工单/MRP，故只有这三个场景 */
export const SUBSTITUTE_SCENES = ['sales_out', 'bom_plan', 'purchase_hint'] as const;
export type SubstituteScene = (typeof SUBSTITUTE_SCENES)[number];

export const SUBSTITUTE_SCENE_LABELS: Record<SubstituteScene, string> = {
  sales_out: '销售出库',
  bom_plan: 'BOM 备料',
  purchase_hint: '采购建议',
};

/** 替代策略：按比例混用 / 整批全量 / 手工指定 */
export const SUBSTITUTE_STRATEGIES = ['proportion', 'whole_batch', 'manual'] as const;
export type SubstituteStrategy = (typeof SUBSTITUTE_STRATEGIES)[number];

export const SUBSTITUTE_STRATEGY_LABELS: Record<SubstituteStrategy, string> = {
  proportion: '按比例混用',
  whole_batch: '整批全量',
  manual: '手工指定',
};

/** 某个替代料被跳过的原因（必须回传给前端，不允许静默丢弃） */
export const SUBSTITUTE_SKIP_REASONS = [
  'no_stock',
  'customer_not_certified',
  'customer_cert_expired',
  'relation_inactive',
  'out_of_validity',
  'wrong_warehouse',
  'wrong_parent',
  'manual_excluded',
  'same_as_main',
] as const;
export type SubstitutionSkipReason = (typeof SUBSTITUTE_SKIP_REASONS)[number];

export const SUBSTITUTE_SKIP_REASON_LABELS: Record<SubstitutionSkipReason, string> = {
  no_stock: '无可用库存',
  customer_not_certified: '该客户未认证此替代料',
  customer_cert_expired: '该客户的替代料认证已过期',
  relation_inactive: '替代关系已停用',
  out_of_validity: '不在替代关系生效期内',
  wrong_warehouse: '替代关系不适用于该仓库',
  wrong_parent: '替代关系仅适用于其它父件',
  manual_excluded: '未在手工指定范围内',
  same_as_main: '与主料相同',
};

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  below_min: '低于下限',
  above_max: '高于上限',
};

/** 往来单位类型 */
export const PARTNER_TYPES = ['customer', 'supplier', 'both'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

/** 仓库类型：工厂 / 仓库 / 港口 */
export const WAREHOUSE_TYPES = ['plant', 'warehouse', 'port'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

/** 数量单位（物料基本单位）：EA 件类 / KG 千克 / M 米 / L 升 / ROLL 卷 */
export const BASE_UNITS = ['EA', 'KG', 'M', 'L', 'ROLL'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

export const BASE_UNIT_LABELS: Record<BaseUnit, string> = {
  EA: '件/个',
  KG: '千克',
  M: '米',
  L: '升',
  ROLL: '卷',
};

/** 单号前缀，配合 YYYYMMDD-NNNN 生成，如 PO-20261007-0001 */
export const DOC_TYPE_PREFIX = {
  purchase: 'PO',
  purchase_return: 'PR',
  sales: 'SO',
  sales_return: 'SR',
  transfer: 'TR',
  stocktake: 'CK',
} as const;
export type DocType = keyof typeof DOC_TYPE_PREFIX;

/** 在途归属：只有采购单处于这两个状态才计入采购在途 */
export const IN_TRANSIT_PURCHASE_STATUSES = ['confirmed', 'partial'] as const;

/**
 * 权限码清单。与 0002_rbac_seed.sql 内置权限一致，
 * 后端路由（requirePermission）与前端菜单 / 路由守卫共用，避免字符串散落。
 */
export const PERMISSIONS = {
  // 基础资料
  masterdataItemView: 'masterdata.item.view',
  masterdataItemManage: 'masterdata.item.manage',
  masterdataCategoryView: 'masterdata.category.view',
  masterdataCategoryManage: 'masterdata.category.manage',
  masterdataBomView: 'masterdata.bom.view',
  masterdataBomManage: 'masterdata.bom.manage',
  masterdataPartnerView: 'masterdata.partner.view',
  masterdataPartnerManage: 'masterdata.partner.manage',
  masterdataWarehouseView: 'masterdata.warehouse.view',
  masterdataWarehouseManage: 'masterdata.warehouse.manage',
  // 替代料（P10）。view 与 manage 分离；sales.outbound.substitute 单列，
  // 使「查看替代建议」与「实际用替代料出库」可以按角色分别授予/收回。
  masterdataSubstituteView: 'masterdata.substitute.view',
  masterdataSubstituteManage: 'masterdata.substitute.manage',
  // 采购
  purchaseOrderView: 'purchase.order.view',
  purchaseOrderManage: 'purchase.order.manage',
  purchaseOrderConfirm: 'purchase.order.confirm',
  purchaseInboundManage: 'purchase.inbound.manage',
  // 销售
  salesOrderView: 'sales.order.view',
  salesOrderManage: 'sales.order.manage',
  salesOrderConfirm: 'sales.order.confirm',
  salesOutboundManage: 'sales.outbound.manage',
  /** 实际使用替代料替代主料出库（仅"看建议"不需要它） */
  salesOutboundSubstitute: 'sales.outbound.substitute',
  // 库存
  inventoryQueryView: 'inventory.query.view',
  inventoryTransactionView: 'inventory.transaction.view',
  inventoryStatusManage: 'inventory.status.manage',
  inventoryTransferView: 'inventory.transfer.view',
  inventoryTransferManage: 'inventory.transfer.manage',
  inventoryStocktakeView: 'inventory.stocktake.view',
  inventoryStocktakeManage: 'inventory.stocktake.manage',
  inventoryAlertView: 'inventory.alert.view',
  inventoryAlertManage: 'inventory.alert.manage',
  // 报表
  reportView: 'report.view',
  // 系统设置
  systemUserView: 'system.user.view',
  systemUserManage: 'system.user.manage',
  systemRoleView: 'system.role.view',
  systemRoleManage: 'system.role.manage',
  systemParamView: 'system.param.view',
  systemParamManage: 'system.param.manage',
  systemApidocView: 'system.apidoc.view',
} as const;
export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 全部权限码枚举（用于校验 / 遍历） */
export const PERMISSION_CODES = Object.values(PERMISSIONS) as PermissionCode[];