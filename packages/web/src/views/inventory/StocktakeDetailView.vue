<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>盘点单详情 {{ order?.order_no }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button v-if="canManage && order?.status === 'draft'" type="primary" @click="post">
            过账
          </el-button>
          <el-button v-if="canManage && order?.status === 'draft'" type="warning" @click="cancel">
            取消
          </el-button>
        </div>
      </div>
    </template>

    <el-descriptions :column="3" border class="head">
      <el-descriptions-item label="仓库">{{ order?.warehouse_name }}</el-descriptions-item>
      <el-descriptions-item label="盘点日期">{{ order?.order_date }}</el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag v-if="order" :type="STATUS_TAG[order.status]">
          {{ STOCKTAKE_ORDER_STATUS_LABELS[order.status] }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="过账时间" :span="3">
        {{ order?.posted_at ? readTime(order.posted_at) : '—' }}
      </el-descriptions-item>
    </el-descriptions>

    <el-table :data="items" border class="block">
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="product_code" label="物料编码" width="150" />
      <el-table-column prop="product_name" label="物料描述" min-width="200" show-overflow-tooltip />
      <el-table-column label="库存状态" width="110">
        <template #default="{ row }">{{ STOCK_STATUS_LABELS[row.stock_status as StockStatus] }}</template>
      </el-table-column>
      <el-table-column label="账面量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.book_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="实盘量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.counted_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="差异" width="120" align="right">
        <template #default="{ row }">
          <span :class="diffClass(row.diff_qty)">{{ formatQty(row.diff_qty, row.qty_precision) }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="base_unit" label="单位" width="80" />
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import {
  PERMISSIONS,
  STOCK_STATUS_LABELS,
  STOCKTAKE_ORDER_STATUS_LABELS,
  type StockStatus,
  type StocktakeOrderStatus,
} from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { confirmAction } from '@/utils/confirm';
import { formatQty } from '@/utils/format';

interface OrderHeader {
  id: number;
  order_no: string;
  warehouse_name: string;
  order_date: string;
  status: StocktakeOrderStatus;
  posted_at: string | null;
}

interface OrderItem {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  stock_status: StockStatus;
  book_qty: number;
  counted_qty: number;
  diff_qty: number;
}

const STATUS_TAG: Record<StocktakeOrderStatus, 'info' | 'success' | 'danger'> = {
  draft: 'info',
  posted: 'success',
  cancelled: 'danger',
};

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.inventoryStocktakeManage));

const loading = ref(false);
const order = ref<OrderHeader | null>(null);
const items = ref<OrderItem[]>([]);

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

function diffClass(value: number): string {
  if (value > 0) return 'plus';
  if (value < 0) return 'minus';
  return '';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<{ order: OrderHeader; items: OrderItem[] }>(
      `/api/inventory/stocktakes/${route.params.id}`,
    );
    order.value = data.order;
    items.value = data.items;
  } finally {
    loading.value = false;
  }
}

const goBack = () => void router.push({ name: 'stocktakes' });

async function post(): Promise<void> {
  if (!(await confirmAction('过账后将按实盘量对齐账面库存并生成调整流水，单据不可再修改。', '确认过账'))) return;
  await http.post(`/api/inventory/stocktakes/${route.params.id}/post`);
  ElMessage.success('已过账');
  await load();
}

async function cancel(): Promise<void> {
  if (!(await confirmAction('取消后单据作废且不可恢复。', '取消盘点单'))) return;
  await http.post(`/api/inventory/stocktakes/${route.params.id}/cancel`);
  ElMessage.success('已取消');
  await load();
}

onMounted(load);
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.head {
  margin-bottom: 16px;
}

.block {
  margin-top: 8px;
}

.plus {
  color: #67c23a;
  font-weight: 600;
}

.minus {
  color: #f56c6c;
  font-weight: 600;
}
</style>