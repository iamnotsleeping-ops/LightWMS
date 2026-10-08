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
      <el-select v-model="warehouseId" class="warehouse" placeholder="仓库" clearable @change="reload">
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
        start-placeholder="盘点起"
        end-placeholder="盘点止"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="goCreate">新建盘点单</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="order_no" label="盘点单号" width="180">
        <template #default="{ row }">
          <el-link type="primary" @click="goDetail(row.id)">{{ row.order_no }}</el-link>
        </template>
      </el-table-column>
      <el-table-column prop="warehouse_name" label="仓库" min-width="160" show-overflow-tooltip />
      <el-table-column prop="order_date" label="盘点日期" width="120" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG[row.status as StocktakeOrderStatus]">
            {{ STOCKTAKE_ORDER_STATUS_LABELS[row.status as StocktakeOrderStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="差异行 / 总行" width="140">
        <template #default="{ row }">
          <span :class="{ diff: row.diff_lines > 0 }">{{ row.diff_lines }} / {{ row.total_lines }}</span>
        </template>
      </el-table-column>
      <el-table-column label="过账时间" width="180">
        <template #default="{ row }">{{ row.posted_at ? readTime(row.posted_at) : '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(row.id)">查看</el-button>
          <el-button v-if="canManage && row.status === 'draft'" link type="primary" @click="goEdit(row.id)">
            编辑
          </el-button>
          <el-button v-if="canManage && row.status === 'draft'" link type="success" @click="remove(row)">
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
import { STOCKTAKE_ORDER_STATUS_LABELS, type StocktakeOrderStatus } from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

interface StocktakeRow {
  id: number;
  order_no: string;
  warehouse_name: string;
  order_date: string;
  status: StocktakeOrderStatus;
  posted_at: string | null;
  total_lines: number;
  diff_lines: number;
}

const STATUS_TAG: Record<StocktakeOrderStatus, 'info' | 'success' | 'danger'> = {
  draft: 'info',
  posted: 'success',
  cancelled: 'danger',
};

const GROUPS = [
  { label: '全部', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已过账', value: 'posted' },
  { label: '已取消', value: 'cancelled' },
];

const router = useRouter();
const auth = useAuthStore();
const canManage = computed(() => auth.has('inventory.stocktake.manage'));

const rows = ref<StocktakeRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const loading = ref(false);
const status = ref('');
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const range = ref<[string, string] | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<StocktakeRow[]>('/api/inventory/stocktakes', {
      page: page.value,
      pageSize,
      status: status.value || undefined,
      keyword: keyword.value || undefined,
      warehouseId: warehouseId.value,
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

const goCreate = () => void router.push({ name: 'stocktake-new' });
const goEdit = (id: number) => void router.push({ name: 'stocktake-edit', params: { id } });
const goDetail = (id: number) => void router.push({ name: 'stocktake-detail', params: { id } });

async function remove(row: StocktakeRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除盘点单 ${row.order_no}？`, '删除盘点单', { type: 'warning' });
  } catch {
    return;
  }
  await http.del(`/api/inventory/stocktakes/${row.id}`);
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

.diff {
  color: #e6a23c;
  font-weight: 600;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>