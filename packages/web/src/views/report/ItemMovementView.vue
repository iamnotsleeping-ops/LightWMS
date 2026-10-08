<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select
        v-model="productId"
        class="product"
        placeholder="物料"
        filterable
        clearable
        @change="reload"
      >
        <el-option
          v-for="item in products"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-select v-model="warehouseId" class="warehouse" placeholder="仓库" clearable @change="reload">
        <el-option
          v-for="item in warehouses"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-select v-model="stockStatus" class="status" placeholder="库存状态" clearable @change="reload">
        <el-option
          v-for="item in STOCK_STATUSES"
          :key="item"
          :label="STOCK_STATUS_LABELS[item]"
          :value="item"
        />
      </el-select>
      <el-select v-model="bizType" class="biz" placeholder="业务类型" clearable @change="reload">
        <el-option v-for="item in BIZ_TYPES" :key="item" :label="bizLabel(item)" :value="item" />
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
      <el-table-column label="时间" width="170" fixed="left">
        <template #default="{ row }">{{ readTime(row.occurred_at) }}</template>
      </el-table-column>
      <el-table-column prop="product_code" label="物料编码" width="140" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="150" show-overflow-tooltip />
      <el-table-column label="库存状态" width="110">
        <template #default="{ row }">{{ statusLabel(row.stock_status) }}</template>
      </el-table-column>
      <el-table-column label="业务类型" width="120">
        <template #default="{ row }">{{ bizLabel(row.biz_type) }}</template>
      </el-table-column>
      <el-table-column label="方向" width="90">
        <template #default="{ row }">
          <el-tag :type="row.direction === 1 ? 'success' : 'danger'" size="small">
            {{ row.direction === 1 ? '入库' : '出库' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="数量" width="130" align="right">
        <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column prop="base_unit" label="单位" width="80" />
      <el-table-column label="单位成本" width="120" align="right">
        <template #default="{ row }">{{ formatAmount(row.unit_cost) }}</template>
      </el-table-column>
      <el-table-column label="金额" width="130" align="right">
        <template #default="{ row }">{{ formatAmount(row.amount) }}</template>
      </el-table-column>
      <el-table-column label="关联单据" width="170" show-overflow-tooltip>
        <template #default="{ row }">{{ row.biz_no ?? '—' }}</template>
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
import { BIZ_TYPES, STOCK_STATUSES, STOCK_STATUS_LABELS } from '@light-erp/shared';
import { onMounted, ref } from 'vue';
import { download, http } from '@/api/client';
import { formatAmount, formatQty } from '@/utils/format';

interface MovementRow {
  id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_name: string;
  stock_status: string;
  biz_type: string;
  biz_no: string | null;
  direction: number;
  quantity: number;
  unit_cost: number;
  amount: number;
  occurred_at: string;
}

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

const BIZ_TYPE_LABELS: Record<string, string> = {
  purchase_in: '采购入库',
  sale_out: '销售出库',
  purchase_return: '采购退货',
  sale_return: '销售退货',
  transfer_out: '调拨出库',
  transfer_in: '调拨入库',
  adjust: '盘点调整',
  status_change: '状态转移',
};

function bizLabel(value: unknown): string {
  return BIZ_TYPE_LABELS[String(value)] ?? String(value);
}

function statusLabel(value: unknown): string {
  return STOCK_STATUS_LABELS[value as keyof typeof STOCK_STATUS_LABELS] ?? String(value);
}

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

const PATH = '/api/reports/item-movement';

const rows = ref<MovementRow[]>([]);
const products = ref<OptionRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const loading = ref(false);
const exporting = ref(false);
const productId = ref<number | undefined>(undefined);
const warehouseId = ref<number | undefined>(undefined);
const stockStatus = ref<string | undefined>(undefined);
const bizType = ref<string | undefined>(undefined);
const dateFrom = ref<string | undefined>(undefined);
const dateTo = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

function query(): Record<string, unknown> {
  return {
    productId: productId.value,
    warehouseId: warehouseId.value,
    stockStatus: stockStatus.value,
    bizType: bizType.value,
    dateFrom: dateFrom.value,
    dateTo: dateTo.value,
  };
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<MovementRow[]>(PATH, { ...query(), page: page.value, pageSize });
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
  const [productRes, warehouseRes] = await Promise.all([
    http.get<OptionRow[]>('/api/masterdata/items', { pageSize: 200 }),
    http.get<OptionRow[]>('/api/masterdata/warehouses', { pageSize: 200 }),
  ]);
  products.value = productRes.data;
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

.product {
  width: 200px;
}

.warehouse {
  width: 180px;
}

.status {
  width: 130px;
}

.biz {
  width: 140px;
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