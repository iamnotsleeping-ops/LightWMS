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
      <el-select v-model="categoryId" class="category" placeholder="物料分类" clearable @change="reload">
        <el-option
          v-for="category in categories"
          :key="category.id"
          :label="`${category.code ?? ''} ${category.name}`"
          :value="category.id"
        />
      </el-select>
      <el-select v-model="isActive" class="state" placeholder="状态" clearable @change="reload">
        <el-option label="启用" value="1" />
        <el-option label="停用" value="0" />
      </el-select>
      <el-button @click="reload">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="openCreate">新建物料</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="code" label="物料编码" width="150" />
      <el-table-column prop="name" label="物料描述" min-width="200" show-overflow-tooltip />
      <el-table-column prop="base_unit" label="基本单位" width="100" />
      <el-table-column label="分类" min-width="140">
        <template #default="{ row }">
          {{ row.category_name ?? '—' }}
          <el-tag v-if="row.capacity_group" size="small" type="info">{{ row.capacity_group }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="qty_precision" label="数量小数位" width="110" align="right" />
      <el-table-column label="检验" width="100">
        <template #default="{ row }">
          <el-tag :type="row.inspection_required ? 'warning' : 'success'" size="small">
            {{ row.inspection_required ? '需检验' : '免检' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.is_active ? 'success' : 'info'">
            {{ row.is_active ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" @click="openCertification(row)">客户认证</el-button>
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

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑物料' : '新建物料'" width="560px">
    <el-form :model="form" label-width="110px">
      <el-form-item label="物料编码" required>
        <el-input v-model="form.code" maxlength="50" />
      </el-form-item>
      <el-form-item label="物料描述" required>
        <el-input v-model="form.name" maxlength="200" />
      </el-form-item>
      <el-form-item label="基本单位" required>
        <el-input v-model="form.base_unit" maxlength="20" placeholder="件 / 千克 / 米" />
      </el-form-item>
      <el-form-item label="物料分类">
        <el-select v-model="form.category_id" clearable placeholder="无">
          <el-option
            v-for="category in categories"
            :key="category.id"
            :label="`${category.code ?? ''} ${category.name}`"
            :value="category.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="数量小数位">
        <el-input-number v-model="form.qty_precision" :min="0" :max="6" />
      </el-form-item>
      <el-form-item label="是否免检">
        <el-switch v-model="form.inspection_required" active-text="需检验" inactive-text="免检" />
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.is_active" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="certVisible" title="需客户认证的客户" width="520px">
    <p class="hint">
      物料「{{ certificationItem?.name }}」需要以下客户认证；留空表示无客户认证要求。
    </p>
    <el-select v-model="certCustomerIds" multiple filterable class="cert-select" placeholder="选择客户">
      <el-option
        v-for="customer in customers"
        :key="customer.id"
        :label="`${customer.code} ${customer.name}`"
        :value="customer.id"
      />
    </el-select>
    <template #footer>
      <el-button @click="certVisible = false">取消</el-button>
      <el-button type="primary" :loading="certSaving" @click="saveCertification">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { PERMISSIONS } from '@light-erp/shared';
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface ItemRow {
  id: number;
  code: string;
  name: string;
  base_unit: string;
  category_id: number | null;
  category_name: string | null;
  capacity_group: string | null;
  is_active: number;
  qty_precision: number;
  inspection_required: number;
}

interface CategoryOption {
  id: number;
  code: string | null;
  name: string;
  is_active: number;
}

interface CustomerOption {
  id: number;
  code: string;
  name: string;
}

const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.masterdataItemManage));

const rows = ref<ItemRow[]>([]);
const categories = ref<CategoryOption[]>([]);
const customers = ref<CustomerOption[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const categoryId = ref<number | undefined>(undefined);
const isActive = ref<'0' | '1' | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const dialogVisible = ref(false);
const editing = ref<ItemRow | null>(null);
const form = reactive({
  code: '',
  name: '',
  base_unit: '',
  category_id: null as number | null,
  qty_precision: 0,
  inspection_required: false,
  is_active: true,
});

const certVisible = ref(false);
const certSaving = ref(false);
const certificationItem = ref<ItemRow | null>(null);
const certCustomerIds = ref<number[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data, page: info } = await http.get<ItemRow[]>('/api/masterdata/items', {
      keyword: keyword.value,
      categoryId: categoryId.value,
      isActive: isActive.value,
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

async function loadOptions(): Promise<void> {
  const [categoryRes, customerRes] = await Promise.all([
    http.get<CategoryOption[]>('/api/masterdata/categories'),
    http.get<CustomerOption[]>('/api/masterdata/partners', {
      type: 'customer',
      isActive: '1',
      pageSize: 200,
    }),
  ]);
  categories.value = categoryRes.data;
  customers.value = customerRes.data;
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, {
    code: '',
    name: '',
    base_unit: '',
    category_id: null,
    qty_precision: 0,
    inspection_required: false,
    is_active: true,
  });
  dialogVisible.value = true;
}

function openEdit(row: ItemRow): void {
  editing.value = row;
  Object.assign(form, {
    code: row.code,
    name: row.name,
    base_unit: row.base_unit,
    category_id: row.category_id,
    qty_precision: row.qty_precision,
    inspection_required: row.inspection_required === 1,
    is_active: row.is_active === 1,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.code.trim() || !form.name.trim() || !form.base_unit.trim()) {
    ElMessage.warning('请填写物料编码、描述与基本单位');
    return;
  }
  saving.value = true;
  const payload = {
    code: form.code,
    name: form.name,
    base_unit: form.base_unit,
    category_id: form.category_id,
    qty_precision: form.qty_precision,
    inspection_required: form.inspection_required ? 1 : 0,
    is_active: form.is_active ? 1 : 0,
  };
  try {
    if (editing.value) await http.patch(`/api/masterdata/items/${editing.value.id}`, payload);
    else await http.post('/api/masterdata/items', payload);
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: ItemRow): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除物料「${row.name}」？若已有单据或 BOM 引用将无法删除，可改为停用。`,
    '删除确认',
    { type: 'warning' },
  );
  try {
    await http.del(`/api/masterdata/items/${row.id}`);
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

async function openCertification(row: ItemRow): Promise<void> {
  certificationItem.value = row;
  const { data } = await http.get<{ certifications: { customer_id: number }[] }>(
    `/api/masterdata/items/${row.id}`,
  );
  certCustomerIds.value = data.certifications.map((item) => item.customer_id);
  certVisible.value = true;
}

async function saveCertification(): Promise<void> {
  if (!certificationItem.value) return;
  certSaving.value = true;
  try {
    await http.put(`/api/masterdata/items/${certificationItem.value.id}/certifications`, {
      customerIds: certCustomerIds.value,
    });
    certVisible.value = false;
    ElMessage.success('已保存');
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    certSaving.value = false;
  }
}

onMounted(async () => {
  await loadOptions();
  await load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 200px;
}

.category {
  width: 180px;
}

.state {
  width: 120px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.hint {
  margin: 0 0 12px;
  font-size: 13px;
  color: #909399;
}

.cert-select {
  width: 100%;
}
</style>