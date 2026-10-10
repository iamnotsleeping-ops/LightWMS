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
      <el-select v-model="warehouseId" class="warehouse" placeholder="备料仓库" clearable>
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
    <div v-if="result" class="hint">
      选择备料仓库后，外购件「累计需求」超过该仓库当前可用量的行才显示「替代建议」。
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
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-tooltip
            v-if="canSuggest(row)"
            :content="`仓库当前可用 ${formatBomQty(availableOf(row))}`"
            placement="left"
          >
            <el-button link type="primary" @click="showSuggestion(row)">替代建议</el-button>
          </el-tooltip>
          <span v-else class="sub">—</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="suggestVisible" title="替代建议" width="860px">
    <div v-if="suggestLine" class="summary">
      物料：{{ suggestLine.itemCode }} {{ suggestLine.itemName }} ·
      仓库：{{ warehouseLabel }} · BOM 累计需求：
      {{ formatBomQty(suggestLine.requiredQty) }} {{ suggestLine.baseUnit }}
    </div>

    <el-alert
      v-if="suggestion && suggestion.gapQty > 0"
      type="error"
      :closable="false"
      show-icon
      class="alert"
      :title="`缺口 ${formatQty(suggestion.gapQty, 0)}：主料与可用替代料合计不足，需补货或调整备料计划`"
    />

    <el-alert
      v-for="(warning, index) in suggestWarnings"
      :key="index"
      type="warning"
      :closable="false"
      show-icon
      class="alert"
      :title="warning"
    />

    <template v-if="suggestion">
      <div class="summary">
        策略：{{ strategyLabel(suggestion.strategy) }} · 试算需求（向上取整）：{{
          formatQty(suggestion.requiredQty, 0)
        }} · 已覆盖：<b>{{ formatQty(suggestion.filledQty, 0) }}</b> · 剩余缺口：
        <b :class="{ gap: suggestion.gapQty > 0 }">{{ formatQty(suggestion.gapQty, 0) }}</b>
      </div>

      <el-table :data="suggestion.allocations" border stripe size="small">
        <el-table-column label="物料" min-width="220">
          <template #default="{ row }">
            <span class="code">{{ row.itemCode }}</span>
            <span class="name">{{ row.itemName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="是否主料" width="100">
          <template #default="{ row }">
            <el-tag :type="row.isMain ? 'primary' : 'success'" size="small">
              {{ row.isMain ? '主料' : '替代料' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分配数量" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.quantity, 0) }}</template>
        </el-table-column>
        <el-table-column label="折算覆盖量" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.coveredQty, 0) }}</template>
        </el-table-column>
        <el-table-column label="当时可用量" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.onHand, 0) }}</template>
        </el-table-column>
        <el-table-column label="比例" width="100" align="right">
          <template #default="{ row }">{{ ratioText(row.ratioNum, row.ratioDen) }}</template>
        </el-table-column>
      </el-table>

      <div class="section">被跳过的替代料（{{ suggestion.skipped.length }}）</div>
      <el-table :data="suggestion.skipped" border stripe size="small">
        <el-table-column prop="itemCode" label="物料编码" width="180" />
        <el-table-column label="跳过原因">
          <template #default="{ row }">{{ skipLabel(row.reason) }}</template>
        </el-table-column>
      </el-table>
    </template>

    <div v-if="suggestLoading" v-loading="true" class="loading" />
    <template #footer>
      <el-button @click="suggestVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  SUBSTITUTE_SKIP_REASON_LABELS,
  SUBSTITUTE_STRATEGY_LABELS,
  type SubstituteStrategy,
  type SubstitutionSkipReason,
} from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '@/api/client';
import { formatQty } from '@/utils/format';

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

interface WarehouseOption {
  id: number;
  code: string;
  name: string;
  is_active: number;
}

interface BalanceRow {
  product_id: number;
  warehouse_id: number;
  available_qty: number;
}

interface PlanAllocation {
  itemId: number;
  itemCode: string;
  itemName: string;
  quantity: number;
  coveredQty: number;
  isMain: boolean;
  /** 物理可用量（available 桶）＝ IF-3 的 on_hand；不是 ATP */
  onHand: number;
  unitCost: number;
  ratioNum: number;
  ratioDen: number;
}

interface PlanSkip {
  itemId: number;
  itemCode: string;
  reason: SubstitutionSkipReason;
}

interface SubstitutionPlan {
  mainItemId: number;
  mainItemCode: string;
  warehouseId: number;
  scene: string;
  requiredQty: number;
  strategy: SubstituteStrategy;
  allocations: PlanAllocation[];
  filledQty: number;
  gapQty: number;
  skipped: PlanSkip[];
  warnings: string[];
}

