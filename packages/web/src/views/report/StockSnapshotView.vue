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
        v-model="asOf"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="时点（留空=当前）"
        clearable
        class="date"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button type="primary" plain :loading="exporting" @click="exportCsv">导出 CSV</el-button>
    </div>

    <el-alert
      v-if="warnings.length > 0"
      class="warn"
      type="warning"
      :closable="false"
      show-icon
      :title="warnings.join('；')"
    />

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="140" fixed="left" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="150" show-overflow-tooltip />
      <el-table-column prop="base_unit" label="单位" width="80" />
      <el-table-column label="现存量" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.on_hand, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="冻结量" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.frozen, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="待检量" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.qc, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="占用（销售）" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.reserved, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="在途" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.in_transit, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="可用量" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.available, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="预计可用" width="110" align="right">
        <template #default="{ row }">{{ formatQty(row.projected, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="平均成本" width="120" align="right">
        <template #default="{ row }">{{ formatAmount(row.avg_cost) }}</template>
      </el-table-column>
      <el-table-column label="库存金额" width="130" align="right">
        <!-- 按流水累计的结存金额（含冻结/待检三桶），与「进销存明细账」期末金额同口径 -->
        <template #default="{ row }">{{ formatAmount(row.stock_amount) }}</template>
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

interface SnapshotRow {
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_code: string;
  warehouse_name: string;
  on_hand: number;
  frozen: number;
  qc: number;
  reserved: number | null;
  in_transit: number | null;
  available: number | null;
  projected: number | null;
  avg_cost: number | null;
  /** 按流水累计的结存金额（分），口径同明细账期末金额 */
  stock_amount: number;
}

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

const PATH = '/api/reports/stock-snapshot';

const rows = ref<SnapshotRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const asOf = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function query(): Record<string, unknown> {
  return {
    keyword: keyword.value || undefined,
    warehouseId: warehouseId.value,
    asOf: asOf.value,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<SnapshotRow[]>(PATH, { ...query(), page: page.value, pageSize });
    rows.value = res.data;
    total.value = res.page?.total ?? 0;
    warnings.value = res._warnings.map((item) => String(item));
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
  width: 180px;
}

.warn {
  margin-bottom: 12px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>