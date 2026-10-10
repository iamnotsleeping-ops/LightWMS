<template>
  <div class="page">
    <el-card shadow="never">
      <template #header>待出库销售单</template>
      <el-table
        v-loading="loadingList"
        :data="orders"
        border
        highlight-current-row
        :current-row-key="selectedId"
        row-key="id"
        @current-change="selectOrder"
      >
        <el-table-column prop="order_no" label="销售单号" width="180" />
        <el-table-column prop="customer_name" label="客户" min-width="160" show-overflow-tooltip />
        <el-table-column prop="order_date" label="下单日期" width="120" />
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'partial' ? 'warning' : 'primary'">
              {{ SALES_ORDER_STATUS_LABELS[row.status as SalesOrderStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="已出库 / 总量" width="160" align="right">
          <template #default="{ row }">
            {{ formatQty(row.shipped_qty, 0) }} / {{ formatQty(row.total_qty, 0) }}
          </template>
        </el-table-column>
        <el-table-column label="未出库" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.unshipped, 0) }}</template>
        </el-table-column>
      </el-table>
      <el-pagination
        v-if="total > pageSize"
        v-model:current-page="page"
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :page-size="pageSize"
        @current-change="loadOrders"
      />
    </el-card>

    <el-card v-if="selected" shadow="never" v-loading="loadingDetail" class="detail">
      <template #header>
        <div class="header">
          <span>出库明细 · {{ selected.order_no }}</span>
          <el-button v-permission="PERMISSIONS.salesOutboundManage" type="primary" :loading="submitting" @click="submit">提交出库</el-button>
        </div>
      </template>

      <el-table :data="lines" border>
        <el-table-column prop="product_code" label="物料编码" width="150" />
        <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
        <el-table-column prop="warehouse_name" label="仓库" width="140" show-overflow-tooltip />
        <el-table-column label="销售数量" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.quantity, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="已出库" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.shipped_qty, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="未出库" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.unshipped, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="物理可用" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.available, row.qty_precision) }}</template>
        </el-table-column>
        <el-table-column label="本次出库数量" width="170">
          <template #default="{ row }">
            <el-input-number
              v-model="row.outbound"
              :min="0"
              :max="row.maxOutbound"
              :precision="0"
              :controls="false"
              class="full"
              :disabled="row.maxOutbound === 0"
            />
          </template>
        </el-table-column>
        <el-table-column v-if="canSubstitute" label="允许替代料兜底" width="150">
          <template #default="{ row }">
            <el-checkbox v-model="row.allowSubstitute" @change="onAllowChange(row)">允许</el-checkbox>
          </template>
        </el-table-column>
        <el-table-column v-if="canSubstitute" label="指定替代料" width="230">
          <template #default="{ row }">
            <el-select
              v-model="row.substituteItemId"
              placeholder="不指定"
              clearable
              filterable
              class="full"
              @visible-change="(visible: boolean) => visible && loadSubstitutes(row)"
              @change="onSubstituteChange(row)"
            >
              <el-option
                v-for="item in optionsFor(row)"
                :key="item.id"
                :label="`${item.code} ${item.name}`"
                :value="item.id"
              />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column v-if="canSubstitute" label="替代建议" width="130" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="showSuggestion(row)">查看替代建议</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="hint">
        默认按未出库量与物理可用量的较小值填入，可分批出库；每行不超过该上限（物理可用量不足时无法出库）。
      </div>
      <div v-if="canSubstitute" class="hint">
        「允许替代料兜底」与「指定替代料」互斥：前者由系统按替代关系整行补齐，后者只允许用所选替代料补缺口；
        两者留空时行为与过去一致（仅主料，不足即拒绝）。
      </div>
    </el-card>

    <el-dialog v-model="suggestVisible" title="替代建议" width="860px">
      <div v-if="suggestLine" class="summary">
        主料：{{ suggestLine.product_code }} {{ suggestLine.product_name }} ·
        仓库：{{ suggestLine.warehouse_name }} · 本次出库：
        {{ formatQty(suggestLine.outbound, suggestLine.qty_precision) }} ·
        客户：{{ selected?.customer_name ?? '—' }}
      </div>

      <el-alert
        v-if="suggestion && suggestion.gapQty > 0"
        type="error"
        :closable="false"
        show-icon
        class="alert"
        :title="`缺口 ${formatQty(suggestion.gapQty, 0)}：主料与可用替代料合计不足，直接提交本次出库将被服务端拒绝`"
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
          策略：{{ strategyLabel(suggestion.strategy) }} · 需求：{{ formatQty(suggestion.requiredQty, 0) }} ·
          已覆盖：<b>{{ formatQty(suggestion.filledQty, 0) }}</b> · 剩余缺口：
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
            <template #default="{ row }: { row: SubstitutionAllocationDto }">
              <el-tag :type="row.isMain ? 'primary' : 'success'" size="small">
                {{ row.isMain ? '主料' : '替代料' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="分配数量" width="110" align="right">
            <template #default="{ row }">{{ formatQty(row.quantity, 0) }}</template>
          </el-table-column>
          <el-table-column label="折算覆盖量" width="120" align="right">
            <template #default="{ row }: { row: SubstitutionAllocationDto }">{{ formatQty(row.coveredQty, 0) }}</template>
          </el-table-column>
          <el-table-column label="当时可用量" width="120" align="right">
            <template #default="{ row }: { row: SubstitutionAllocationDto }">{{ formatQty(row.onHand, 0) }}</template>
          </el-table-column>
          <el-table-column label="比例" width="100" align="right">
            <template #default="{ row }: { row: SubstitutionAllocationDto }">{{ ratioText(row.ratioNum, row.ratioDen) }}</template>
          </el-table-column>
        </el-table>

        <div class="section">被跳过的替代料（{{ suggestion.skipped.length }}）</div>
        <el-table :data="suggestion.skipped" border stripe size="small">
          <el-table-column prop="itemCode" label="物料编码" width="180" />
          <el-table-column label="跳过原因">
            <template #default="{ row }: { row: SubstitutionSkipDto }">{{ skipLabel(row.reason) }}</template>
          </el-table-column>
        </el-table>
      </template>

      <div v-if="suggestLoading" v-loading="true" class="loading" />
      <template #footer>
        <el-button @click="suggestVisible = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import {
  PERMISSIONS,
  SALES_ORDER_STATUS_LABELS,
  SUBSTITUTE_SKIP_REASON_LABELS,
  SUBSTITUTE_STRATEGY_LABELS,
  type SalesOrderStatus,
  type SubstituteStrategy,
  type SubstitutionPlanDto,
  type SubstitutionPlanQuery,
  type SubstitutionAllocationDto,
  type SubstitutionSkipDto,
  type SubstitutionSkipReason,
} from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatQty } from '@/utils/format';

