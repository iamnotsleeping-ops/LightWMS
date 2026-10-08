<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>待出库销售单</template>
      <el-table
        v-loading="loadingList"
        :data="orders"
        border
        highlight-current-row
        :current-row-key="selectedId"
        row-key="id"
        @current-change="selectOrder"
      >
        <el-table-column prop="order_no" label="销售单号" width="180" />
        <el-table-column prop="customer_name" label="客户" min-width="160" show-overflow-tooltip />
        <el-table-column prop="order_date" label="下单日期" width="120" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'partial' ? 'warning' : 'primary'">
              {{ SALES_ORDER_STATUS_LABELS[row.status as SalesOrderStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已出库 / 总量" width="160" align="right">
          <template #default="{ row }">
            {{ formatQty(row.shipped_qty, 0) }} / {{ formatQty(row.total_qty, 0) }}
          </template>
        </el-table-column>
        <el-table-column label="未出库" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.unshipped, 0) }}</template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        v-model:current-page="page"
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        @current-change="loadOrders"
      />
    </el-card>

    <el-card v-if="selected" shadow="never" v-loading="loadingDetail" class="detail">
      <template #header>
        <div class="header">
          <span>出库明细 · {{ selected.order_no }}</span>
          <el-button v-permission="PERMISSIONS.salesOutboundManage" type="primary" :loading="submitting" @click="submit">提交出库</el-button>
        </div>
      </template>

      <el-table :data="lines" border>
        <el-table-column prop="product_code" label="物料编码" width="150" />
        <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
        <el-table-column prop="warehouse_name" label="仓库" width="140" show-overflow-tooltip />
        <el-table-column label="销售数量" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="已出库" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.shipped_qty, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="未出库" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.unshipped, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="物理可用" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.available, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="本次出库数量" width="170">
          <template #default="{ row }">
            <el-input-number
              v-model="row.outbound"
              :min="0"
              :max="row.maxOutbound"
              :precision="0"
              :controls="false"
              class="full"
              :disabled="row.maxOutbound === 0"
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">
        默认按未出库量与物理可用量的较小值填入，可分批出库；每行不超过该上限（物理可用量不足时无法出库）。
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { PERMISSIONS, SALES_ORDER_STATUS_LABELS, type SalesOrderStatus } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '@/api/client';
import { formatQty } from '@/utils/format';

interface OrderRow {
  id: number;
  order_no: string;
  customer_name: string;
  order_date: string;
  status: SalesOrderStatus;
  total_qty: number;
  shipped_qty: number;
  unshipped: number;
}

interface DetailItem {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_name: string;
  quantity: number;
  shipped_qty: number;
  unshipped: number;
}

interface BalanceRow {
  product_id: number;
  warehouse_id: number;
  available_qty: number;
}

type OutboundLine = DetailItem & { available: number; maxOutbound: number; outbound: number };

const route = useRoute();

const orders = ref<OrderRow[]>([]);
const loadingList = ref(false);
const loadingDetail = ref(false);
const submitting = ref(false);
const selectedId = ref<number | undefined>(undefined);
const lines = ref<OutboundLine[]>([]);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const selected = computed(() => orders.value.find((row) => row.id === selectedId.value) ?? null);

async function loadOrders(): Promise<void> {
  loadingList.value = true;
  try {
    const { data, page: info } = await http.get<OrderRow[]>('/api/sales/orders', {
      status: 'confirmed,partial',
      page: page.value,
      pageSize,
    });
    orders.value = data;
    total.value = info?.total ?? 0;
  } finally {
    loadingList.value = false;
  }
}

/** 读取涉及物料的物理可用量，键为 `${product_id}:${warehouse_id}` */
async function loadAvailable(productIds: number[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(productIds)];
  const results = await Promise.all(
    unique.map((productId) => http.get<BalanceRow[]>('/api/inventory/balances', { productId })),
  );
  for (const { data } of results) {
    for (const row of data) {
      map.set(`${row.product_id}:${row.warehouse_id}`, row.available_qty);
    }
  }
  return map;
}

async function loadDetail(id: number): Promise<void> {
  loadingDetail.value = true;
  selectedId.value = id;
  try {
    const { data } = await http.get<{ items: DetailItem[] }>(`/api/sales/orders/${id}`);
    const available = await loadAvailable(data.items.map((item) => item.product_id));
    lines.value = data.items.map((item) => {
      const avail = available.get(`${item.product_id}:${item.warehouse_id}`) ?? 0;
      const maxOutbound = Math.min(item.unshipped, avail);
      return { ...item, available: avail, maxOutbound, outbound: maxOutbound };
    });
  } finally {
    loadingDetail.value = false;
  }
}

function selectOrder(row: OrderRow | null): void {
  if (row) void loadDetail(row.id);
}

async function submit(): Promise<void> {
  if (!selected.value) return;
  const payloadLines = lines.value
    .filter((line) => line.outbound > 0)
    .map((line) => ({ orderItemId: line.id, quantity: line.outbound }));
  if (payloadLines.length === 0) {
    ElMessage.warning('请填写本次出库数量');
    return;
  }
  submitting.value = true;
  try {
    const { data } = await http.post<{ status: SalesOrderStatus }>('/api/sales/outbound', {
      orderId: selected.value.id,
      lines: payloadLines,
    });
    ElMessage.success(`出库成功，单据状态：${SALES_ORDER_STATUS_LABELS[data.status]}`);
    await loadOrders();
    if (orders.value.some((row) => row.id === selected.value?.id)) {
      await loadDetail(selected.value.id);
    } else {
      selectedId.value = undefined;
      lines.value = [];
    }
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await loadOrders();
  const preset = Number(route.query.orderId);
  if (preset && orders.value.some((row) => row.id === preset)) {
    await loadDetail(preset);
  }
});
</script>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.full {
  width: 100%;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>