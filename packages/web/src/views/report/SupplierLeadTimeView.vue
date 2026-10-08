<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索供应商编码 / 名称"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-date-picker
        v-model="dateFrom"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="下单起始日期"
        clearable
        class="date"
        @change="reload"
      />
      <span class="tilde">~</span>
      <el-date-picker
        v-model="dateTo"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="下单截止日期"
        clearable
        class="date"
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button type="primary" plain :loading="exporting" @click="exportCsv">导出 CSV</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="supplier_code" label="供应商编码" width="140" fixed="left" />
      <el-table-column prop="supplier_name" label="供应商名称" min-width="180" show-overflow-tooltip />
      <el-table-column label="订单数" width="100" align="right">
        <template #default="{ row }">{{ row.order_count }}</template>
      </el-table-column>
      <el-table-column label="订单行数" width="110" align="right">
        <template #default="{ row }">{{ row.line_count }}</template>
      </el-table-column>
      <el-table-column label="已到货行数" width="120" align="right">
        <template #default="{ row }">{{ row.received_line_count }}</template>
      </el-table-column>
      <el-table-column label="平均提前期（天）" width="150" align="right">
        <template #default="{ row }">{{ formatDays(row.avg_lead_time_days) }}</template>
      </el-table-column>
      <el-table-column label="最短（天）" width="110" align="right">
        <template #default="{ row }">{{ formatDays(row.min_lead_time_days) }}</template>
      </el-table-column>
      <el-table-column label="最长（天）" width="110" align="right">
        <template #default="{ row }">{{ formatDays(row.max_lead_time_days) }}</template>
      </el-table-column>
      <el-table-column label="承诺提前期（天）" width="150" align="right">
        <template #default="{ row }">{{ formatDays(row.avg_promised_lead_time_days) }}</template>
      </el-table-column>
      <el-table-column label="准时率" width="120" align="right">
        <template #default="{ row }">{{ formatRate(row.on_time_rate) }}</template>
      </el-table-column>
      <el-table-column label="最近下单日" width="130">
        <template #default="{ row }">{{ row.last_order_date ?? '—' }}</template>
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

interface LeadTimeRow {
  supplier_code: string;
  supplier_name: string;
  order_count: number;
  line_count: number;
  received_line_count: number;
  avg_lead_time_days: number | null;
  min_lead_time_days: number | null;
  max_lead_time_days: number | null;
  avg_promised_lead_time_days: number | null;
  on_time_rate: number | null;
  last_order_date: string | null;
}

const PATH = '/api/reports/supplier-lead-time';

const rows = ref<LeadTimeRow[]>([]);
const loading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const dateFrom = ref<string | undefined>(undefined);
const dateTo = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function formatDays(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function query(): Record<string, unknown> {
  return {
    keyword: keyword.value || undefined,
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<LeadTimeRow[]>(PATH, { ...query(), page: page.value, pageSize });
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

onMounted(load);
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
  width: 220px;
}

.date {
  width: 170px;
}

.tilde {
  color: #909399;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>