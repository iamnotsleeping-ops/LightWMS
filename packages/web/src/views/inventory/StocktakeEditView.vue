<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>{{ isEdit ? `编辑盘点单 ${orderNo}` : '新建盘点单' }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存草稿</el-button>
        </div>
      </div>
    </template>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      title="盘点单保存后为草稿，过账时才以实盘量对齐账面；账面量为当前库存参考值，过账时以当时余额为准重算差异。"
      class="tip"
    />

    <el-form :model="form" label-width="90px" class="head">
      <el-form-item label="仓库" required>
        <el-select v-model="form.warehouse_id" placeholder="选择仓库" class="warehouse">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="盘点日期" required>
        <el-date-picker v-model="form.order_date" type="date" value-format="YYYY-MM-DD" />
      </el-form-item>
    </el-form>

    <el-table :data="form.items" border>
      <el-table-column type="index" label="#" width="50" />
      <el-table-column label="物料" min-width="240">
        <template #default="{ row }">
          <el-select
            v-model="row.product_id"
            placeholder="搜索物料编码 / 名称"
            filterable
            remote
            :remote-method="searchItems"
            :loading="itemLoading"
            class="full"
            @visible-change="(visible: boolean) => visible && searchItems('')"
          >
            <el-option
              v-for="item in itemOptions"
              :key="item.id"
              :label="`${item.code} ${item.name}`"
              :value="item.id"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="库存状态" width="140">
        <template #default="{ row }">
          <el-select v-model="row.stock_status" class="full">
            <el-option
              v-for="item in STOCK_STATUSES"
              :key="item"
              :label="STOCK_STATUS_LABELS[item]"
              :value="item"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="账面量" width="120" align="right">
        <template #default="{ row }">{{ formatQty(bookQty(row), 0) }}</template>
      </el-table-column>
      <el-table-column label="实盘量" width="150">
        <template #default="{ row }">
          <el-input-number v-model="row.counted_qty" :min="0" :precision="0" :controls="false" class="full" />
        </template>
      </el-table-column>
      <el-table-column label="差异" width="120" align="right">
        <template #default="{ row }">
          <span :class="diffClass(row)">{{ formatQty(diffQty(row), 0) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="80" fixed="right">
        <template #default="{ $index }">
          <el-button link type="danger" :disabled="form.items.length <= 1" @click="removeRow($index)">
            删除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="footer">
      <el-button @click="addRow">新增行</el-button>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import {
  STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  type StockStatus,
} from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/client';
import { formatQty } from '@/utils/format';

interface Option {
  id: number;
  code: string;
  name: string;
}

interface BalanceRow {
  product_id: number;
  available_qty: number;
  frozen_qty: number;
  qc_qty: number;
}

interface EditableItem {
  product_id: number | undefined;
  stock_status: StockStatus;
  counted_qty: number;
  book_qty: number;
}

interface OrderDetailItem {
  product_id: number;
  stock_status: StockStatus;
  counted_qty: number;
  book_qty: number;
}

const route = useRoute();
const router = useRouter();

const isEdit = computed(() => Boolean(route.params.id));
const orderNo = ref('');

const warehouses = ref<Option[]>([]);
const itemOptions = ref<Option[]>([]);
const itemLoading = ref(false);
const loading = ref(false);
const saving = ref(false);
const balances = ref<Map<string, number>>(new Map());

const form = reactive({
  warehouse_id: undefined as number | undefined,
  order_date: new Date().toISOString().slice(0, 10),
  items: [newRow()] as EditableItem[],
});

function newRow(): EditableItem {
  return { product_id: undefined, stock_status: 'available', counted_qty: 0, book_qty: 0 };
}

function addRow(): void {
  form.items.push(newRow());
}

function removeRow(index: number): void {
  form.items.splice(index, 1);
}

function balanceOf(row: EditableItem): number {
  if (!row.product_id) return row.book_qty;
  const value = balances.value.get(`${row.product_id}:${row.stock_status}`);
  return value === undefined ? row.book_qty : value;
}

const bookQty = (row: EditableItem): number => balanceOf(row);
const diffQty = (row: EditableItem): number => (row.counted_qty || 0) - balanceOf(row);

function diffClass(row: EditableItem): string {
  const diff = diffQty(row);
  if (diff > 0) return 'plus';
  if (diff < 0) return 'minus';
  return '';
}

async function searchItems(keyword: string): Promise<void> {
  itemLoading.value = true;
  try {
    const { data } = await http.get<Option[]>('/api/masterdata/items', {
      keyword: keyword || undefined,
      isActive: '1',
      pageSize: 200,
    });
    itemOptions.value = data;
  } finally {
    itemLoading.value = false;
  }
}

async function loadBalances(): Promise<void> {
  if (!form.warehouse_id) {
    balances.value = new Map();
    return;
  }
  const { data } = await http.get<BalanceRow[]>('/api/inventory/balances', {
    warehouseId: form.warehouse_id,
  });
  const map = new Map<string, number>();
  for (const row of data) {
    map.set(`${row.product_id}:available`, row.available_qty);
    map.set(`${row.product_id}:frozen`, row.frozen_qty);
    map.set(`${row.product_id}:qc`, row.qc_qty);
  }
  balances.value = map;
}

async function loadOptions(): Promise<void> {
  const [warehouseRes, itemRes] = await Promise.all([
    http.get<Option[]>('/api/masterdata/warehouses', { pageSize: 200 }),
    http.get<Option[]>('/api/masterdata/items', { isActive: '1', pageSize: 200 }),
  ]);
  warehouses.value = warehouseRes.data;
  itemOptions.value = itemRes.data;
}

async function loadOrder(): Promise<void> {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    const { data } = await http.get<{
      order: { order_no: string; warehouse_id: number; order_date: string };
      items: OrderDetailItem[];
    }>(`/api/inventory/stocktakes/${route.params.id}`);
    orderNo.value = data.order.order_no;
    form.warehouse_id = data.order.warehouse_id;
    form.order_date = data.order.order_date;
    form.items = data.items.map((item) => ({
      product_id: item.product_id,
      stock_status: item.stock_status,
      counted_qty: item.counted_qty,
      book_qty: item.book_qty,
    }));
    const known = new Set(itemOptions.value.map((item) => item.id));
    for (const item of data.items) {
      if (known.has(item.product_id)) continue;
      known.add(item.product_id);
      const { data: detail } = await http.get<{ id: number; code: string; name: string }>(
        `/api/masterdata/items/${item.product_id}`,
      );
      itemOptions.value.push({ id: detail.id, code: detail.code, name: detail.name });
    }
    await loadBalances();
  } finally {
    loading.value = false;
  }
}

function buildPayload() {
  if (!form.warehouse_id) throw new Error('请选择仓库');
  if (!form.order_date) throw new Error('请选择盘点日期');
  const items = form.items.map((row, index) => {
    if (!row.product_id) throw new Error(`第 ${index + 1} 行未选择物料`);
    if (row.counted_qty < 0) throw new Error(`第 ${index + 1} 行实盘量不能为负`);
    return {
      product_id: row.product_id,
      stock_status: row.stock_status,
      counted_qty: row.counted_qty || 0,
    };
  });
  return { warehouse_id: form.warehouse_id, order_date: form.order_date, items };
}

async function save(): Promise<void> {
  let payload: ReturnType<typeof buildPayload>;
  try {
    payload = buildPayload();
  } catch (error) {
    ElMessage.warning((error as Error).message);
    return;
  }
  saving.value = true;
  try {
    let id: number;
    if (isEdit.value) {
      id = Number(route.params.id);
      await http.patch(`/api/inventory/stocktakes/${id}`, payload);
    } else {
      const { data } = await http.post<{ id: number }>('/api/inventory/stocktakes', payload);
      id = data.id;
    }
    ElMessage.success('已保存');
    void router.push({ name: 'stocktake-detail', params: { id } });
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

const goBack = () => void router.push({ name: 'stocktakes' });

watch(() => form.warehouse_id, loadBalances);

onMounted(async () => {
  await loadOptions();
  await loadOrder();
});
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tip {
  margin-bottom: 12px;
}

.head {
  margin-bottom: 12px;
}

.warehouse {
  width: 220px;
}

.full {
  width: 100%;
}

.footer {
  margin-top: 12px;
}

.plus {
  color: #67c23a;
  font-weight: 600;
}

.minus {
  color: #f56c6c;
  font-weight: 600;
}
</style>