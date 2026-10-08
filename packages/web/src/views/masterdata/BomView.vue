<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索父件 / 子件编码或名称"
        clearable
        class="search"
        @keyup.enter="load"
        @clear="load"
      />
      <el-select v-model="parentItemId" class="item" placeholder="父件" clearable filterable @change="load">
        <el-option
          v-for="item in items"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-date-picker
        v-model="asOf"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="只看某日生效版本"
        clearable
        class="date"
        @change="load"
      />
      <el-button @click="load">查询</el-button>
      <el-button v-if="canManage" type="primary" @click="openCreate">新增 BOM</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column label="父件" min-width="200">
        <template #default="{ row }">
          <div>{{ row.parent_code }}</div>
          <div class="sub">{{ row.parent_name }}</div>
        </template>
      </el-table-column>
      <el-table-column label="子件" min-width="200">
        <template #default="{ row }">
          <div>{{ row.child_code }}</div>
          <div class="sub">{{ row.child_name }}</div>
        </template>
      </el-table-column>
      <el-table-column label="单位用量" width="110" align="right">
        <template #default="{ row }">
          <span class="num">{{ row.qty_per }}</span>
          <span class="sub"> {{ row.child_unit }}</span>
        </template>
      </el-table-column>
      <el-table-column label="损耗率" width="100" align="right">
        <template #default="{ row }">
          <span class="num">{{ (row.scrap_rate * 100).toFixed(2) }}%</span>
        </template>
      </el-table-column>
      <el-table-column label="版本（生效期）" min-width="200">
        <template #default="{ row }">
          {{ row.effective_from ?? '自始' }} ~ {{ row.effective_to ?? '无限期' }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="explode(row)">展开</el-button>
          <el-button v-if="canManage" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canManage" link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑 BOM' : '新增 BOM'" width="620px">
    <el-form :model="form" label-width="100px">
      <el-form-item label="父件" required>
        <el-select v-model="form.parent_item_id" filterable :disabled="Boolean(editing)">
          <el-option
            v-for="item in items"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="子件" required>
        <el-select v-model="form.child_item_id" filterable :disabled="Boolean(editing)">
          <el-option
            v-for="item in items"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="单位用量" required>
        <el-input-number v-model="form.qty_per" :min="1" />
        <span class="hint">造 1 个父件需要多少子件，按子件最小单位取整数</span>
      </el-form-item>
      <el-form-item label="损耗率">
        <el-input-number v-model="form.scrap_rate" :min="0" :max="1" :step="0.01" :precision="2" />
      </el-form-item>
      <el-form-item label="生效日期">
        <el-date-picker v-model="form.effective_from" type="date" value-format="YYYY-MM-DD" placeholder="留空 = 立即生效" />
      </el-form-item>
      <el-form-item label="失效日期">
        <el-date-picker v-model="form.effective_to" type="date" value-format="YYYY-MM-DD" placeholder="留空 = 无限期" />
      </el-form-item>
    </el-form>

    <el-alert
      v-if="overlapped.length > 0"
      type="warning"
      :closable="false"
      show-icon
      title="生效期与已有版本重叠"
      class="alert"
    >
      <div v-for="version in overlapped" :key="version.id">
        已有版本：{{ version.effective_from ?? '自始' }} ~ {{ version.effective_to ?? '无限期' }}，
        用量 {{ version.qty_per }}；请调整生效期，避免同一父子件出现多条同时生效的版本。
      </div>
    </el-alert>

    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';

interface BomRow {
  id: number;
  parent_item_id: number;
  child_item_id: number;
  parent_code: string;
  parent_name: string;
  child_code: string;
  child_name: string;
  child_unit: string;
  qty_per: number;
  scrap_rate: number;
  effective_from: string | null;
  effective_to: string | null;
}

interface ItemOption {
  id: number;
  code: string;
  name: string;
  base_unit: string;
  is_active: number;
}

const auth = useAuthStore();
const router = useRouter();
const canManage = computed(() => auth.has('masterdata.bom.manage'));

const rows = ref<BomRow[]>([]);
const items = ref<ItemOption[]>([]);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const parentItemId = ref<number | undefined>(undefined);
const asOf = ref<string | null>(null);

const dialogVisible = ref(false);
const editing = ref<BomRow | null>(null);
const form = reactive({
  parent_item_id: undefined as number | undefined,
  child_item_id: undefined as number | undefined,
  qty_per: 1,
  scrap_rate: 0,
  effective_from: null as string | null,
  effective_to: null as string | null,
});

/** 同一父子件的已有版本，用于提示生效期重叠 */
const samePairVersions = computed(() =>
  rows.value.filter(
    (row) =>
      row.parent_item_id === form.parent_item_id &&
      row.child_item_id === form.child_item_id &&
      row.id !== editing.value?.id,
  ),
);

const overlapped = computed(() =>
  samePairVersions.value.filter((row) => {
    const startA = form.effective_from ?? '0000-01-01';
    const endA = form.effective_to ?? '9999-12-31';
    const startB = row.effective_from ?? '0000-01-01';
    const endB = row.effective_to ?? '9999-12-31';
    return startA <= endB && startB <= endA;
  }),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<BomRow[]>('/api/masterdata/boms', {
      keyword: keyword.value,
      parentItemId: parentItemId.value,
      asOf: asOf.value ?? undefined,
    });
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

function explode(row: BomRow): void {
  router.push({ path: '/masterdata/bom/explode', query: { itemId: String(row.parent_item_id) } });
}

async function loadItems(): Promise<void> {
  const { data } = await http.get<ItemOption[]>('/api/masterdata/items', { pageSize: 200, isActive: '1' });
  items.value = data;
}

function openCreate(): void {
  editing.value = null;
  Object.assign(form, {
    parent_item_id: parentItemId.value,
    child_item_id: undefined,
    qty_per: 1,
    scrap_rate: 0,
    effective_from: null,
    effective_to: null,
  });
  dialogVisible.value = true;
}

function openEdit(row: BomRow): void {
  editing.value = row;
  Object.assign(form, {
    parent_item_id: row.parent_item_id,
    child_item_id: row.child_item_id,
    qty_per: row.qty_per,
    scrap_rate: row.scrap_rate,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.parent_item_id || !form.child_item_id) {
    ElMessage.warning('请选择父件与子件');
    return;
  }
  if (form.parent_item_id === form.child_item_id) {
    ElMessage.warning('父件与子件不能是同一个物料');
    return;
  }
  saving.value = true;
  const payload = {
    qty_per: form.qty_per,
    scrap_rate: form.scrap_rate,
    effective_from: form.effective_from,
    effective_to: form.effective_to,
  };
  try {
    if (editing.value) await http.patch(`/api/masterdata/boms/${editing.value.id}`, payload);
    else
      await http.post('/api/masterdata/boms', {
        ...payload,
        parent_item_id: form.parent_item_id,
        child_item_id: form.child_item_id,
      });
    dialogVisible.value = false;
    await load();
  } catch {
    // 提示已在 api client 中弹出
  } finally {
    saving.value = false;
  }
}

async function remove(row: BomRow): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除「${row.parent_code} → ${row.child_code}」这条 BOM 版本？`,
    '删除确认',
    { type: 'warning' },
  );
  try {
    await http.del(`/api/masterdata/boms/${row.id}`);
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

onMounted(async () => {
  await loadItems();
  await load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.search {
  width: 220px;
}

.item {
  width: 220px;
}

.date {
  width: 200px;
}

.sub {
  font-size: 12px;
  color: #909399;
}

.hint {
  margin-left: 8px;
  font-size: 12px;
  color: #909399;
}

.alert {
  margin-top: 4px;
}
</style>