interface OrderRow {
  id: number;
  order_no: string;
  customer_id: number;
  customer_name: string;
  order_date: string;
  status: SalesOrderStatus;
  total_qty: number;
  shipped_qty: number;
  unshipped: number;
}

interface DetailItem {
  id: number;
  product_id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_name: string;
  quantity: number;
  shipped_qty: number;
  unshipped: number;
}

interface BalanceRow {
  product_id: number;
  warehouse_id: number;
  available_qty: number;
}

interface ItemOption {
  id: number;
  code: string;
  name: string;
}

interface SubstituteRelationRow {
  id: number;
  sub_item_id: number;
  sub_item_code: string;
  sub_item_name: string;
}


type OutboundLine = DetailItem & {
  available: number;
  maxOutbound: number;
  outbound: number;
  allowSubstitute: boolean;
  substituteItemId: number | undefined;
};

const route = useRoute();
const auth = useAuthStore();

/** 替代料出库能力单列权限：无此权限时页面与过去完全一致 */
const canSubstitute = computed(() => auth.has(PERMISSIONS.salesOutboundSubstitute));

const orders = ref<OrderRow[]>([]);
const loadingList = ref(false);
const loadingDetail = ref(false);
const submitting = ref(false);
const selectedId = ref<number | undefined>(undefined);
const lines = ref<OutboundLine[]>([]);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const substituteOptions = ref<Map<number, ItemOption[]>>(new Map());
const suggestVisible = ref(false);
const suggestLoading = ref(false);
const suggestLine = ref<OutboundLine | null>(null);
const suggestion = ref<SubstitutionPlanDto | null>(null);
const suggestWarnings = ref<string[]>([]);

const selected = computed(() => orders.value.find((row) => row.id === selectedId.value) ?? null);

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

function optionsFor(row: OutboundLine): ItemOption[] {
  return substituteOptions.value.get(row.product_id) ?? [];
}

/** 按需取「该主料 + 销售出库场景」的替代料候选，结果按物料缓存 */
async function loadSubstitutes(row: OutboundLine): Promise<void> {
  if (substituteOptions.value.has(row.product_id)) return;
  const { data } = await http.get<SubstituteRelationRow[]>('/api/masterdata/substitutes', {
    mainItemId: row.product_id,
    scene: 'sales_out',
    isActive: 1,
    pageSize: 200,
  });
  const map = new Map<number, ItemOption>();
  for (const item of data) {
    map.set(item.sub_item_id, { id: item.sub_item_id, code: item.sub_item_code, name: item.sub_item_name });
  }
  const next = new Map(substituteOptions.value);
  next.set(row.product_id, [...map.values()]);
  substituteOptions.value = next;
}

function onAllowChange(row: OutboundLine): void {
  if (row.allowSubstitute) row.substituteItemId = undefined;
}

function onSubstituteChange(row: OutboundLine): void {
  if (row.substituteItemId !== undefined) row.allowSubstitute = false;
}

