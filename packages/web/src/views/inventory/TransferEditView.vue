<template>
  <el-card shadow="never" v-loading="loading">
    <template #header>
      <div class="header">
        <span>{{ isEdit ? `编辑调拨单 ${orderNo}` : '新建调拨单' }}</span>
        <div>
          <el-button @click="goBack">返回</el-button>
          <el-button type="primary" plain :loading="saving" @click="save(false)">保存草稿</el-button>
          <el-button type="primary" :loading="saving" @click="save(true)">保存并确认</el-button>
        </div>
      </div>
    </template>

    <el-form :model="form" label-width="90px" class="head">
      <el-form-item label="调出仓库" required>
        <el-select v-model="form.from_warehouse_id" placeholder="选择调出仓库" class="warehouse">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="调入仓库" required>
        <el-select v-model="form.to_warehouse_id" placeholder="选择调入仓库" class="warehouse">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="调拨日期" required>
        <el-date-picker v-model="form.order_date" type="date" value-format="YYYY-MM-DD" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" maxlength="500" class="remark" />
      </el-form-item>
    </el-form>

    <el-table :data="form.items" border>
      <el-table-column type="index" label="#" width="50" />
      <el-table-column label="物料" min-width="260">
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
      <el-table-column label="调拨数量" width="160">
        <template #default="{ row }">
          <el-input-number v-model="row.quantity" :min="1" :precision="0" :controls="false" class="full" />
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
      <span class="hint">发货时按调出仓库当前平均成本结转，调入仓库按结转成本入账</span>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { http } from '@/api/client';

interface Option {
  id: number;
  code: string;
  name: string;
}

interface EditableItem {
  product_id: number | undefined;
  quantity: number;
}

interface OrderDetailItem {
  product_id: number;
  quantity: number;
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

const form = reactive({
  from_warehouse_id: undefined as number | undefined,
  to_warehouse_id: undefined as number | undefined,
  order_date: new Date().toISOString().slice(0, 10),
  remark: '',
  items: [newRow()] as EditableItem[],
});

function newRow(): EditableItem {
  return { product_id: undefined, quantity: 1 };
}

function addRow(): void {
  form.items.push(newRow());
}

function removeRow(index: number): void {
  form.items.splice(index, 1);
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
      order: {
        order_no: string;
        from_warehouse_id: number;
        to_warehouse_id: number;
        order_date: string;
        remark: string | null;
      };
      items: OrderDetailItem[];
    }>(`/api/inventory/transfers/${route.params.id}`);
    orderNo.value = data.order.order_no;
    form.from_warehouse_id = data.order.from_warehouse_id;
    form.to_warehouse_id = data.order.to_warehouse_id;
    form.order_date = data.order.order_date;
    form.remark = data.order.remark ?? '';
    form.items = data.items.map((item) => ({
      product_id: item.product_id,
      quantity: item.quantity,
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
  } finally {
    loading.value = false;
  }
}

function buildPayload() {
  if (!form.from_warehouse_id) throw new Error('请选择调出仓库');
  if (!form.to_warehouse_id) throw new Error('请选择调入仓库');
  if (form.from_warehouse_id === form.to_warehouse_id) throw new Error('调出与调入仓库不能相同');
  if (!form.order_date) throw new Error('请选择调拨日期');
  const items = form.items.map((row, index) => {
    if (!row.product_id) throw new Error(`第 ${index + 1} 行未选择物料`);
    if (!row.quantity || row.quantity <= 0) throw new Error(`第 ${index + 1} 行数量须大于 0`);
    return { product_id: row.product_id, quantity: row.quantity };
  });
  return {
    from_warehouse_id: form.from_warehouse_id,
    to_warehouse_id: form.to_warehouse_id,
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
      await http.patch(`/api/inventory/transfers/${id}`, payload);
    } else {
      const { data } = await http.post<{ id: number }>('/api/inventory/transfers', payload);
      id = data.id;
    }
    if (andConfirm) {
      await http.post(`/api/inventory/transfers/${id}/confirm`);
      ElMessage.success('已保存并确认');
    } else {
      ElMessage.success('已保存');
    }
    void router.push({ name: 'transfer-detail', params: { id } });
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

const goBack = () => void router.push({ name: 'transfers' });

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
  margin-bottom: 12px;
}

.warehouse {
  width: 220px;
}

.remark {
  width: 320px;
}

.full {
  width: 100%;
}

.footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.hint {
  font-size: 12px;
  color: #909399;
}
</style>