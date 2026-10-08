<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索物料编码 / 名称"
        clearable
        class="search"
        @keyup.enter="load"
        @clear="load"
      />
      <el-select v-model="warehouseId" class="warehouse" placeholder="仓库" clearable @change="load">
        <el-option
          v-for="item in warehouses"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-button @click="load">查询</el-button>
      <span class="hint">状态转移只在三种库存状态间移动数量，不改变物料在该仓库的平均成本</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="140" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column prop="warehouse_name" label="仓库" width="150" show-overflow-tooltip />
      <el-table-column label="可用" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.available_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="冻结" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.frozen_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="质检中" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.qc_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="合计" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.total_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column prop="base_unit" label="单位" width="80" />
      <el-table-column label="平均成本" width="120" align="right">
        <template #default="{ row }">{{ formatAmount(row.avg_cost) }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="170">
        <template #default="{ row }">{{ readTime(row.updated_at) }}</template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button
            v-for="action in actionsFor(row)"
            :key="`${action.from}>${action.to}`"
            link
            type="primary"
            @click="open(row, action)"
          >
            {{ action.label }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialogVisible" :title="target?.action.label ?? '库存状态变更'" width="480px">
    <el-descriptions v-if="target" :column="1" border>
      <el-descriptions-item label="物料">
        {{ target.row.product_code }} {{ target.row.product_name }}
      </el-descriptions-item>
      <el-descriptions-item label="仓库">{{ target.row.warehouse_name }}</el-descriptions-item>
      <el-descriptions-item label="状态变更">
        {{ statusLabel(target.action.from) }} → {{ statusLabel(target.action.to) }}
      </el-descriptions-item>
      <el-descriptions-item label="可转移数量">
        {{ formatQty(availableQty(target.row, target.action.from), target.row.qty_precision) }}
        {{ target.row.base_unit }}
      </el-descriptions-item>
    </el-descriptions>
    <el-form label-width="90px" class="form">
      <el-form-item label="数量" required>
        <el-input-number v-model="quantity" :min="1" :step="1" :precision="0" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">提交</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  ALLOWED_STATUS_TRANSITIONS,
  STOCK_STATUS_LABELS,
  STATUS_TRANSITION_ACTION_LABELS,
  type StockStatus,
} from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatAmount, formatQty } from '@/utils/format';

interface BalanceRow {
  product_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  available_qty: number;
  frozen_qty: number;
  qc_qty: number;
  total_qty: number;
  avg_cost: number;
  updated_at: string;
}

interface OptionRow {
  id: number;
  code: string;
  name: string;
}

interface StatusAction {
  from: StockStatus;
  to: StockStatus;
  label: string;
}

/** 白名单转移恒为标签表的子集，故按白名单键取值 */
const STATUS_ACTIONS: StatusAction[] = ALLOWED_STATUS_TRANSITIONS.map((action) => ({
  from: action.from,
  to: action.to,
  label:
    STATUS_TRANSITION_ACTION_LABELS[
      `${action.from}>${action.to}` as keyof typeof STATUS_TRANSITION_ACTION_LABELS
    ],
}));

const auth = useAuthStore();
const canManage = computed(() => auth.has('inventory.status.manage'));

function statusLabel(value: unknown): string {
  return STOCK_STATUS_LABELS[value as keyof typeof STOCK_STATUS_LABELS] ?? String(value);
}

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

function availableQty(row: BalanceRow, status: string): number {
  if (status === 'available') return row.available_qty;
  if (status === 'frozen') return row.frozen_qty;
  return row.qc_qty;
}

/** 只保留来源状态有余额的转移动作 */
function actionsFor(row: BalanceRow): StatusAction[] {
  return STATUS_ACTIONS.filter((action) => availableQty(row, action.from) > 0);
}

const rows = ref<BalanceRow[]>([]);
const warehouses = ref<OptionRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const dialogVisible = ref(false);
const target = ref<{ row: BalanceRow; action: StatusAction } | null>(null);
const quantity = ref(1);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<BalanceRow[]>('/api/inventory/balances', {
      keyword: keyword.value,
      warehouseId: warehouseId.value,
    });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function open(row: BalanceRow, action: StatusAction): void {
  target.value = { row, action };
  quantity.value = 1;
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  const current = target.value;
  if (!current) return;
  const { row, action } = current;
  const max = availableQty(row, action.from);
  if (quantity.value < 1 || quantity.value > max) {
    ElMessage.warning(`数量须在 1 ~ ${max} 之间`);
    return;
  }
  try {
    await ElMessageBox.confirm(
      `确认将「${row.product_name}」在「${row.warehouse_name}」的 ${formatQty(quantity.value, row.qty_precision)} ${row.base_unit} 从「${statusLabel(action.from)}」转为「${statusLabel(action.to)}」？`,
      `${action.label}确认`,
      { type: 'warning' },
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    await http.post('/api/inventory/status-change', {
      productId: row.product_id,
      warehouseId: row.warehouse_id,
      fromStatus: action.from,
      toStatus: action.to,
      quantity: quantity.value,
    });
    ElMessage.success('已提交');
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  const { data } = await http.get<OptionRow[]>('/api/masterdata/warehouses');
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

.search {
  width: 200px;
}

.warehouse {
  width: 180px;
}

.hint {
  font-size: 12px;
  color: #909399;
}

.form {
  margin-top: 16px;
}
</style>