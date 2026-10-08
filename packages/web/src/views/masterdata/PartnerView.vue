<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索编码 / 名称"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select v-model="type" class="type" placeholder="类型" clearable @change="reload">
        <el-option label="客户" value="customer" />
        <el-option label="供应商" value="supplier" />
        <el-option label="客户 + 供应商" value="both" />
      </el-select>
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="openCreate">新建单位</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="code" label="编码" width="140" />
      <el-table-column prop="name" label="名称" min-width="180" />
      <el-table-column label="类型" width="130">
        <template #default="{ row }">{{ TYPE_LABEL[row.type as PartnerType] }}</template>
      </el-table-column>
      <el-table-column prop="contact" label="联系人" width="120" />
      <el-table-column prop="phone" label="电话" width="150" />
      <el-table-column prop="address" label="地址" min-width="180" show-overflow-tooltip />
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

    <el-pagination
      v-model:current-page="page"
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="pageSize"
      @current-change="load"
    />
  </el-card>

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑单位' : '新建单位'" width="520px">
    <el-form :model="form" label-width="90px">
      <el-form-item label="编码" required>
        <el-input v-model="form.code" maxlength="50" />
      </el-form-item>
      <el-form-item label="名称" required>
        <el-input v-model="form.name" maxlength="100" />
      </el-form-item>
      <el-form-item label="类型" required>
        <el-select v-model="form.type">
          <el-option label="客户" value="customer" />
          <el-option label="供应商" value="supplier" />
          <el-option label="客户 + 供应商" value="both" />
        </el-select>
      </el-form-item>
      <el-form-item label="联系人"><el-input v-model="form.contact" maxlength="50" /></el-form-item>
      <el-form-item label="电话"><el-input v-model="form.phone" maxlength="30" /></el-form-item>
      <el-form-item label="地址"><el-input v-model="form.address" maxlength="200" /></el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.is_active" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import type { PartnerType } from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface PartnerRow {
  id: number;
  code: string;
  name: string;
  type: PartnerType;
  contact: string | null;
  phone: string | null;
  address: string | null;
  is_active: number;
}

const TYPE_LABEL: Record<PartnerType, string> = {
  customer: '客户',
  supplier: '供应商',
  both: '客户 + 供应商',
};

const auth = useAuthStore();
const canManage = computed(() => auth.has('masterdata.partner.manage'));

const rows = ref<PartnerRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const type = ref<PartnerType | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);
const dialogVisible = ref(false);
const editing = ref<PartnerRow | null>(null);
const form = reactive({
  code: '',
  name: '',
  type: 'customer' as PartnerType,
  contact: '',
  phone: '',
  address: '',
  is_active: true,
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<PartnerRow[]>('/api/masterdata/partners', {
      keyword: keyword.value,
      type: type.value,
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

function openCreate(): void {
  editing.value = null;
  Object.assign(form, {
    code: '',
    name: '',
    type: 'customer',
    contact: '',
    phone: '',
    address: '',
    is_active: true,
  });
  dialogVisible.value = true;
}

function openEdit(row: PartnerRow): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    type: row.type,
    contact: row.contact ?? '',
    phone: row.phone ?? '',
    address: row.address ?? '',
    is_active: row.is_active === 1,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.code.trim() || !form.name.trim()) {
    ElMessage.warning('请填写编码与名称');
    return;
  }
  saving.value = true;
  const payload = {
    code: form.code,
    name: form.name,
    type: form.type,
    contact: form.contact,
    phone: form.phone,
    address: form.address,
    is_active: form.is_active ? 1 : 0,
  };
  try {
    if (editing.value) await http.patch(`/api/masterdata/partners/${editing.value.id}`, payload);
    else await http.post('/api/masterdata/partners', payload);
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: PartnerRow): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除「${row.name}」？若已有业务单据引用将无法删除，可改为停用。`,
    '删除确认',
    { type: 'warning' },
  );
  try {
    await http.del(`/api/masterdata/partners/${row.id}`);
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
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 220px;
}

.type {
  width: 160px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>