const route = useRoute();

const items = ref<ItemOption[]>([]);
const warehouses = ref<WarehouseOption[]>([]);
const itemId = ref<number | undefined>(undefined);
const warehouseId = ref<number | undefined>(undefined);
const asOf = ref<string | null>(null);
const qty = ref(1);
const loading = ref(false);
const result = ref<ExplodeResult | null>(null);
const warnings = ref<string[]>([]);
const available = ref<Map<number, number>>(new Map());

const suggestVisible = ref(false);
const suggestLoading = ref(false);
const suggestLine = ref<ExplodeNode | null>(null);
const suggestion = ref<SubstitutionPlan | null>(null);
const suggestWarnings = ref<string[]>([]);

/** BOM 用量是配方系数（非库存精度缩放量），直接按原始数值展示 */
function formatBomQty(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function strategyLabel(value: unknown): string {
  const key = value as SubstituteStrategy;
  return SUBSTITUTE_STRATEGY_LABELS[key] ?? String(value);
}

function skipLabel(reason: SubstitutionSkipReason): string {
  return SUBSTITUTE_SKIP_REASON_LABELS[reason] ?? reason;
}

function ratioText(num: number, den: number): string {
  return den === 1 ? `1 : ${num}` : `${num}/${den}`;
}

const warehouseLabel = computed(() => {
  const current = warehouses.value.find((item) => item.id === warehouseId.value);
  return current ? `${current.code} ${current.name}` : '—';
});

function availableOf(row: ExplodeNode): number {
  return available.value.get(row.itemId) ?? 0;
}

/** 只对外购件、且备料需求超过该仓库可用量的行给出建议入口 */
function canSuggest(row: ExplodeNode): boolean {
  if (warehouseId.value === undefined) return false;
  if (!row.isLeaf || row.cyclic) return false;
  return row.requiredQty > availableOf(row);
}

async function loadItems(): Promise<void> {
  const { data } = await http.get<ItemOption[]>('/api/masterdata/items', {
    pageSize: 200,
    isActive: '1',
  });
  items.value = data;
}

async function loadWarehouses(): Promise<void> {
  const { data } = await http.get<WarehouseOption[]>('/api/masterdata/warehouses', {
    pageSize: 200,
  });
  warehouses.value = data;
  if (warehouseId.value === undefined) {
    const active = data.find((item) => item.is_active === 1) ?? data[0];
    warehouseId.value = active?.id;
  }
}

/** 一次取整仓余额构成本地可用量映射（替代建议按钮的显示条件用它判定） */
async function loadBalances(): Promise<void> {
  if (warehouseId.value === undefined) {
    available.value = new Map();
    return;
  }
  const { data } = await http.get<BalanceRow[]>('/api/inventory/balances', {
    warehouseId: warehouseId.value,
  });
  const map = new Map<number, number>();
  for (const row of data) map.set(row.product_id, row.available_qty);
  available.value = map;
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
    await loadBalances();
  } finally {
    loading.value = false;
  }
}

async function showSuggestion(row: ExplodeNode): Promise<void> {
  suggestLine.value = row;
  suggestion.value = null;
  suggestWarnings.value = [];
  suggestVisible.value = true;
  if (warehouseId.value === undefined) {
    ElMessage.warning('请先选择备料仓库');
    return;
  }
  // 规划接口只接受正整数需求量：向上取整，宁可多备
  const requiredQty = Math.ceil(row.requiredQty);
  if (!Number.isInteger(requiredQty) || requiredQty <= 0) {
    ElMessage.warning('该行需求量不足一个整数单位，无法试算');
    return;
  }
  suggestLoading.value = true;
  try {
    const res = await http.get<SubstitutionPlan>('/api/masterdata/substitutes/plan', {
      mainItemId: row.itemId,
      warehouseId: warehouseId.value,
      requiredQty,
      scene: 'bom_plan',
    });
    suggestion.value = res.data;
    suggestWarnings.value = [...res.data.warnings, ...res._warnings.map((item) => String(item))];
  } catch {
    suggestion.value = null;
  } finally {
    suggestLoading.value = false;
  }
}

watch(itemId, () => {
  result.value = null;
  warnings.value = [];
});

watch(warehouseId, () => {
  void loadBalances();
});

onMounted(async () => {
  await Promise.all([loadItems(), loadWarehouses()]);
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

.warehouse {
  width: 200px;
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

.summary .gap {
  color: var(--el-color-danger);
}

.hint {
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.section {
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
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

.loading {
  height: 80px;
}
</style>
