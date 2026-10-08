<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-select v-model="itemId" class="item" placeholder="选择父件" clearable filterable>
        <el-option
          v-for="item in items"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-date-picker
        v-model="asOf"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="生效日期（留空 = 今天）"
        clearable
        class="date"
      />
      <el-input-number v-model="qty" :min="0.0001" :step="1" :precision="4" class="qty" />
      <el-button type="primary" :disabled="!itemId" @click="explode">展开</el-button>
    </div>

    <el-alert
      v-if="warnings.length > 0"
      type="warning"
      :closable="false"
      show-icon
      title="展开提示"
      class="alert"
    >
      <div v-for="(warning, index) in warnings" :key="index">{{ warning }}</div>
    </el-alert>

    <div v-if="result" class="summary">
      父件：{{ result.root.itemCode }} {{ result.root.itemName }} ·
      生效日期：{{ result.asOf }} · 需求：{{ formatBomQty(result.root.requiredQty) }}
      {{ result.root.baseUnit }}
    </div>

    <el-table v-loading="loading" :data="result?.lines ?? []" border stripe>
      <el-table-column label="物料" min-width="280">
        <template #default="{ row }">
          <div :style="{ paddingLeft: `${(row.level - 1) * 20}px` }">
            <span class="code">{{ row.itemCode }}</span>
            <span class="name">{{ row.itemName }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="单位用量" width="120" align="right">
        <template #default="{ row }">
          {{ formatBomQty(row.qtyPer) }}
          <span class="sub">{{ row.baseUnit }}</span>
        </template>
      </el-table-column>
      <el-table-column label="损耗率" width="100" align="right">
        <template #default="{ row }">{{ (row.scrapRate * 100).toFixed(2) }}%</template>
      </el-table-column>
      <el-table-column label="累计需求" width="140" align="right">
        <template #default="{ row }">
          <span class="num">{{ formatBomQty(row.requiredQty) }}</span>
          <span class="sub"> {{ row.baseUnit }}</span>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.cyclic" type="danger" size="small">循环引用</el-tag>
          <el-tag v-else-if="row.isLeaf" type="info" size="small">外购件</el-tag>
          <el-tag v-else type="success" size="small">自制件</el-tag>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '@/api/client';

interface ExplodeNode {
  level: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  baseUnit: string;
  qtyPrecision: number;
  qtyPer: number;
  scrapRate: number;
  requiredQty: number;
  isLeaf: boolean;
  cyclic: boolean;
}

interface ExplodeResult {
  asOf: string;
  root: {
    itemId: number;
    itemCode: string;
    itemName: string;
    baseUnit: string;
    qtyPrecision: number;
    requiredQty: number;
  };
  lines: ExplodeNode[];
  cycles: string[][];
  warnings: string[];
}

interface ItemOption {
  id: number;
  code: string;
  name: string;
  base_unit: string;
}

const route = useRoute();

const items = ref<ItemOption[]>([]);
const itemId = ref<number | undefined>(undefined);
const asOf = ref<string | null>(null);
const qty = ref(1);
const loading = ref(false);
const result = ref<ExplodeResult | null>(null);
const warnings = ref<string[]>([]);

/** BOM 用量是配方系数（非库存精度缩放量），直接按原始数值展示 */
function formatBomQty(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

async function loadItems(): Promise<void> {
  const { data } = await http.get<ItemOption[]>('/api/masterdata/items', {
    pageSize: 200,
    isActive: '1',
  });
  items.value = data;
}

async function explode(): Promise<void> {
  if (!itemId.value) return;
  loading.value = true;
  try {
    const { data, _warnings } = await http.get<ExplodeResult>('/api/masterdata/boms/explode', {
      itemId: itemId.value,
      asOf: asOf.value ?? undefined,
      qty: qty.value,
    });
    result.value = data;
    warnings.value = (data.warnings ?? []).concat(
      (_warnings ?? []).filter((item): item is string => typeof item === 'string'),
    );
  } finally {
    loading.value = false;
  }
}

watch(itemId, () => {
  result.value = null;
  warnings.value = [];
});

onMounted(async () => {
  await loadItems();
  const prefill = Number(route.query.itemId);
  if (Number.isInteger(prefill) && prefill > 0) {
    itemId.value = prefill;
    await explode();
  }
});
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.item {
  width: 240px;
}

.date {
  width: 220px;
}

.qty {
  width: 140px;
}

.alert {
  margin-bottom: 12px;
}

.summary {
  margin-bottom: 12px;
  font-size: 14px;
  color: #303133;
}

.code {
  margin-right: 8px;
}

.name {
  color: #606266;
}

.num {
  font-variant-numeric: tabular-nums;
}

.sub {
  font-size: 12px;
  color: #909399;
}
</style>