<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索替代料编码 / 名称"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
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
      <el-checkbox v-model="onlyIdle" @change="reload">只看呆滞</el-checkbox>
      <el-button @click="reload">查询</el-button>
      <el-button type="primary" plain :loading="exporting" @click="exportCsv">导出 CSV</el-button>
    </div>

    <el-alert
      v-for="(warning, index) in warnings"
      :key="index"
      class="warn"
      type="warning"
      :closable="false"
      show-icon
      :title="warning"
    />

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="item_code" label="替代料编码" width="160" fixed="left" />
      <el-table-column prop="item_name" label="替代料名称" min-width="200" show-overflow-tooltip />
      <el-table-column prop="base_unit" label="单位" width="80" />
      <el-table-column label="替代次数" width="110" align="right">
        <template #default="{ row }">{{ row.substitution_count }}</template>
      </el-table-column>
      <el-table-column label="替代用量合计" width="140" align="right">
        <template #default="{ row }">{{ formatQty(row.total_sub_qty, 0) }}</template>
      </el-table-column>
      <el-table-column label="最近一次使用" width="190">
        <template #default="{ row }">
          <span v-if="row.last_used_at">{{ readTime(row.last_used_at) }}</span>
          <span v-else class="never">从未使用</span>
        </template>
      </el-table-column>
      <el-table-column label="距今天数" width="110" align="right">
        <template #default="{ row }">
          <span v-if="row.idle_days === null">—</span>
          <span v-else>{{ row.idle_days }} 天</span>
        </template>
      </el-table-column>
      <el-table-column label="呆滞" width="90">
        <template #default="{ row }">
          <el-tag :type="row.is_idle ? 'warning' : 'success'">
            {{ row.is_idle ? '呆滞' : '正常' }}
          </el-tag>
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
import { onMounted, ref } from 'vue';
import { download, http } from '@/api/client';
import { formatQty } from '@/utils/format';

interface SubstituteUsageRow {
  item_code: string;
  item_name: string;
  base_unit: string;
  substitution_count: number;
  total_sub_qty: number;
  last_used_at: string | null;
  idle_days: number | null;
  is_idle: 0 | 1;
}

const PATH = '/api/reports/substitute-usage';

const rows = ref<SubstituteUsageRow[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const exporting = ref(false);
const keyword = ref('');
const dateFrom = ref<string | undefined>(undefined);
const dateTo = ref<string | undefined>(undefined);
const onlyIdle = ref(false);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function query(): Record<string, unknown> {
  return {
    keyword: keyword.value || undefined,
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
    onlyIdle: onlyIdle.value ? 1 : undefined,
  };
}

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<SubstituteUsageRow[]>(PATH, {
      ...query(),
      page: page.value,
      pageSize,
    });
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
  width: 160px;
}

.tilde {
  color: var(--el-text-color-secondary);
}

.warn {
  margin-bottom: 8px;
}

.never {
  color: var(--el-color-warning);
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
