<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-button v-if="canManage" type="primary" @click="openCreate">新建仓库</el-button>
      <span class="hint">类型决定在途口径：工厂 / 仓库参与库存计算，港口默认仅作为在途节点</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="code" label="编码" width="140" />
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="typeTag(row.type)">{{ typeLabel(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="parent_name" label="上级" width="140" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.is_active ? 'success' : 'info'">
            {{ row.is_active ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑仓库' : '新建仓库'" width="480px">
    <el-form :model="form" label-width="90px">
      <el-form-item label="编码" required>
        <el-input v-model="form.code" maxlength="50" />
      </el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="form.name" maxlength="100" />
      </el-form-item>
      <el-form-item label="类型" required>
        <el-select v-model="form.type">
          <el-option v-for="type in WAREHOUSE_TYPES" :key="type" :label="TYPE_LABEL[type]" :value="type" />
        </el-select>
      </el-form-item>
      <el-form-item label="上级">
        <el-select v-model="form.parent_id" clearable placeholder="无">
          <el-option
            v-for="option in parentOptions"
            :key="option.id"
            :label="`${option.code} ${option.name}`"
            :value="option.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.is_active" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { PERMISSIONS, WAREHOUSE_TYPES, type WarehouseType } from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface WarehouseRow {
  id: number;
  code: string;
  name: string;
  type: WarehouseType;
  parent_id: number | null;
  parent_name: string | null;
  is_active: number;
}

const TYPE_LABEL: Record<WarehouseType, string> = {
  plant: '工厂',
  warehouse: '仓库',
  port: '港口',
};
const TYPE_TAG: Record<WarehouseType, 'primary' | 'success' | 'warning'> = {
  plant: 'primary',
  warehouse: 'success',
  port: 'warning',
};

const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.masterdataWarehouseManage));

function typeLabel(value: unknown): string {
  return TYPE_LABEL[value as WarehouseType] ?? String(value);
}

function typeTag(value: unknown): 'primary' | 'success' | 'warning' {
  return TYPE_TAG[value as WarehouseType] ?? 'primary';
}

const rows = ref<WarehouseRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editing = ref<WarehouseRow | null>(null);
const form = reactive({
  code: '',
  name: '',
  type: 'warehouse' as WarehouseType,
  parent_id: null as number | null,
  is_active: true,
});

const parentOptions = computed(() => rows.value.filter((row) => row.id !== editing.value?.id));

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<WarehouseRow[]>('/api/masterdata/warehouses');
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, { code: '', name: '', type: 'warehouse', parent_id: null, is_active: true });
  dialogVisible.value = true;
}

function openEdit(row: WarehouseRow): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    type: row.type,
    parent_id: row.parent_id,
    is_active: row.is_active === 1,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.code.trim() || !form.name.trim()) {
    ElMessage.warning('请填写仓库编码与名称');
    return;
  }
  saving.value = true;
  const payload = {
    code: form.code,
    name: form.name,
    type: form.type,
    parent_id: form.parent_id,
    is_active: form.is_active ? 1 : 0,
  };
  try {
    if (editing.value) await http.patch(`/api/masterdata/warehouses/${editing.value.id}`, payload);
    else await http.post('/api/masterdata/warehouses', payload);
    dialogVisible.value = false;
    await load();
  } catch {
    // 错误提示已在 api client 中统一弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: WarehouseRow): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除仓库「${row.name}」？若已有业务单据引用将无法删除，可改为停用。`,
    '删除确认',
    { type: 'warning' },
  );
  try {
    await http.del(`/api/masterdata/warehouses/${row.id}`);
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.hint {
  font-size: 12px;
  color: #909399;
}
</style>