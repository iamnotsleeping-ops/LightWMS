<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>调拨单详情 {{ order?.order_no }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button v-if="canManage && order?.status === 'draft'" type="success" @click="confirm">
            确认
          </el-button>
          <el-button
            v-if="canManage && (order?.status === 'draft' || order?.status === 'confirmed')"
            type="warning"
            @click="cancel"
          >
            取消
          </el-button>
          <el-button v-if="canManage && order?.status === 'confirmed'" type="primary" @click="ship">
            发货
          </el-button>
          <el-button v-if="canManage && order?.status === 'shipped'" type="primary" @click="receive">
            收货
          </el-button>
        </div>
      </div>
    </template>

    <el-descriptions :column="3" border class="head">
      <el-descriptions-item label="调出仓库">{{ order?.from_warehouse_name }}</el-descriptions-item>
      <el-descriptions-item label="调入仓库">{{ order?.to_warehouse_name }}</el-descriptions-item>
      <el-descriptions-item label="调拨日期">{{ order?.order_date }}</el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag v-if="order" :type="STATUS_TAG[order.status]">
          {{ TRANSFER_ORDER_STATUS_LABELS[order.status] }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="备注" :span="2">{{ order?.remark || '—' }}</el-descriptions-item>
    </el-descriptions>

    <el-table :data="items" border class="block">
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="product_code" label="物料编码" width="150" />
      <el-table-column prop="product_name" label="物料描述" min-width="200" show-overflow-tooltip />
      <el-table-column prop="base_unit" label="单位" width="80" />
      <el-table-column label="调拨数量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="已发货" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.shipped_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="已收货" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.received_qty, row.qty_precision) }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { PERMISSIONS, TRANSFER_ORDER_STATUS_LABELS, type TransferOrderStatus } from '@light-erp/shared';
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
  from_warehouse_id: number;
  from_warehouse_name: string;
  to_warehouse_id: number;
  to_warehouse_name: string;
  order_date: string;
  status: TransferOrderStatus;
  remark: string | null;
}

interface OrderItem {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  quantity: number;
  shipped_qty: number;
  received_qty: number;
}

const STATUS_TAG: Record<TransferOrderStatus, 'info' | 'primary' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  confirmed: 'primary',
  shipped: 'warning',
  received: 'success',
  cancelled: 'danger',
};

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.inventoryTransferManage));

const loading = ref(false);
const order = ref<OrderHeader | null>(null);
const items = ref<OrderItem[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<{ order: OrderHeader; items: OrderItem[] }>(
      `/api/inventory/transfers/${route.params.id}`,
    );
    order.value = data.order;
    items.value = data.items;
  } finally {
    loading.value = false;
  }
}

const goBack = () => void router.push({ name: 'transfers' });

async function confirm(): Promise<void> {
  if (!(await confirmAction('确认后单据进入已确认状态，可执行发货。', '确认调拨单'))) return;
  await http.post(`/api/inventory/transfers/${route.params.id}/confirm`);
  ElMessage.success('已确认');
  await load();
}

async function cancel(): Promise<void> {
  if (!(await confirmAction('取消后单据作废且不可恢复。', '取消调拨单'))) return;
  await http.post(`/api/inventory/transfers/${route.params.id}/cancel`);
  ElMessage.success('已取消');
  await load();
}

async function ship(): Promise<void> {
  if (!(await confirmAction('发货将按整单数量从调出仓库扣减库存，货物进入在途。', '确认发货'))) return;
  await http.post(`/api/inventory/transfers/${route.params.id}/ship`);
  ElMessage.success('已发货，货物在途');
  await load();
}

async function receive(): Promise<void> {
  if (!(await confirmAction('收货将按整单数量入库到调入仓库，并按调出仓库当前平均成本结转。', '确认收货'))) return;
  await http.post(`/api/inventory/transfers/${route.params.id}/receive`);
  ElMessage.success('已收货');
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
</style>