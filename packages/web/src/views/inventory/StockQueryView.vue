<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-radio-group v-model="view">
        <el-radio-button v-for="item in INVENTORY_VIEWS" :key="item" :value="item">
          {{ INVENTORY_VIEW_LABELS[item] }}
        </el-radio-button>
      </el-radio-group>
      <span class="spacer" />
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
        class="asof"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="历史时点（可选）"
        clearable
        @change="reload"
      />
      <el-button @click="reload">查询</el-button>
    </div>

    <el-alert v-if="warnings.length" type="info" show-icon :closable="false" class="warnings">
      <div v-for="item in warnings" :key="item">{{ item }}</div>
    </el-alert>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="150" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="150" show-overflow-tooltip />
      <el-table-column label="仓库类型" width="110">
        <template #default="{ row }">
          <el-tag :type="typeTag(row.warehouse_type)">{{ typeLabel(row.warehouse_type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="INVENTORY_VIEW_LABELS[view]" width="150" align="right">
        <template #default="{ row }">
          {{ formatQty(metricValue(row), row.qty_precision) }}
        </template>
      </el-table-column>
      <el-table-column prop="base_unit" label="单位" width="90" />
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
import { INVENTORY_VIEWS, INVENTORY_VIEW_LABELS, type InventoryView } from '@light-erp/shared';
import { onMounted, ref } from 'vue';
import { http } from '@/api/client';
import { formatQty } from '@/utils/format';

interface StockRow {
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  warehouse_type: string;
  on_hand: number;
  frozen: number;
  reserved: number | null;
  in_transit: number | null;
  available: number | null;
  projected: number | null;
}

interface WarehouseOption {
  id: number;
  code: string;
  name: string;
}

const TYPE_LABEL: Record<string, string> = { plant: '工厂', warehouse: '仓库', port: '港口' };
const TYPE_TAG: Record<string, 'primary' | 'success' | 'warning'> = {
  plant: 'primary',
  warehouse: 'success',
  port: 'warning',
};

function typeLabel(value: unknown): string {
  return TYPE_LABEL[String(value)] ?? String(value);
}

function typeTag(value: unknown): 'primary' | 'success' | 'warning' {
  return TYPE_TAG[String(value)] ?? 'primary';
}

const rows = ref<StockRow[]>([]);
const warehouses = ref<WarehouseOption[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const view = ref<InventoryView>('on_hand');
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const asOf = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

/** 历史时点只能还原实物量，单据派生口径返回 — */
function metricValue(row: StockRow): number | null {
  if (row.reserved === null) return view.value === 'on_hand' ? row.on_hand : null;
  switch (view.value) {
    case 'on_hand':
      return row.on_hand;
    case 'with_transit':
      return row.on_hand + (row.in_transit ?? 0);
    case 'available':
      return row.available;
    case 'projected':
      return row.projected;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<StockRow[]>('/api/inventory/stocks', {
      keyword: keyword.value,
      warehouseId: warehouseId.value,
      asOf: asOf.value,
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

onMounted(async () => {
  const { data } = await http.get<WarehouseOption[]>('/api/masterdata/warehouses');
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
}

.spacer {
  flex: 1;
}

.search {
  width: 200px;
}

.warehouse {
  width: 180px;
}

.asof {
  width: 190px;
}

.warnings {
  margin-bottom: 12px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>