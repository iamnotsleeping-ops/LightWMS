<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>{{ isEdit ? `编辑销售单 ${orderNo}` : '新建销售单' }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button type="primary" plain :loading="saving" @click="save(false)">保存草稿</el-button>
          <el-button type="primary" :loading="saving" @click="save(true)">保存并确认</el-button>
        </div>
      </div>
    </template>

    <el-form :model="form" label-width="90px" class="head">
      <el-form-item label="客户" required>
        <el-select v-model="form.customer_id" placeholder="选择客户" class="customer" filterable>
          <el-option
            v-for="item in customers"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="下单日期" required>
        <el-date-picker v-model="form.order_date" type="date" value-format="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" maxlength="500" class="remark" />
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
      <el-table-column label="仓库" width="180">
        <template #default="{ row }">
          <el-select v-model="row.warehouse_id" placeholder="仓库" class="full">
            <el-option
              v-for="item in warehouses"
              :key="item.id"
              :label="`${item.code} ${item.name}`"
              :value="item.id"
            />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="数量" width="130">
        <template #default="{ row }">
          <el-input-number v-model="row.quantity" :min="1" :precision="0" :controls="false" class="full" />
        </template>
      </el-table-column>
      <el-table-column label="单价（元）" width="150">
        <template #default="{ row }">
          <el-input-number
            v-model="row.unit_price_yuan"
            :min="0"
            :precision="2"
            :controls="false"
            class="full"
          />
        </template>
      </el-table-column>
      <el-table-column label="金额（元）" width="140" align="right">
        <template #default="{ row }">{{ formatAmount(rowAmount(row)) }}</template>
      </el-table-column>
      <el-table-column label="交货日期" width="170">
        <template #default="{ row }">
          <el-date-picker
            v-model="row.due_date"
            type="date"
            value-format="YYYY-MM-DD"
            class="full"
            @keyup.enter="addRow"
          />
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
      <span class="total">合计：{{ formatAmount(totalAmount) }}</span>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/client';
import { formatAmount } from '@/utils/format';

interface Option {
  id: number;
  code: string;
  name: string;
  qty_precision?: number;
}

interface EditableItem {
  product_id: number | undefined;
  warehouse_id: number | undefined;
  quantity: number;
  unit_price_yuan: number;
  due_date: string | undefined;
}

interface OrderDetailItem {
  product_id: number;
  warehouse_id: number;
  quantity: number;
  unit_price: number;
  due_date: string;
}

const route = useRoute();
const router = useRouter();

const isEdit = computed(() => Boolean(route.params.id));
const orderNo = ref('');

const customers = ref<Option[]>([]);
const warehouses = ref<Option[]>([]);
const itemOptions = ref<Option[]>([]);
const itemLoading = ref(false);
const loading = ref(false);
const saving = ref(false);

const form = reactive({
  customer_id: undefined as number | undefined,
  order_date: new Date().toISOString().slice(0, 10),
  remark: '',
  items: [newRow()] as EditableItem[],
});

function newRow(): EditableItem {
  return {
    product_id: undefined,
    warehouse_id: undefined,
    quantity: 1,
    unit_price_yuan: 0,
    due_date: undefined,
  };
}

function addRow(): void {
  form.items.push(newRow());
}

function removeRow(index: number): void {
  form.items.splice(index, 1);
}

function rowAmount(row: EditableItem): number {
  return (row.quantity || 0) * Math.round((row.unit_price_yuan || 0) * 100);
}

const totalAmount = computed(() => form.items.reduce((sum, row) => sum + rowAmount(row), 0));

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

async function loadOptions(): Promise<void> {
  const [partnerRes, warehouseRes, itemRes] = await Promise.all([
    http.get<Option[]>('/api/masterdata/partners', { type: 'customer', pageSize: 200 }),
    http.get<Option[]>('/api/masterdata/warehouses', { pageSize: 200 }),
    http.get<Option[]>('/api/masterdata/items', { isActive: '1', pageSize: 200 }),
  ]);
  customers.value = partnerRes.data;
  warehouses.value = warehouseRes.data;
  itemOptions.value = itemRes.data;
}

async function loadOrder(): Promise<void> {
  if (!isEdit.value) return;
  loading.value = true;
  try {
    const { data } = await http.get<{
      order: { order_no: string; customer_id: number; order_date: string; remark: string | null };
      items: OrderDetailItem[];
    }>(`/api/sales/orders/${route.params.id}`);
    orderNo.value = data.order.order_no;
    form.customer_id = data.order.customer_id;
    form.order_date = data.order.order_date;
    form.remark = data.order.remark ?? '';
    form.items = data.items.map((item) => ({
      product_id: item.product_id,
      warehouse_id: item.warehouse_id,
      quantity: item.quantity,
      unit_price_yuan: item.unit_price / 100,
      due_date: item.due_date,
    }));
    // 回显：补齐不在首屏选项中的物料，避免下拉显示为空
    const known = new Set(itemOptions.value.map((item) => item.id));
    for (const item of data.items) {
      if (known.has(item.product_id)) continue;
      known.add(item.product_id);
      const { data: detail } = await http.get<{ id: number; code: string; name: string }>(
        `/api/masterdata/items/${item.product_id}`,
      );
      itemOptions.value.push({ id: detail.id, code: detail.code, name: detail.name });
    }
  } finally {
    loading.value = false;
  }
}

function buildPayload() {
  if (!form.customer_id) throw new Error('请选择客户');
  if (!form.order_date) throw new Error('请选择下单日期');
  const items = form.items.map((row, index) => {
    if (!row.product_id) throw new Error(`第 ${index + 1} 行未选择物料`);
    if (!row.warehouse_id) throw new Error(`第 ${index + 1} 行未选择仓库`);
    if (!row.quantity || row.quantity <= 0) throw new Error(`第 ${index + 1} 行数量须大于 0`);
    if (!row.due_date) throw new Error(`第 ${index + 1} 行未填写交货日期`);
    return {
      product_id: row.product_id,
      warehouse_id: row.warehouse_id,
      quantity: row.quantity,
      unit_price: Math.round((row.unit_price_yuan || 0) * 100),
      due_date: row.due_date,
    };
  });
  return {
    customer_id: form.customer_id,
    order_date: form.order_date,
    remark: form.remark,
    items,
  };
}

async function save(andConfirm: boolean): Promise<void> {
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
      await http.patch(`/api/sales/orders/${id}`, payload);
    } else {
      const { data } = await http.post<{ id: number }>('/api/sales/orders', payload);
      id = data.id;
    }
    if (andConfirm) await http.post(`/api/sales/orders/${id}/confirm`);
    ElMessage.success(andConfirm ? '已保存并确认' : '已保存');
    await router.push({ name: 'sales-orders' });
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

const goBack = () => void router.push({ name: 'sales-orders' });

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

.head {
  max-width: 720px;
}

.customer {
  width: 320px;
}

.remark {
  width: 480px;
}

.full {
  width: 100%;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.total {
  font-weight: 600;
}
</style>