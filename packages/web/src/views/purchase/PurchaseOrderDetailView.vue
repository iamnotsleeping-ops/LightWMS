<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>采购单详情 {{ order?.order_no }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button v-if="canConfirm && order?.status === 'draft'" type="success" @click="confirm">
            确认
          </el-button>
          <el-button
            v-if="canConfirm && (order?.status === 'draft' || order?.status === 'confirmed')"
            type="warning"
            @click="cancel"
          >
            取消
          </el-button>
          <el-button
            v-if="canInbound && (order?.status === 'confirmed' || order?.status === 'partial')"
            type="primary"
            @click="goInbound"
          >
            入库
          </el-button>
          <el-button v-if="canInbound && canReturn" type="danger" plain @click="openReturn">
            采购退货
          </el-button>
        </div>
      </div>
    </template>

    <el-descriptions :column="3" border class="head">
      <el-descriptions-item label="供应商">{{ order?.supplier_name }}</el-descriptions-item>
      <el-descriptions-item label="下单日期">{{ order?.order_date }}</el-descriptions-item>
      <el-descriptions-item label="状态">
        <el-tag v-if="order" :type="STATUS_TAG[order.status]">
          {{ PURCHASE_ORDER_STATUS_LABELS[order.status] }}
        </el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="总金额">{{ formatAmount(order?.total_amount ?? 0) }}</el-descriptions-item>
      <el-descriptions-item label="备注" :span="2">{{ order?.remark || '—' }}</el-descriptions-item>
    </el-descriptions>

    <el-table :data="items" border class="block">
      <el-table-column type="index" label="#" width="50" />
      <el-table-column prop="product_code" label="物料编码" width="150" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="140" show-overflow-tooltip />
      <el-table-column label="数量" width="100" align="right">
        <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="单价" width="120" align="right">
        <template #default="{ row }">{{ formatAmount(row.unit_price) }}</template>
      </el-table-column>
      <el-table-column label="金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="已入库" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.received_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="在途" width="110" align="right">
        <template #default="{ row }">
          <span :class="{ transit: row.in_transit > 0 }">
            {{ formatQty(row.in_transit, row.qty_precision) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column prop="promised_date" label="承诺到货日" width="130" />
    </el-table>

    <div class="section-title">退货记录</div>
    <el-table :data="returns" border>
      <el-table-column type="expand">
        <template #default="{ row }">
          <el-table :data="row.lines" size="small" border class="inner">
            <el-table-column prop="product_code" label="物料编码" width="150" />
            <el-table-column prop="product_name" label="物料描述" min-width="180" />
            <el-table-column prop="warehouse_name" label="仓库" width="140" />
            <el-table-column label="退货数量" width="110" align="right">
              <template #default="scope">{{ formatQty(scope.row.quantity, scope.row.qty_precision) }}</template>
            </el-table-column>
            <el-table-column label="结转成本" width="130" align="right">
              <template #default="scope">{{ formatAmount(scope.row.unit_cost) }}</template>
            </el-table-column>
            <el-table-column label="金额" width="130" align="right">
              <template #default="scope">{{ formatAmount(scope.row.amount) }}</template>
            </el-table-column>
          </el-table>
        </template>
      </el-table-column>
      <el-table-column prop="return_no" label="退货单号" width="180" />
      <el-table-column prop="return_date" label="退货日期" width="130" />
      <el-table-column label="退货数量" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.total_qty, 0) }}</template>
      </el-table-column>
      <el-table-column label="金额" width="140" align="right">
        <template #default="{ row }">{{ formatAmount(row.total_amount) }}</template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="160" show-overflow-tooltip />
    </el-table>

    <el-dialog v-model="returnVisible" title="采购退货" width="640px">
      <el-alert
        type="info"
        show-icon
        :closable="false"
        title="退货将按当前移动加权平均成本从源仓库可用库存出库；质检中未放行的货物不可退。"
        class="tip"
      />
      <el-form :model="returnForm" label-width="90px">
        <el-form-item label="退货日期" required>
          <el-date-picker v-model="returnForm.returnDate" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="returnForm.remark" maxlength="500" />
        </el-form-item>
      </el-form>
      <el-table :data="returnRows" border max-height="320">
        <el-table-column prop="product_name" label="物料" min-width="160" show-overflow-tooltip />
        <el-table-column prop="warehouse_name" label="仓库" width="130" show-overflow-tooltip />
        <el-table-column label="已入库" width="100" align="right">
          <template #default="{ row }">{{ formatQty(row.received_qty, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="可退量" width="100" align="right">
          <template #default="{ row }">{{ formatQty(row.returnable, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="本次退货" width="140">
          <template #default="{ row }">
            <el-input-number v-model="row.quantity" :min="0" :max="row.returnable" :precision="0" :controls="false" class="full" />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="returnVisible = false">取消</el-button>
        <el-button type="primary" :loading="returning" @click="submitReturn">提交退货</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { PERMISSIONS, PURCHASE_ORDER_STATUS_LABELS, type PurchaseOrderStatus } from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatAmount, formatQty } from '@/utils/format';

