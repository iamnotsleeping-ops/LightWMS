<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索姓名 / 手机 / 邮箱"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="openCreate">新建用户</el-button>
      <span class="hint">钉钉扫码登录会自动建号，新用户默认无角色，需在此分配后方可进入系统</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="name" label="姓名" width="160" />
      <el-table-column prop="mobile" label="手机" width="150" />
      <el-table-column prop="email" label="邮箱" min-width="180" />
      <el-table-column label="角色" min-width="200">
        <template #default="{ row }">
          <el-tag v-for="role in row.roles" :key="role.id" class="tag" size="small">
            {{ role.name }}
          </el-tag>
          <span v-if="row.roles.length === 0" class="warn">未分配角色</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.is_active ? 'success' : 'info'">
            {{ row.is_active ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近登录" width="180">
        <template #default="{ row }">{{ formatTime(row.last_login_at) }}</template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="openRoles(row)">分配角色</el-button>
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

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑用户' : '新建用户'" width="480px">
    <el-form :model="form" label-width="80px">
      <el-form-item label="姓名" required><el-input v-model="form.name" maxlength="50" /></el-form-item>
      <el-form-item label="手机"><el-input v-model="form.mobile" maxlength="20" /></el-form-item>
      <el-form-item label="邮箱"><el-input v-model="form.email" maxlength="100" /></el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.is_active" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="roleVisible" :title="`分配角色 · ${roleTarget?.name ?? ''}`" width="480px">
    <el-checkbox-group v-model="selectedRoleIds" class="roles">
      <el-checkbox v-for="role in roles" :key="role.id" :value="role.id" class="role-item">
        {{ role.name }}
        <span v-if="role.description" class="sub">{{ role.description }}</span>
      </el-checkbox>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="roleVisible = false">取消</el-button>
      <el-button type="primary" :loading="roleSaving" @click="saveRoles">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface UserRow {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  is_active: number;
  last_login_at: string | null;
  roles: { id: number; code: string; name: string }[];
}

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
}

const auth = useAuthStore();
const canManage = computed(() => auth.has('system.user.manage'));

const rows = ref<UserRow[]>([]);
const roles = ref<RoleRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const dialogVisible = ref(false);
const editing = ref<UserRow | null>(null);
const form = reactive({ name: '', mobile: '', email: '', is_active: true });

const roleVisible = ref(false);
const roleSaving = ref(false);
const roleTarget = ref<UserRow | null>(null);
const selectedRoleIds = ref<number[]>([]);

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<UserRow[]>('/api/system/users', {
      keyword: keyword.value,
      page: page.value,
      pageSize,
    });
    rows.value = data;
    total.value = info?.total ?? 0;
  } finally {
    loading.value = false;
  }
}

function reload(): void {
  page.value = 1;
  void load();
}

async function loadRoles(): Promise<void> {
  const { data } = await http.get<RoleRow[]>('/api/system/roles');
  roles.value = data;
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, { name: '', mobile: '', email: '', is_active: true });
  dialogVisible.value = true;
}

function openEdit(row: UserRow): void {
  editing.value = row;
  Object.assign(form, {
    name: row.name,
    mobile: row.mobile ?? '',
    email: row.email ?? '',
    is_active: row.is_active === 1,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    ElMessage.warning('请填写姓名');
    return;
  }
  saving.value = true;
  const payload = {
    name: form.name,
    mobile: form.mobile,
    email: form.email,
    is_active: form.is_active,
  };
  try {
    if (editing.value) await http.patch(`/api/system/users/${editing.value.id}`, payload);
    else await http.post('/api/system/users', payload);
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

function openRoles(row: UserRow): void {
  roleTarget.value = row;
  selectedRoleIds.value = row.roles.map((role) => role.id);
  roleVisible.value = true;
}

async function saveRoles(): Promise<void> {
  if (!roleTarget.value) return;
  roleSaving.value = true;
  try {
    await http.put(`/api/system/users/${roleTarget.value.id}/roles`, {
      roleIds: selectedRoleIds.value,
    });
    roleVisible.value = false;
    await load();
    ElMessage.success('角色已更新');
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    roleSaving.value = false;
  }
}

onMounted(async () => {
  await Promise.all([load(), loadRoles()]);
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
  width: 220px;
}

.hint {
  font-size: 12px;
  color: #909399;
}

.tag {
  margin-right: 4px;
}

.warn {
  color: #e6a23c;
  font-size: 12px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.roles {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.role-item {
  height: auto;
}

.sub {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}
</style>