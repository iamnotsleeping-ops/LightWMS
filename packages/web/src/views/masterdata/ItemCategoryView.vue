<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索编码 / 名称"
        clearable
        class="search"
        @keyup.enter="load"
        @clear="load"
      />
      <el-button @click="load">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="openCreate">新建分类</el-button>
    </div>

    <el-table v-loading="loading" :data="filtered" border stripe>
      <el-table-column prop="code" label="编码" width="140" />
      <el-table-column prop="name" label="名称" min-width="160" />
      <el-table-column prop="capacity_group" label="产能归类" width="140" />
      <el-table-column prop="parent_name" label="上级分类" width="140" />
      <el-table-column prop="item_count" label="物料数" width="90" align="right" />
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

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑分类' : '新建分类'" width="480px">
    <el-form :model="form" label-width="90px">
      <el-form-item label="编码"><el-input v-model="form.code" maxlength="50" /></el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="form.name" maxlength="100" />
      </el-form-item>
      <el-form-item label="产能归类">
        <el-input v-model="form.capacity_group" maxlength="50" />
      </el-form-item>
      <el-form-item label="上级分类">
        <el-select v-model="form.parent_id" clearable placeholder="无">
          <el-option
            v-for="option in parentOptions"
            :key="option.id"
            :label="`${option.code ?? ''} ${option.name}`"
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
import { PERMISSIONS } from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { confirmAction } from '@/utils/confirm';

interface CategoryRow {
  id: number;
  code: string | null;
  name: string;
  capacity_group: string | null;
  parent_id: number | null;
  parent_name: string | null;
  is_active: number;
  item_count: number;
}

const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.masterdataCategoryManage));

const rows = ref<CategoryRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const dialogVisible = ref(false);
const editing = ref<CategoryRow | null>(null);
const form = reactive({
  code: '',
  name: '',
  capacity_group: '',
  parent_id: null as number | null,
  is_active: true,
});

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return rows.value;
  return rows.value.filter(
    (row) =>
      (row.code ?? '').toLowerCase().includes(text) || row.name.toLowerCase().includes(text),
  );
});

const parentOptions = computed(() =>
  rows.value.filter((row) => row.id !== editing.value?.id && row.is_active === 1),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<CategoryRow[]>('/api/masterdata/categories');
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, { code: '', name: '', capacity_group: '', parent_id: null, is_active: true });
  dialogVisible.value = true;
}

function openEdit(row: CategoryRow): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code ?? '',
    name: row.name,
    capacity_group: row.capacity_group ?? '',
    parent_id: row.parent_id,
    is_active: row.is_active === 1,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写分类名称');
    return;
  }
  saving.value = true;
  const payload = {
    code: form.code,
    name: form.name,
    capacity_group: form.capacity_group,
    parent_id: form.parent_id,
    is_active: form.is_active ? 1 : 0,
  };
  try {
    if (editing.value) await http.patch(`/api/masterdata/categories/${editing.value.id}`, payload);
    else await http.post('/api/masterdata/categories', payload);
    dialogVisible.value = false;
    await load();
  } catch {
    // 错误提示已在 api client 中统一弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: CategoryRow): Promise<void> {
  if (!(await confirmAction(`确认删除分类「${row.name}」？`, '删除确认'))) return;
  try {
    await http.del(`/api/masterdata/categories/${row.id}`);
    await load();
  } catch {
    // 已被物料引用时会返回 409，提示已在 api client 中弹出
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 240px;
}
</style>