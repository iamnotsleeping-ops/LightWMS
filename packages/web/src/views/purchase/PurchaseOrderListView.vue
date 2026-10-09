<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-radio-group v-model="group" @change="reload">
        <el-radio-button v-for="item in GROUPS" :key="item.value" :value="item.value">
          {{ item.label }}
        </el-radio-button>
      </el-radio-group>
      <span class="spacer" />
      <el-input
        v-model="keyword"
        placeholder="搜索单号 / 供应商"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select v-model="supplierId" class="supplier" placeholder="供应商" clearable @change="reload">
        <el-option
          v-for="item in suppliers"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-date-picker
        v-model="range"
        class="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="下单起"
        end-placeholder="下单止"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="goCreate">新建采购单</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="order_no" label="采购单号" width="180">
        <template #default="{ row }">
          <el-link type="primary" @click="goDetail(row.id)">{{ row.order_no }}</el-link>
        </template>
      </el-table-column>
      <el-table-column prop="supplier_name" label="供应商" min-width="160" show-overflow-tooltip />
      <el-table-column prop="order_date" label="下单日期" width="120" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG[row.status as PurchaseOrderStatus]">
            {{ PURCHASE_ORDER_STATUS_LABELS[row.status as PurchaseOrderStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="执行进度（已入库 / 总量）" width="200">
        <template #default="{ row }">
          {{ formatQty(row.received_qty, 0) }} / {{ formatQty(row.total_qty, 0) }}
          <el-tag v-if="row.in_transit > 0" size="small" type="warning" class="transit">
            在途 {{ formatQty(row.in_transit, 0) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="140" align="right">
        <template #default="{ row }">{{ formatAmount(row.total_amount) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(row.id)">查看</el-button>
          <el-button
            v-if="canManage && row.status === 'draft'"
            link
            type="primary"
            @click="goEdit(row.id)"
          >
            编辑
          </el-button>
          <el-button
            v-if="canConfirm && row.status === 'draft'"
            link
            type="success"
            @click="confirm(row)"
          >
            确认
          </el-button>
          <el-button
            v-if="canConfirm && (row.status === 'draft' || row.status === 'confirmed')"
            link
            type="warning"
            @click="cancel(row)"
          >
            取消
          </el-button>
          <el-button v-if="canManage && row.status === 'draft'" link type="danger" @click="remove(row)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      v-model:current-page="page"
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      @current-change="load"
    />
  </el-card>
</template>

<script setup lang="ts">
import { PERMISSIONS, PURCHASE_ORDER_STATUS_LABELS, type PurchaseOrderStatus } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { confirmAction } from '@/utils/confirm';
import { formatAmount, formatQty } from '@/utils/format';

interface OrderRow {
  id: number;
  order_no: string;
  supplier_id: number;
  supplier_name: string;
  order_date: string;
  status: PurchaseOrderStatus;
  total_amount: number;
  total_qty: number;
  received_qty: number;
  in_transit: number;
}

interface Option {
  id: number;
  code: string;
  name: string;
}

const STATUS_TAG: Record<PurchaseOrderStatus, 'info' | 'primary' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  confirmed: 'primary',
  partial: 'warning',
  received: 'success',
  cancelled: 'danger',
};

const GROUPS = [
  { label: '全部', value: 'all', status: undefined },
  { label: '草稿', value: 'draft', status: 'draft' },
  { label: '待执行', value: 'pending', status: 'confirmed,partial' },
  { label: '已完成', value: 'received', status: 'received' },
  { label: '已取消', value: 'cancelled', status: 'cancelled' },
] as const;

const router = useRouter();
const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.purchaseOrderManage));
const canConfirm = computed(() => auth.has(PERMISSIONS.purchaseOrderConfirm));

const rows = ref<OrderRow[]>([]);
const suppliers = ref<Option[]>([]);
const loading = ref(false);
const group = ref<string>('all');
const keyword = ref('');
const supplierId = ref<number | undefined>(undefined);
const range = ref<[string, string] | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const activeStatus = (): string | undefined =>
  GROUPS.find((item) => item.value === group.value)?.status;

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<OrderRow[]>('/api/purchase/orders', {
      keyword: keyword.value,
      supplierId: supplierId.value,
      status: activeStatus(),
      dateFrom: range.value?.[0],
      dateTo: range.value?.[1],
      page: page.value,
      pageSize,
    });
    rows.value = data;
    total.value = info?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  page.value = 1;
  void load();
}

const goCreate = () => void router.push({ name: 'purchase-order-new' });
const goEdit = (id: number) => void router.push({ name: 'purchase-order-edit', params: { id } });
const goDetail = (id: number) => void router.push({ name: 'purchase-order-detail', params: { id } });

async function confirm(row: OrderRow): Promise<void> {
  if (!(await confirmAction(`确认采购单「${row.order_no}」？确认后表体不可修改，其数量将计入采购在途。`, '确认采购单'))) return;
  await http.post(`/api/purchase/orders/${row.id}/confirm`);
  ElMessage.success('已确认');
  await load();
}

async function cancel(row: OrderRow): Promise<void> {
  if (!(await confirmAction(`取消采购单「${row.order_no}」？取消后其数量将从采购在途统计中移除。`, '取消采购单'))) return;
  await http.post(`/api/purchase/orders/${row.id}/cancel`);
  ElMessage.success('已取消');
  await load();
}

async function remove(row: OrderRow): Promise<void> {
  if (!(await confirmAction(`删除草稿采购单「${row.order_no}」？其表体将一并删除。`, '删除确认'))) return;
  await http.del(`/api/purchase/orders/${row.id}`);
  ElMessage.success('已删除');
  await load();
}

onMounted(async () => {
  const { data } = await http.get<Option[]>('/api/masterdata/partners', { type: 'supplier', pageSize: 200 });
  suppliers.value = data;
  await load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.spacer {
  flex: 1;
}

.search {
  width: 190px;
}

.supplier {
  width: 190px;
}

.range {
  width: 260px;
}

.transit {
  margin-left: 6px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>