interface OrderHeader {
  id: number;
  order_no: string;
  supplier_name: string;
  order_date: string;
  status: PurchaseOrderStatus;
  total_amount: number;
  remark: string | null;
}

interface OrderItem {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_name: string;
  quantity: number;
  unit_price: number;
  amount: number;
  received_qty: number;
  in_transit: number;
  promised_date: string;
}

interface ReturnLine {
  order_item_id: number;
  quantity: number;
  qty_precision: number;
  product_code: string;
  product_name: string;
  warehouse_name: string;
  unit_cost: number;
  amount: number;
}

interface OrderReturn {
  id: number;
  return_no: string;
  return_date: string;
  total_amount: number;
  total_qty: number;
  remark: string | null;
  lines: ReturnLine[];
}

const STATUS_TAG: Record<PurchaseOrderStatus, 'info' | 'primary' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  confirmed: 'primary',
  partial: 'warning',
  received: 'success',
  cancelled: 'danger',
};

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const canConfirm = computed(() => auth.has(PERMISSIONS.purchaseOrderConfirm));
const canInbound = computed(() => auth.has(PERMISSIONS.purchaseInboundManage));

const loading = ref(false);
const order = ref<OrderHeader | null>(null);
const items = ref<OrderItem[]>([]);
const returns = ref<OrderReturn[]>([]);

const canReturn = computed(
  () => Boolean(order.value) && ['confirmed', 'partial', 'received'].includes(order.value?.status ?? ''),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<{ order: OrderHeader; items: OrderItem[]; returns: OrderReturn[] }>(
      `/api/purchase/orders/${route.params.id}`,
    );
    order.value = data.order;
    items.value = data.items;
    returns.value = data.returns;
  } finally {
    loading.value = false;
  }
}

const goBack = () => void router.push({ name: 'purchase-orders' });
const goInbound = () =>
  void router.push({ name: 'purchase-inbound', query: { orderId: String(route.params.id) } });

async function confirm(): Promise<void> {
  await ElMessageBox.confirm('确认该采购单？确认后表体不可修改，其数量将计入采购在途。', '确认采购单', {
    type: 'warning',
  });
  await http.post(`/api/purchase/orders/${route.params.id}/confirm`);
  ElMessage.success('已确认');
  await load();
}

async function cancel(): Promise<void> {
  await ElMessageBox.confirm('取消该采购单？取消后其数量将从采购在途统计中移除。', '取消采购单', {
    type: 'warning',
  });
  await http.post(`/api/purchase/orders/${route.params.id}/cancel`);
  ElMessage.success('已取消');
  await load();
}

// ---------- 采购退货 ----------
const returnVisible = ref(false);
const returning = ref(false);
const returnForm = reactive({ returnDate: new Date().toISOString().slice(0, 10), remark: '' });
const returnRows = ref<(OrderItem & { returnable: number })[]>([]);

function openReturn(): void {
  const returnedByItem = new Map<number, number>();
  for (const row of returns.value) {
    for (const line of row.lines) {
      returnedByItem.set(line.order_item_id, (returnedByItem.get(line.order_item_id) ?? 0) + line.quantity);
    }
  }
  returnRows.value = items.value
    .map((item) => ({ ...item, returnable: item.received_qty - (returnedByItem.get(item.id) ?? 0), quantity: 0 }))
    .filter((row) => row.returnable > 0);
  if (returnRows.value.length === 0) {
    ElMessage.warning('当前没有可退货物');
    return;
  }
  returnForm.returnDate = new Date().toISOString().slice(0, 10);
  returnForm.remark = '';
  returnVisible.value = true;
}

async function submitReturn(): Promise<void> {
  const lines = returnRows.value
    .filter((row) => row.quantity > 0)
    .map((row) => ({ orderItemId: row.id, quantity: row.quantity }));
  if (lines.length === 0) {
    ElMessage.warning('请填写退货数量');
    return;
  }
  returning.value = true;
  try {
    await http.post('/api/purchase/returns', {
      orderId: Number(route.params.id),
      returnDate: returnForm.returnDate,
      remark: returnForm.remark,
      lines,
    });
    ElMessage.success('退货已过账');
    returnVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    returning.value = false;
  }
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
  margin-bottom: 8px;
}

.section-title {
  margin: 12px 0;
  font-weight: 600;
}

.transit {
  color: var(--el-color-warning);
  font-weight: 600;
}

.inner {
  margin: 8px 0;
}

.tip {
  margin-bottom: 12px;
}

.full {
  width: 100%;
}
</style>