import { PERMISSIONS, type PermissionCode } from '@light-erp/shared';

export interface MenuNode {
  /** 有 path 才可点击；无 path 表示该页面尚未实现 */
  title: string;
  path?: string;
  /** 需要的权限码，缺省表示无需权限 */
  permission?: PermissionCode;
  children?: MenuNode[];
}

/**
 * 左侧导航结构。页面随各阶段落地后补上 path 即可点亮，
 * 未实现的条目保持禁用，避免出现无效跳转。
 */
export const MENUS: MenuNode[] = [
  { title: '首页看板', path: '/dashboard' },
  {
    title: '基础资料',
    children: [
      { title: '物料管理', path: '/masterdata/items', permission: PERMISSIONS.masterdataItemView },
      {
        title: '物料分类',
        path: '/masterdata/categories',
        permission: PERMISSIONS.masterdataCategoryView,
      },
      { title: 'BOM 管理', path: '/masterdata/bom', permission: PERMISSIONS.masterdataBomView },
      {
        title: 'BOM 展开',
        path: '/masterdata/bom/explode',
        permission: PERMISSIONS.masterdataBomView,
      },
      {
        title: '往来单位',
        path: '/masterdata/partners',
        permission: PERMISSIONS.masterdataPartnerView,
      },
      {
        title: '仓库 / 工厂管理',
        path: '/masterdata/warehouses',
        permission: PERMISSIONS.masterdataWarehouseView,
      },
      {
        title: '替代关系',
        path: '/masterdata/substitutes',
        permission: PERMISSIONS.masterdataSubstituteView,
      },
    ],
  },
  {
    title: '采购管理',
    children: [
      {
        title: '采购单列表',
        path: '/purchase/orders',
        permission: PERMISSIONS.purchaseOrderView,
      },
      {
        title: '采购入库',
        path: '/purchase/inbound',
        permission: PERMISSIONS.purchaseInboundManage,
      },
    ],
  },
  {
    title: '销售管理',
    children: [
      { title: '销售单列表', path: '/sales/orders', permission: PERMISSIONS.salesOrderView },
      {
        title: '销售出库',
        path: '/sales/outbound',
        permission: PERMISSIONS.salesOutboundManage,
      },
    ],
  },
  {
    title: '库存管理',
    children: [
      { title: '库存查询', path: '/inventory/stocks', permission: PERMISSIONS.inventoryQueryView },
      {
        title: '库存状态管理',
        path: '/inventory/status',
        permission: PERMISSIONS.inventoryQueryView,
      },
      {
        title: '库存流水',
        path: '/inventory/transactions',
        permission: PERMISSIONS.inventoryTransactionView,
      },
      {
        title: '库存调拨',
        path: '/inventory/transfers',
        permission: PERMISSIONS.inventoryTransferView,
      },
      {
        title: '库存盘点',
        path: '/inventory/stocktakes',
        permission: PERMISSIONS.inventoryStocktakeView,
      },
      {
        title: '库存预警设置',
        path: '/inventory/alerts',
        permission: PERMISSIONS.inventoryAlertView,
      },
    ],
  },
  {
    title: '报表',
    children: [
      { title: '进销存明细账', path: '/report/ledger', permission: PERMISSIONS.reportView },
      { title: '库存现状表', path: '/report/stock-snapshot', permission: PERMISSIONS.reportView },
      { title: '商品收发明细', path: '/report/movement', permission: PERMISSIONS.reportView },
      {
        title: '供应商提前期分析',
        path: '/report/supplier-lead-time',
        permission: PERMISSIONS.reportView,
      },
      {
        title: '替代料调用',
        path: '/report/substitute-usage',
        permission: PERMISSIONS.reportView,
      },
    ],
  },
  {
    title: '系统设置',
    children: [
      { title: '用户管理', path: '/system/users', permission: PERMISSIONS.systemUserView },
      { title: '角色权限', path: '/system/roles', permission: PERMISSIONS.systemRoleView },
      { title: '系统参数', path: '/system/params', permission: PERMISSIONS.systemParamView },
      { title: '数据接口', path: '/system/api-docs', permission: PERMISSIONS.systemApidocView },
    ],
  },
];

/** 按当前用户权限裁剪导航；无可见子项的分组整体隐藏 */
export function visibleMenus(has: (code: string) => boolean): MenuNode[] {
  const result: MenuNode[] = [];
  for (const node of MENUS) {
    if (node.children) {
      const children = node.children.filter(
        (child) => !child.permission || has(child.permission),
      );
      if (children.length > 0) result.push({ ...node, children });
      continue;
    }
    if (!node.permission || has(node.permission)) result.push(node);
  }
  return result;
}