<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button v-for="item in GROUPS" :key="item.value" :value="item.value">
          {{ item.label }}
        </el-radio-button>
      </el-radio-group>
      <span class="spacer" />
      <el-input
        v-model="keyword"
        placeholder="搜索单号 / 仓库"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select
        v-model="fromWarehouseId"
        class="warehouse"
        placeholder="调出仓库"
        clearable
        @change="reload"
      >
        <el-option
          v-for="item in warehouses"
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
        start-placeholder="调拨起"
        end-placeholder="调拨止"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="goCreate">新建调拨单</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="order_no" label="调拨单号" width="180">
        <template #default="{ row }">
          <el-link type="primary" @click="goDetail(row.id)">{{ row.order_no }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="调出 → 调入" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.from_warehouse_name }} → {{ row.to_warehouse_name }}
        </template>
      </el-table-column>
      <el-table-column prop="order_date" label="调拨日期" width="120" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG[row.status as TransferOrderStatus]">
            {{ TRANSFER_ORDER_STATUS_LABELS[row.status as TransferOrderStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="执行进度（发货 / 收货 / 总量）" width="260">
        <template #default="{ row }">
          {{ formatQty(row.shipped_qty, 0) }} / {{ formatQty(row.received_qty, 0) }} /
          {{ formatQty(row.total_qty, 0) }}
          <el-tag v-if="row.unshipped > 0" size="small" type="warning" class="transit">
            待发货 {{ formatQty(row.unshipped, 0) }}
          </el-tag>
          <el-tag v-else-if="row.unreceived > 0" size="small" type="warning" class="transit">
            在途 {{ formatQty(row.unreceived, 0) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(row.id)">查看</el-button>
          <el-button v-if="canManage && row.status === 'draft'" link type="primary" @click="goEdit(row.id)">
            编辑
          </el-button>
          <el-button v-if="canManage && row.status === 'draft'" link type="success" @click="confirm(row)">
            确认
          </el-button>
          <el-button
            v-if="canManage && (row.status === 'draft' || row.status === 'confirmed')"
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
import { PERMISSIONS, TRANSFER_ORDER_STATUS_LABELS, type TransferOrderStatus } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { confirmAction } from '@/utils/confirm';
import { formatQty } from '@/utils/format';

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

interface TransferRow {
  id: number;
  order_no: string;
  from_warehouse_name: string;
  to_warehouse_name: string;
  order_date: string;
  status: TransferOrderStatus;
  remark: string | null;
  total_qty: number;
  shipped_qty: number;
  received_qty: number;
  unshipped: number;
  unreceived: number;
}

const STATUS_TAG: Record<TransferOrderStatus, 'info' | 'primary' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  confirmed: 'primary',
  shipped: 'warning',
  received: 'success',
  cancelled: 'danger',
};

const GROUPS = [
  { label: '全部', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已确认', value: 'confirmed' },
  { label: '在途', value: 'shipped' },
  { label: '已收货', value: 'received' },
  { label: '已取消', value: 'cancelled' },
];

const router = useRouter();
const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.inventoryTransferManage));

const rows = ref<TransferRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const loading = ref(false);
const status = ref('');
const keyword = ref('');
const fromWarehouseId = ref<number | undefined>(undefined);
const range = ref<[string, string] | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<TransferRow[]>('/api/inventory/transfers', {
      page: page.value,
      pageSize,
      status: status.value || undefined,
      keyword: keyword.value || undefined,
      fromWarehouseId: fromWarehouseId.value,
      dateFrom: range.value?.[0],
      dateTo: range.value?.[1],
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

const goCreate = () => void router.push({ name: 'transfer-new' });
const goEdit = (id: number) => void router.push({ name: 'transfer-edit', params: { id } });
const goDetail = (id: number) => void router.push({ name: 'transfer-detail', params: { id } });

async function confirm(row: TransferRow): Promise<void> {
  if (!(await confirmAction(`确认调拨单 ${row.order_no}？`, '确认调拨单'))) return;
  await http.post(`/api/inventory/transfers/${row.id}/confirm`);
  ElMessage.success('已确认');
  await load();
}

async function cancel(row: TransferRow): Promise<void> {
  if (!(await confirmAction(`取消调拨单 ${row.order_no}？`, '取消调拨单'))) return;
  await http.post(`/api/inventory/transfers/${row.id}/cancel`);
  ElMessage.success('已取消');
  await load();
}

async function remove(row: TransferRow): Promise<void> {
  if (!(await confirmAction(`删除调拨单 ${row.order_no}？`, '删除调拨单'))) return;
  await http.del(`/api/inventory/transfers/${row.id}`);
  ElMessage.success('已删除');
  await load();
}

onMounted(async () => {
  const { data } = await http.get<OptionRow[]>('/api/masterdata/warehouses', { pageSize: 200 });
  warehouses.value = data;
  await load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.search {
  width: 180px;
}

.warehouse {
  width: 180px;
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