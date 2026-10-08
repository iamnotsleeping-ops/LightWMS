<template>
  <el-card shadow="never" class="block">
    <template #header>
      <div class="header">
        <span>当前预警</span>
        <el-tag v-if="alerts.length > 0" type="danger" size="small">{{ alerts.length }} 条</el-tag>
        <el-tag v-else type="success" size="small">暂无预警</el-tag>
      </div>
    </template>

    <div class="toolbar">
      <el-input
        v-model="alertKeyword"
        placeholder="搜索物料编码 / 名称"
        clearable
        class="search"
        @keyup.enter="loadAlerts"
        @clear="loadAlerts"
      />
      <el-select v-model="alertWarehouseId" class="warehouse" placeholder="仓库" clearable @change="loadAlerts">
        <el-option
          v-for="item in warehouses"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-select v-model="alertType" class="type" placeholder="预警类型" clearable @change="loadAlerts">
        <el-option
          v-for="item in ALERT_TYPES"
          :key="item"
          :label="ALERT_TYPE_LABELS[item]"
          :value="item"
        />
      </el-select>
      <el-button @click="loadAlerts">查询</el-button>
    </div>

    <el-table v-loading="alertLoading" :data="alerts" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="140" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column label="范围" width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.warehouse_name ?? '全局（跨仓汇总）' }}</template>
      </el-table-column>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="row.alert_type === 'below_min' ? 'danger' : 'warning'">
            {{ ALERT_TYPE_LABELS[row.alert_type as AlertType] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="当前可用量" width="130" align="right">
        <template #default="{ row }">{{ formatQty(row.current_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="下限" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.min_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="上限" width="120" align="right">
        <template #default="{ row }">
          {{ row.max_qty === null ? '—' : formatQty(row.max_qty, row.qty_precision) }}
        </template>
      </el-table-column>
      <el-table-column prop="base_unit" label="单位" width="80" />
    </el-table>
  </el-card>

  <el-card shadow="never" class="block">
    <template #header>
      <div class="header">
        <span>预警规则</span>
        <el-button v-if="canManage" type="primary" size="small" @click="openCreate">新增规则</el-button>
      </div>
    </template>

    <div class="toolbar">
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
      <el-select v-model="onlyActive" class="type" placeholder="状态" clearable @change="reload">
        <el-option label="仅启用" :value="'1'" />
        <el-option label="仅停用" :value="'0'" />
      </el-select>
      <el-button @click="reload">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="rules" border stripe>
      <el-table-column prop="product_code" label="物料编码" width="140" />
      <el-table-column prop="product_name" label="物料描述" min-width="180" show-overflow-tooltip />
      <el-table-column label="范围" width="160" show-overflow-tooltip>
        <template #default="{ row }">{{ row.warehouse_name ?? '全局（跨仓汇总）' }}</template>
      </el-table-column>
      <el-table-column label="下限" width="120" align="right">
        <template #default="{ row }">{{ formatQty(row.min_qty, row.qty_precision) }}</template>
      </el-table-column>
      <el-table-column label="上限" width="120" align="right">
        <template #default="{ row }">
          {{ row.max_qty === null ? '—' : formatQty(row.max_qty, row.qty_precision) }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.is_active ? 'success' : 'info'">
            {{ row.is_active ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="170">
        <template #default="{ row }">{{ readTime(row.updated_at) }}</template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
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

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑预警规则' : '新增预警规则'" width="520px">
    <el-form :model="form" label-width="90px">
      <el-form-item label="物料" required>
        <el-select
          v-model="form.item_id"
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
      </el-form-item>
      <el-form-item label="范围">
        <el-select v-model="form.warehouse_id" placeholder="全局（跨仓汇总）" clearable class="full">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
        <div class="hint">留空表示全局规则，按该物料所有仓库可用量汇总判断</div>
      </el-form-item>
      <el-form-item label="下限" required>
        <el-input-number v-model="form.min_qty" :min="0" :precision="0" :controls="false" class="full" />
      </el-form-item>
      <el-form-item label="启用上限">
        <el-switch v-model="form.hasMax" />
      </el-form-item>
      <el-form-item v-if="form.hasMax" label="上限">
        <el-input-number v-model="form.max_qty" :min="0" :precision="0" :controls="false" class="full" />
      </el-form-item>
      <el-form-item label="状态">
        <el-switch v-model="form.is_active" active-text="启用" inactive-text="停用" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import {
  ALERT_TYPES,
  ALERT_TYPE_LABELS,
  PERMISSIONS,
  type AlertType,
} from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { formatQty } from '@/utils/format';

interface Option {
  id: number;
  code: string;
  name: string;
}

interface AlertRow {
  rule_id: number;
  item_id: number;
  product_code: string;
  product_name: string;
  base_unit: string;
  qty_precision: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  current_qty: number;
  min_qty: number;
  max_qty: number | null;
  alert_type: AlertType;
}

interface RuleRow {
  id: number;
  item_id: number;
  product_code: string;
  product_name: string;
  qty_precision: number;
  warehouse_id: number | null;
  warehouse_name: string | null;
  min_qty: number;
  max_qty: number | null;
  is_active: number;
  updated_at: string;
}

const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.inventoryAlertManage));

const warehouses = ref<Option[]>([]);
const itemOptions = ref<Option[]>([]);
const itemLoading = ref(false);

// 当前预警
const alerts = ref<AlertRow[]>([]);
const alertLoading = ref(false);
const alertKeyword = ref('');
const alertWarehouseId = ref<number | undefined>(undefined);
const alertType = ref<AlertType | undefined>(undefined);

// 规则列表
const rules = ref<RuleRow[]>([]);
const loading = ref(false);
const keyword = ref('');
const warehouseId = ref<number | undefined>(undefined);
const onlyActive = ref<string | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

// 对话框
const dialogVisible = ref(false);
const editingId = ref<number | null>(null);
const saving = ref(false);
const form = reactive({
  item_id: undefined as number | undefined,
  warehouse_id: null as number | null,
  min_qty: 0,
  hasMax: false,
  max_qty: 0,
  is_active: true,
});

function readTime(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
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

async function loadAlerts(): Promise<void> {
  alertLoading.value = true;
  try {
    const { data } = await http.get<AlertRow[]>('/api/inventory/alerts', {
      keyword: alertKeyword.value || undefined,
      warehouseId: alertWarehouseId.value,
      alertType: alertType.value,
    });
    alerts.value = data;
  } finally {
    alertLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<RuleRow[]>('/api/inventory/alert-rules', {
      page: page.value,
      pageSize,
      keyword: keyword.value || undefined,
      warehouseId: warehouseId.value,
      onlyActive: onlyActive.value,
    });
    rules.value = data;
    total.value = info?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  page.value = 1;
  void load();
}

async function refreshAll(): Promise<void> {
  await Promise.all([load(), loadAlerts()]);
}

function openCreate(): void {
  editingId.value = null;
  form.item_id = undefined;
  form.warehouse_id = null;
  form.min_qty = 0;
  form.hasMax = false;
  form.max_qty = 0;
  form.is_active = true;
  dialogVisible.value = true;
}

function openEdit(row: RuleRow): void {
  editingId.value = row.id;
  form.item_id = row.item_id;
  form.warehouse_id = row.warehouse_id;
  form.min_qty = row.min_qty;
  form.hasMax = row.max_qty !== null;
  form.max_qty = row.max_qty ?? 0;
  form.is_active = row.is_active === 1;
  if (!itemOptions.value.some((item) => item.id === row.item_id)) {
    itemOptions.value.push({ id: row.item_id, code: row.product_code, name: row.product_name });
  }
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  if (!form.item_id) {
    ElMessage.warning('请选择物料');
    return;
  }
  if (form.hasMax && form.max_qty < form.min_qty) {
    ElMessage.warning('上限不能小于下限');
    return;
  }
  const payload = {
    item_id: form.item_id,
    warehouse_id: form.warehouse_id ?? null,
    min_qty: form.min_qty,
    max_qty: form.hasMax ? form.max_qty : null,
    is_active: form.is_active,
  };
  saving.value = true;
  try {
    if (editingId.value) {
      await http.patch(`/api/inventory/alert-rules/${editingId.value}`, payload);
    } else {
      await http.post('/api/inventory/alert-rules', payload);
    }
    ElMessage.success('已保存');
    dialogVisible.value = false;
    await refreshAll();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: RuleRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${row.product_name}」${row.warehouse_name ? `（${row.warehouse_name}）` : '（全局）'} 的预警规则？`,
      '删除预警规则',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  await http.del(`/api/inventory/alert-rules/${row.id}`);
  ElMessage.success('已删除');
  await refreshAll();
}

onMounted(async () => {
  const [warehouseRes, itemRes] = await Promise.all([
    http.get<Option[]>('/api/masterdata/warehouses', { pageSize: 200 }),
    http.get<Option[]>('/api/masterdata/items', { isActive: '1', pageSize: 200 }),
  ]);
  warehouses.value = warehouseRes.data;
  itemOptions.value = itemRes.data;
  await refreshAll();
});
</script>

<style scoped>
.block + .block {
  margin-top: 16px;
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.search {
  width: 200px;
}

.warehouse {
  width: 180px;
}

.type {
  width: 140px;
}

.full {
  width: 100%;
}

.hint {
  font-size: 12px;
  color: #909399;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>