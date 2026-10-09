import { PERMISSIONS, type PermissionCode } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import AppLayout from '@/layouts/AppLayout.vue';
import { MENUS, type MenuNode } from '@/layouts/menu';
import { useAuthStore } from '@/stores/auth';
import DashboardView from '@/views/DashboardView.vue';
import AuthCallbackView from '@/views/auth/AuthCallbackView.vue';
import LoginView from '@/views/auth/LoginView.vue';
import AlertRuleView from '@/views/inventory/AlertRuleView.vue';
import StockQueryView from '@/views/inventory/StockQueryView.vue';
import StockStatusView from '@/views/inventory/StockStatusView.vue';
import StocktakeDetailView from '@/views/inventory/StocktakeDetailView.vue';
import StocktakeEditView from '@/views/inventory/StocktakeEditView.vue';
import StocktakeListView from '@/views/inventory/StocktakeListView.vue';
import StockTransactionView from '@/views/inventory/StockTransactionView.vue';
import TransferDetailView from '@/views/inventory/TransferDetailView.vue';
import TransferEditView from '@/views/inventory/TransferEditView.vue';
import TransferListView from '@/views/inventory/TransferListView.vue';
import BomView from '@/views/masterdata/BomView.vue';
import BomExplodeView from '@/views/masterdata/BomExplodeView.vue';
import ItemCategoryView from '@/views/masterdata/ItemCategoryView.vue';
import ItemListView from '@/views/masterdata/ItemListView.vue';
import PartnerView from '@/views/masterdata/PartnerView.vue';
import WarehouseView from '@/views/masterdata/WarehouseView.vue';
import PurchaseInboundView from '@/views/purchase/PurchaseInboundView.vue';
import PurchaseOrderDetailView from '@/views/purchase/PurchaseOrderDetailView.vue';
import PurchaseOrderEditView from '@/views/purchase/PurchaseOrderEditView.vue';
import PurchaseOrderListView from '@/views/purchase/PurchaseOrderListView.vue';
import InventoryLedgerView from '@/views/report/InventoryLedgerView.vue';
import ItemMovementView from '@/views/report/ItemMovementView.vue';
import StockSnapshotView from '@/views/report/StockSnapshotView.vue';
import SupplierLeadTimeView from '@/views/report/SupplierLeadTimeView.vue';
import ApiDocsView from '@/views/system/ApiDocsView.vue';
import RoleView from '@/views/system/RoleView.vue';
import SystemParamView from '@/views/system/SystemParamView.vue';
import UserView from '@/views/system/UserView.vue';
import SalesOrderDetailView from '@/views/sales/SalesOrderDetailView.vue';
import SalesOrderEditView from '@/views/sales/SalesOrderEditView.vue';
import SalesOrderListView from '@/views/sales/SalesOrderListView.vue';
import SalesOutboundView from '@/views/sales/SalesOutboundView.vue';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  {
    path: '/auth/callback',
    name: 'auth-callback',
    component: AuthCallbackView,
    meta: { public: true },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'dashboard', name: 'dashboard', component: DashboardView, meta: { title: '首页看板' } },
      {
        path: 'masterdata/items',
        name: 'masterdata-items',
        component: ItemListView,
        meta: { title: '物料管理' },
      },
      {
        path: 'masterdata/categories',
        name: 'masterdata-categories',
        component: ItemCategoryView,
        meta: { title: '物料分类' },
      },
      {
        path: 'masterdata/bom',
        name: 'masterdata-bom',
        component: BomView,
        meta: { title: 'BOM 管理' },
      },
      {
        path: 'masterdata/bom/explode',
        name: 'masterdata-bom-explode',
        component: BomExplodeView,
        meta: { title: 'BOM 展开' },
      },
      {
        path: 'masterdata/partners',
        name: 'masterdata-partners',
        component: PartnerView,
        meta: { title: '往来单位' },
      },
      {
        path: 'masterdata/warehouses',
        name: 'masterdata-warehouses',
        component: WarehouseView,
        meta: { title: '仓库 / 工厂管理' },
      },
      {
        path: 'inventory/stocks',
        name: 'inventory-stocks',
        component: StockQueryView,
        meta: { title: '库存查询' },
      },
      {
        path: 'inventory/status',
        name: 'inventory-status',
        component: StockStatusView,
        meta: { title: '库存状态管理' },
      },
      {
        path: 'inventory/transactions',
        name: 'inventory-transactions',
        component: StockTransactionView,
        meta: { title: '库存流水' },
      },
      {
        path: 'inventory/transfers',
        name: 'transfers',
        component: TransferListView,
        meta: { title: '库存调拨' },
      },
      {
        path: 'inventory/transfers/new',
        name: 'transfer-new',
        component: TransferEditView,
        meta: { title: '新建调拨单', permission: PERMISSIONS.inventoryTransferManage },
      },
      {
        path: 'inventory/transfers/:id',
        name: 'transfer-detail',
        component: TransferDetailView,
        meta: { title: '调拨单详情' },
      },
      {
        path: 'inventory/transfers/:id/edit',
        name: 'transfer-edit',
        component: TransferEditView,
        meta: { title: '编辑调拨单', permission: PERMISSIONS.inventoryTransferManage },
      },
      {
        path: 'inventory/stocktakes',
        name: 'stocktakes',
        component: StocktakeListView,
        meta: { title: '库存盘点' },
      },
      {
        path: 'inventory/stocktakes/new',
        name: 'stocktake-new',
        component: StocktakeEditView,
        meta: { title: '新建盘点单', permission: PERMISSIONS.inventoryStocktakeManage },
      },
      {
        path: 'inventory/stocktakes/:id',
        name: 'stocktake-detail',
        component: StocktakeDetailView,
        meta: { title: '盘点单详情' },
      },
      {
        path: 'inventory/stocktakes/:id/edit',
        name: 'stocktake-edit',
        component: StocktakeEditView,
        meta: { title: '编辑盘点单', permission: PERMISSIONS.inventoryStocktakeManage },
      },
      {
        path: 'inventory/alerts',
        name: 'inventory-alerts',
        component: AlertRuleView,
        meta: { title: '库存预警' },
      },
      {
        path: 'purchase/orders',
        name: 'purchase-orders',
        component: PurchaseOrderListView,
        meta: { title: '采购单列表' },
      },
      {
        path: 'purchase/orders/new',
        name: 'purchase-order-new',
        component: PurchaseOrderEditView,
        meta: { title: '新建采购单', permission: PERMISSIONS.purchaseOrderManage },
      },
      {
        path: 'purchase/orders/:id',
        name: 'purchase-order-detail',
        component: PurchaseOrderDetailView,
        meta: { title: '采购单详情' },
      },
      {
        path: 'purchase/orders/:id/edit',
        name: 'purchase-order-edit',
        component: PurchaseOrderEditView,
        meta: { title: '编辑采购单', permission: PERMISSIONS.purchaseOrderManage },
      },
      {
        path: 'purchase/inbound',
        name: 'purchase-inbound',
        component: PurchaseInboundView,
        meta: { title: '采购入库', permission: PERMISSIONS.purchaseInboundManage },
      },
      {
        path: 'sales/orders',
        name: 'sales-orders',
        component: SalesOrderListView,
        meta: { title: '销售单列表' },
      },
      {
        path: 'sales/orders/new',
        name: 'sales-order-new',
        component: SalesOrderEditView,
        meta: { title: '新建销售单', permission: PERMISSIONS.salesOrderManage },
      },
      {
        path: 'sales/orders/:id',
        name: 'sales-order-detail',
        component: SalesOrderDetailView,
        meta: { title: '销售单详情' },
      },
      {
        path: 'sales/orders/:id/edit',
        name: 'sales-order-edit',
        component: SalesOrderEditView,
        meta: { title: '编辑销售单', permission: PERMISSIONS.salesOrderManage },
      },
      {
        path: 'sales/outbound',
        name: 'sales-outbound',
        component: SalesOutboundView,
        meta: { title: '销售出库', permission: PERMISSIONS.salesOutboundManage },
      },
      {
        path: 'report/ledger',
        name: 'report-ledger',
        component: InventoryLedgerView,
        meta: { title: '进销存明细账' },
      },
      {
        path: 'report/stock-snapshot',
        name: 'report-stock-snapshot',
        component: StockSnapshotView,
        meta: { title: '库存现状表' },
      },
      {
        path: 'report/movement',
        name: 'report-movement',
        component: ItemMovementView,
        meta: { title: '商品收发明细' },
      },
      {
        path: 'report/supplier-lead-time',
        name: 'report-supplier-lead-time',
        component: SupplierLeadTimeView,
        meta: { title: '供应商提前期分析' },
      },
      {
        path: 'system/users',
        name: 'system-users',
        component: UserView,
        meta: { title: '用户管理' },
      },
      {
        path: 'system/roles',
        name: 'system-roles',
        component: RoleView,
        meta: { title: '角色权限' },
      },
      {
        path: 'system/params',
        name: 'system-params',
        component: SystemParamView,
        meta: { title: '系统参数' },
      },
      {
        path: 'system/api-docs',
        name: 'system-api-docs',
        component: ApiDocsView,
        meta: { title: '数据接口', permission: PERMISSIONS.systemApidocView },
      },
    ],
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * 路由所需权限码：由菜单定义派生（菜单与守卫同源，避免两处各写一份权限码）。
 * 按「最长 path 前缀」匹配，使列表页的子路由（新建 / 详情 / 编辑）继承同一权限。
 */
