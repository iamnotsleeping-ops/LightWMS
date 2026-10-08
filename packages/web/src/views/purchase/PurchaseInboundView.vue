<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>待入库采购单</template>
      <el-table
        v-loading="loadingList"
        :data="orders"
        border
        highlight-current-row
        :current-row-key="selectedId"
        row-key="id"
        @current-change="selectOrder"
      >
        <el-table-column prop="order_no" label="采购单号" width="180" />
        <el-table-column prop="supplier_name" label="供应商" min-width="160" show-overflow-tooltip />
        <el-table-column prop="order_date" label="下单日期" width="120" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'partial' ? 'warning' : 'primary'">
              {{ PURCHASE_ORDER_STATUS_LABELS[row.status as PurchaseOrderStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已入库 / 总量" width="160" align="right">
          <template #default="{ row }">
            {{ formatQty(row.received_qty, 0) }} / {{ formatQty(row.total_qty, 0) }}
          </template>
        </el-table-column>
        <el-table-column label="在途" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.in_transit, 0) }}</template>
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
          <span>入库明细 · {{ selected.order_no }}</span>
          <el-button type="primary" :loading="submitting" @click="submit">提交入库</el-button>
        </div>
      </template>

      <el-table :data="lines" border>
        <el-table-column prop="product_code" label="物料编码" width="150" />
        <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
        <el-table-column prop="warehouse_name" label="仓库" width="140" show-overflow-tooltip />
        <el-table-column label="采购数量" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="已入库" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.received_qty, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="在途" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.in_transit, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="本次入库数量" width="170">
          <template #default="{ row }">
            <el-input-number
              v-model="row.inbound"
              :min="0"
              :max="row.in_transit"
              :precision="0"
              :controls="false"
              class="full"
              :disabled="row.in_transit === 0"
            />
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">默认按在途量填入，可分批入库；每行数量不得超过在途量。</div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { PURCHASE_ORDER_STATUS_LABELS, type PurchaseOrderStatus } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '@/api/client';
import { formatQty } from '@/utils/format';

interface OrderRow {
  id: number;
  order_no: string;
  supplier_name: string;
  order_date: string;
  status: PurchaseOrderStatus;
  total_qty: number;
  received_qty: number;
  in_transit: number;
}

interface DetailItem {
  id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_name: string;
  quantity: number;
  received_qty: number;
  in_transit: number;
}

type InboundLine = DetailItem & { inbound: number };

const route = useRoute();

const orders = ref<OrderRow[]>([]);
const loadingList = ref(false);
const loadingDetail = ref(false);
const submitting = ref(false);
const selectedId = ref<number | undefined>(undefined);
const lines = ref<InboundLine[]>([]);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const selected = computed(() => orders.value.find((row) => row.id === selectedId.value) ?? null);

async function loadOrders(): Promise<void> {
  loadingList.value = true;
  try {
    const { data, page: info } = await http.get<OrderRow[]>('/api/purchase/orders', {
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

async function loadDetail(id: number): Promise<void> {
  loadingDetail.value = true;
  selectedId.value = id;
  try {
    const { data } = await http.get<{ items: DetailItem[] }>(`/api/purchase/orders/${id}`);
    lines.value = data.items.map((item) => ({ ...item, inbound: item.in_transit }));
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
    .filter((line) => line.inbound > 0)
    .map((line) => ({ orderItemId: line.id, quantity: line.inbound }));
  if (payloadLines.length === 0) {
    ElMessage.warning('请填写本次入库数量');
    return;
  }
  submitting.value = true;
  try {
    const { data } = await http.post<{ status: PurchaseOrderStatus }>('/api/purchase/inbound', {
      orderId: selected.value.id,
      lines: payloadLines,
    });
    ElMessage.success(`入库成功，单据状态：${PURCHASE_ORDER_STATUS_LABELS[data.status]}`);
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