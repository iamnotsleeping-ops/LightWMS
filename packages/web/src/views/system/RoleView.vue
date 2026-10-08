<template>
  <el-row :gutter="16">
    <el-col :span="9">
      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <span>角色</span>
            <el-button v-if="canManage" type="primary" size="small" @click="openCreate">新建角色</el-button>
          </div>
        </template>
        <el-table
          v-loading="loading"
          :data="roles"
          highlight-current-row
          @current-change="selectRole"
        >
          <el-table-column prop="name" label="名称" min-width="120" />
          <el-table-column prop="code" label="编码" width="140" />
          <el-table-column prop="user_count" label="用户数" width="80" align="right" />
          <el-table-column v-if="canManage" label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click.stop="openEdit(row)">编辑</el-button>
              <el-button link type="danger" @click.stop="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </el-col>

    <el-col :span="15">
      <el-card shadow="never">
        <template #header>
          <div class="card-header">
            <span>权限 · {{ current?.name ?? '请选择角色' }}</span>
            <el-button
              v-if="canManage && current"
              type="primary"
              size="small"
              :loading="saving"
              @click="savePermissions"
            >
              保存权限
            </el-button>
          </div>
        </template>

        <el-empty v-if="!current" description="请先在左侧选择角色" />
        <div v-else class="groups">
          <div v-for="group in groupedPermissions" :key="group.module" class="group">
            <div class="group-title">{{ MODULE_LABEL[group.module] ?? group.module }}</div>
            <el-checkbox-group v-model="checkedIds">
              <el-checkbox v-for="item in group.items" :key="item.id" :value="item.id" :disabled="!canManage">
                {{ item.name }}
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </div>
      </el-card>
    </el-col>
  </el-row>

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑角色' : '新建角色'" width="480px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="编码" required>
        <el-input v-model="form.code" :disabled="Boolean(editing)" placeholder="小写字母开头，如 buyer_assistant" />
      </el-form-item>
      <el-form-item label="名称" required><el-input v-model="form.name" maxlength="50" /></el-form-item>
      <el-form-item label="说明"><el-input v-model="form.description" maxlength="200" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="formSaving" @click="saveRole">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  user_count: number;
  permissionIds: number[];
}

interface PermissionRow {
  id: number;
  code: string;
  name: string;
  module: string;
}

const MODULE_LABEL: Record<string, string> = {
  masterdata: '基础资料',
  purchase: '采购管理',
  sales: '销售管理',
  inventory: '库存管理',
  report: '报表',
  system: '系统设置',
};

const auth = useAuthStore();
const canManage = computed(() => auth.has('system.role.manage'));

const roles = ref<RoleRow[]>([]);
const permissions = ref<PermissionRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const formSaving = ref(false);
const current = ref<RoleRow | null>(null);
const checkedIds = ref<number[]>([]);

const dialogVisible = ref(false);
const editing = ref<RoleRow | null>(null);
const form = reactive({ code: '', name: '', description: '' });

const groupedPermissions = computed(() => {
  const groups: { module: string; items: PermissionRow[] }[] = [];
  for (const item of permissions.value) {
    let group = groups.find((entry) => entry.module === item.module);
    if (!group) {
      group = { module: item.module, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [roleRes, permissionRes] = await Promise.all([
      http.get<RoleRow[]>('/api/system/roles'),
      http.get<PermissionRow[]>('/api/system/permissions'),
    ]);
    roles.value = roleRes.data;
    permissions.value = permissionRes.data;

    const keep = current.value ? roles.value.find((role) => role.id === current.value?.id) : null;
    current.value = keep ?? roles.value[0] ?? null;
    checkedIds.value = current.value?.permissionIds ?? [];
  } finally {
    loading.value = false;
  }
}

function selectRole(row: RoleRow | null): void {
  current.value = row;
  checkedIds.value = row?.permissionIds ?? [];
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, { code: '', name: '', description: '' });
  dialogVisible.value = true;
}

function openEdit(row: RoleRow): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
  });
  dialogVisible.value = true;
}

async function saveRole(): Promise<void> {
  if (!editing.value && !form.code.trim()) {
    ElMessage.warning('请填写角色编码');
    return;
  }
  if (!form.name.trim()) {
    ElMessage.warning('请填写角色名称');
    return;
  }
  formSaving.value = true;
  try {
    if (editing.value) {
      await http.patch(`/api/system/roles/${editing.value.id}`, {
        name: form.name,
        description: form.description,
      });
    } else {
      await http.post('/api/system/roles', {
        code: form.code,
        name: form.name,
        description: form.description,
      });
    }
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    formSaving.value = false;
  }
}

async function savePermissions(): Promise<void> {
  if (!current.value) return;
  saving.value = true;
  try {
    await http.put(`/api/system/roles/${current.value.id}/permissions`, {
      permissionIds: checkedIds.value,
    });
    await load();
    ElMessage.success('权限已保存');
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: RoleRow): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除角色「${row.name}」？已分配给用户的角色需先解除分配。`,
    '删除确认',
    { type: 'warning' },
  );
  try {
    await http.del(`/api/system/roles/${row.id}`);
    if (current.value?.id === row.id) current.value = null;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

onMounted(load);
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.group-title {
  font-weight: 600;
  margin-bottom: 8px;
}

.group :deep(.el-checkbox) {
  width: 220px;
  margin-right: 0;
}
</style>