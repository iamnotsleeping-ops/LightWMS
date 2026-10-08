<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索物料编码 / 名称"
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
        v-model="dateFrom"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="起始日期"
        clearable
        class="date"
        @change="reload"
      />
      <span class="tilde">~</span>
      <el-date-picker
        v-model="dateTo"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="截止日期"
        clearable
        class="date"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button type="primary" plain :loading="exporting" @click="exportCsv">导出 CSV</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="140" fixed="left" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column label="仓库" width="150" show-overflow-tooltip>
        <template #default="{ row }">{{ row.warehouse_name }}</template>
      </el-table-column>
      <el-table-column label="单位" width="80">
        <template #default="{ row }">{{ row.base_unit }}</template>
      </el-table-column>
      <el-table-column label="期初数量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.opening_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="入库数量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.in_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="出库数量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.out_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="期末数量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.closing_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="期初金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.opening_amount) }}</template>
      </el-table-column>
      <el-table-column label="入库金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.in_amount) }}</template>
      </el-table-column>
      <el-table-column label="出库金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.out_amount) }}</template>
      </el-table-column>
      <el-table-column label="期末金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.closing_amount) }}</template>
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
import { onMounted, ref } from 'vue';
import { download, http } from '@/api/client';
import { formatAmount, formatQty } from '@/utils/format';

interface LedgerRow {
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_code: string;
  warehouse_name: string;
  opening_qty: number;
  in_qty: number;
  out_qty: number;
  closing_qty: number;
  opening_amount: number;
  in_amount: number;
  out_amount: number;
  closing_amount: number;
}

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

const PATH = '/api/reports/inventory-ledger';

const rows = ref<LedgerRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const loading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const dateFrom = ref<string | undefined>(undefined);
const dateTo = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function query(): Record<string, unknown> {
  return {
    keyword: keyword.value || undefined,
    warehouseId: warehouseId.value,
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<LedgerRow[]>(PATH, {
      ...query(),
      page: page.value,
      pageSize,
    });
    rows.value = res.data;
    total.value = res.page?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  page.value = 1;
  void load();
}

async function exportCsv(): Promise<void> {
  exporting.value = true;
  try {
    await download(PATH, { ...query(), format: 'csv' });
  } finally {
    exporting.value = false;
  }
}

onMounted(async () => {
  const warehouseRes = await http.get<OptionRow[]>('/api/masterdata/warehouses', { pageSize: 200 });
  warehouses.value = warehouseRes.data;
  await load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 200px;
}

.warehouse {
  width: 180px;
}

.date {
  width: 160px;
}

.tilde {
  color: #909399;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>