async function loadOrders(): Promise<void> {
  loadingList.value = true;
  try {
    const { data, page: info } = await http.get<OrderRow[]>('/api/sales/orders', {
      status: 'confirmed,partial',
      page: page.value,
      pageSize,
    });
    orders.value = data;
    total.value = info?.total ?? 0;
  } finally {
    loadingList.value = false;
  }
}

/** 读取涉及物料的物理可用量，键为 `${product_id}:${warehouse_id}` */
async function loadAvailable(productIds: number[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(productIds)];
  const results = await Promise.all(
    unique.map((productId) => http.get<BalanceRow[]>('/api/inventory/balances', { productId })),
  );
  for (const { data } of results) {
    for (const row of data) {
      map.set(`${row.product_id}:${row.warehouse_id}`, row.available_qty);
    }
  }
  return map;
}

async function loadDetail(id: number): Promise<void> {
  loadingDetail.value = true;
  selectedId.value = id;
  try {
    const { data } = await http.get<{ items: DetailItem[] }>(`/api/sales/orders/${id}`);
    const available = await loadAvailable(data.items.map((item) => item.product_id));
    lines.value = data.items.map((item) => {
      const avail = available.get(`${item.product_id}:${item.warehouse_id}`) ?? 0;
      const maxOutbound = Math.min(item.unshipped, avail);
      return {
        ...item,
        available: avail,
        maxOutbound,
        outbound: maxOutbound,
        allowSubstitute: false,
        substituteItemId: undefined,
      };
    });
  } finally {
    loadingDetail.value = false;
  }
}

function selectOrder(row: OrderRow | null): void {
  if (row) void loadDetail(row.id);
}

/** 试算参数与服务端出库口径一致：自动兜底=proportion，指定替代料=manual */
async function showSuggestion(row: OutboundLine): Promise<void> {
  suggestLine.value = row;
  suggestion.value = null;
  suggestWarnings.value = [];
  suggestVisible.value = true;
  if (!Number.isInteger(row.outbound) || row.outbound <= 0) {
    ElMessage.warning('请先填写本次出库数量');
    return;
  }
  if (!selected.value) return;
  suggestLoading.value = true;
  try {
    const res = await http.get<SubstitutionPlanDto>('/api/masterdata/substitutes/plan', {
      mainItemId: row.product_id,
      warehouseId: row.warehouse_id,
      requiredQty: row.outbound,
      scene: 'sales_out',
      customerId: selected.value.customer_id,
      strategy: row.substituteItemId !== undefined ? 'manual' : 'proportion',
      manualItemIds:
        row.substituteItemId !== undefined ? String(row.substituteItemId) : undefined,
    } satisfies SubstitutionPlanQuery);
    suggestion.value = res.data;
    suggestWarnings.value = [...res.data.warnings, ...res._warnings.map((item) => String(item))];
  } catch {
    suggestion.value = null;
  } finally {
    suggestLoading.value = false;
  }
}

async function submit(): Promise<void> {
  if (!selected.value) return;
  const payloadLines = lines.value
    .filter((line) => line.outbound > 0)
    .map((line) => {
      const payload: {
        orderItemId: number;
        quantity: number;
        allowSubstitute?: boolean;
        substituteItemId?: number;
      } = { orderItemId: line.id, quantity: line.outbound };
      // 无 sales.outbound.substitute 权限时不携带替代字段；若服务端仍返回 403，错误提示已在 api client 中弹出
      if (canSubstitute.value) {
        if (line.allowSubstitute) payload.allowSubstitute = true;
        else if (line.substituteItemId !== undefined) payload.substituteItemId = line.substituteItemId;
      }
      return payload;
    });
  if (payloadLines.length === 0) {
    ElMessage.warning('请填写本次出库数量');
    return;
  }
  submitting.value = true;
  try {
    const { data } = await http.post<{ status: SalesOrderStatus }>('/api/sales/outbound', {
      orderId: selected.value.id,
      lines: payloadLines,
    });
    ElMessage.success(`出库成功，单据状态：${SALES_ORDER_STATUS_LABELS[data.status]}`);
    await loadOrders();
    if (orders.value.some((row) => row.id === selected.value?.id)) {
      await loadDetail(selected.value.id);
    } else {
      selectedId.value = undefined;
      lines.value = [];
    }
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await loadOrders();
  const preset = Number(route.query.orderId);
  if (preset && orders.value.some((row) => row.id === preset)) {
    await loadDetail(preset);
  }
});
</script>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin-top: 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.full {
  width: 100%;
}

.summary {
  margin-bottom: 12px;
  font-size: 14px;
}

.summary .gap {
  color: var(--el-color-danger);
}

.alert {
  margin-bottom: 8px;
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
  color: var(--el-text-color-secondary);
}

.loading {
  height: 80px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
