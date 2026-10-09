<template>
  <div class="dashboard" v-loading="loading">
    <div class="kpi-row">
      <el-card v-for="card in kpiCards" :key="card.label" shadow="never" class="kpi">
        <div class="kpi-label">{{ card.label }}</div>
        <div class="kpi-value" :class="card.tone">{{ card.value }}</div>
        <div class="kpi-hint">{{ card.hint }}</div>
      </el-card>
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="header">
          <span>近 30 天出入库趋势</span>
          <span class="sub">单位：最小计量单位合计（不含状态转移）</span>
        </div>
      </template>
      <EChart :option="trendOption" />
    </el-card>

    <div class="split">
      <el-card shadow="never" class="block">
        <template #header>
          <div class="header">
            <span>库存预警 Top 10</span>
            <el-button link type="primary" @click="go('/inventory/alerts')">查看全部</el-button>
          </div>
        </template>
        <el-table :data="alerts" border stripe size="small">
          <el-table-column prop="product_code" label="物料编码" width="130" />
          <el-table-column prop="product_name" label="物料描述" min-width="150" show-overflow-tooltip />
          <el-table-column label="范围" width="130" show-overflow-tooltip>
            <template #default="{ row }">{{ row.warehouse_name ?? '全局（跨仓汇总）' }}</template>
          </el-table-column>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">
              <el-tag :type="row.alert_type === 'below_min' ? 'danger' : 'warning'" size="small">
                {{ row.alert_type === 'below_min' ? '低于下限' : '高于上限' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="当前可用量" width="120" align="right">
            <template #default="{ row }">{{ formatQty(row.current_qty, row.qty_precision) }}</template>
          </el-table-column>
          <el-table-column label="下限" width="110" align="right">
            <template #default="{ row }">{{ formatQty(row.min_qty, row.qty_precision) }}</template>
          </el-table-column>
          <template #empty>暂无预警</template>
        </el-table>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>
          <div class="header"><span>单据待办</span></div>
        </template>
        <div class="todos">
          <div
            v-for="todo in todoCards"
            :key="todo.key"
            class="todo"
            @click="go(todo.path)"
          >
            <span class="todo-label">{{ todo.label }}</span>
            <span class="todo-count" :class="{ zero: todo.count === 0 }">{{ todo.count }}</span>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { EChartsOption } from 'echarts';
import { PERMISSIONS, type PermissionCode } from '@light-erp/shared';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/client';
import EChart from '@/components/EChart.vue';
import { useAuthStore } from '@/stores/auth';
import { formatAmount, formatQty } from '@/utils/format';

interface OverviewKpi {
  on_hand_qty: number;
  /** 库存金额：按流水累计的结存价值（含冻结/待检） */
  stock_amount: number;
  item_count: number;
  in_transit_qty: number;
  alert_count: number;
}

interface TrendPoint {
  date: string;
  in_qty: number;
  out_qty: number;
}

interface AlertRow {
  rule_id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_name: string | null;
  current_qty: number;
  min_qty: number;
  max_qty: number | null;
  alert_type: string;
}

interface OverviewTodos {
  purchase_draft: number;
  purchase_pending_inbound: number;
  sales_draft: number;
  sales_pending_outbound: number;
  transfer_in_transit: number;
}

interface Overview {
  kpi: OverviewKpi;
  trend: TrendPoint[];
  alerts: AlertRow[];
  todos: OverviewTodos;
}

const router = useRouter();
const loading = ref(false);
const kpi = ref<OverviewKpi>({
  on_hand_qty: 0,
  stock_amount: 0,
  item_count: 0,
  in_transit_qty: 0,
  alert_count: 0,
});
const trend = ref<TrendPoint[]>([]);
const alerts = ref<AlertRow[]>([]);
const todos = ref<OverviewTodos>({
  purchase_draft: 0,
  purchase_pending_inbound: 0,
  sales_draft: 0,
  sales_pending_outbound: 0,
  transfer_in_transit: 0,
});

/** KPI 数量跨物料精度合并，只能展示最小单位整数合计 */
function plainQty(value: number): string {
  return value.toLocaleString('zh-CN');
}

const kpiCards = computed(() => [
  { label: '现存量', value: plainQty(kpi.value.on_hand_qty), hint: '可用状态合计', tone: '' },
  { label: '库存金额', value: formatAmount(kpi.value.stock_amount), hint: '元（含冻结/待检）', tone: '' },
  { label: '物料数', value: plainQty(kpi.value.item_count), hint: '启用物料', tone: '' },
  { label: '在途量', value: plainQty(kpi.value.in_transit_qty), hint: '采购 + 调拨', tone: '' },
  {
    label: '预警数',
    value: plainQty(kpi.value.alert_count),
    hint: '触发规则数',
    tone: kpi.value.alert_count > 0 ? 'danger' : '',
  },
]);

const trendOption = computed<EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  legend: { data: ['入库', '出库'], top: 0 },
  grid: { left: 56, right: 20, top: 40, bottom: 32 },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    data: trend.value.map((point) => point.date.slice(5)),
  },
  yAxis: { type: 'value' },
  series: [
    {
      name: '入库',
      type: 'line',
      smooth: true,
      showSymbol: false,
      itemStyle: { color: '#67c23a' },
      areaStyle: { opacity: 0.12, color: '#67c23a' },
      data: trend.value.map((point) => point.in_qty),
    },
    {
      name: '出库',
      type: 'line',
      smooth: true,
      showSymbol: false,
      itemStyle: { color: '#f56c6c' },
      areaStyle: { opacity: 0.12, color: '#f56c6c' },
      data: trend.value.map((point) => point.out_qty),
    },
  ],
}));