const ROUTE_PERMISSIONS: [string, PermissionCode][] = (() => {
  const entries: [string, PermissionCode][] = [];
  const walk = (nodes: MenuNode[]): void => {
    for (const node of nodes) {
      if (node.path && node.permission) entries.push([node.path, node.permission]);
      if (node.children) walk(node.children);
    }
  };
  walk(MENUS);
  return entries.sort((a, b) => b[0].length - a[0].length);
})();

/**
 * 路由所需权限码：优先取路由自身的 `meta.permission`（写操作页等需要更严校验的场景），
 * 缺省时回退到菜单派生的「查看」权限。
 */
function requiredPermission(path: string, metaPermission?: PermissionCode): PermissionCode | undefined {
  if (metaPermission) return metaPermission;
  return ROUTE_PERMISSIONS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1];
}

router.beforeEach(async (to) => {
  if (to.meta.public) return true;

  const auth = useAuthStore();
  if (!auth.isLoggedIn) {
    return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }
  if (!auth.user) {
    try {
      await auth.fetchMe();
    } catch {
      auth.clear();
      return { path: '/login' };
    }
  }

  // 二次校验：菜单只是隐藏入口，直接输入 URL 时在此拦截
  const required = requiredPermission(to.path, to.meta.permission as PermissionCode | undefined);
  if (required && !auth.has(required)) {
    ElMessage.warning('无权访问该页面');
    return { path: '/dashboard' };
  }
  return true;
});