const auth = useAuthStore();

/**
 * 待办卡片按其目标路由所需的权限码裁剪：
 * 看板接口本身只需登录，低权限用户同样能拿到待办计数；若不过滤，会出现
 * 「看得到卡片、点进去被路由守卫弹回并提示无权访问」的体验。
 */
const todoCards = computed(() => {
  const cards: { key: string; label: string; count: number; path: string; permission: PermissionCode }[] = [
    {
      key: 'purchase_draft',
      label: '采购草稿',
      count: todos.value.purchase_draft,
      path: '/purchase/orders',
      permission: PERMISSIONS.purchaseOrderView,
    },
    {
      key: 'purchase_pending_inbound',
      label: '待入库采购单',
      count: todos.value.purchase_pending_inbound,
      path: '/purchase/inbound',
      permission: PERMISSIONS.purchaseInboundManage,
    },
    {
      key: 'sales_draft',
      label: '销售草稿',
      count: todos.value.sales_draft,
      path: '/sales/orders',
      permission: PERMISSIONS.salesOrderView,
    },
    {
      key: 'sales_pending_outbound',
      label: '待出库销售单',
      count: todos.value.sales_pending_outbound,
      path: '/sales/outbound',
      permission: PERMISSIONS.salesOutboundManage,
    },
    {
      key: 'transfer_in_transit',
      label: '在途调拨单',
      count: todos.value.transfer_in_transit,
      path: '/inventory/transfers',
      permission: PERMISSIONS.inventoryTransferView,
    },
  ];
  return cards.filter((card) => auth.has(card.permission));
});

function go(path: string): void {
  void router.push(path);
}

onMounted(async () => {
  loading.value = true;
  try {
    const { data } = await http.get<Overview>('/api/dashboard/overview');
    kpi.value = data.kpi;
    trend.value = data.trend;
    alerts.value = data.alerts;
    todos.value = data.todos;
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.kpi-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
}

.kpi-label {
  font-size: 13px;
  color: #909399;
}

.kpi-value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
}

.kpi-value.danger {
  color: #f56c6c;
}

.kpi-hint {
  margin-top: 4px;
  font-size: 12px;
  color: #c0c4cc;
}

.block {
  margin-top: 16px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.sub {
  font-size: 12px;
  color: #909399;
}

.split {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
}

.todos {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.todo:hover {
  background: #f5f7fa;
}

.todo-label {
  font-size: 14px;
  color: #303133;
}

.todo-count {
  font-size: 18px;
  font-weight: 600;
  color: #409eff;
}

.todo-count.zero {
  color: #c0c4cc;
}
</style>