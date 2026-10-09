<template>
  <el-card shadow="never">
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索主料 / 替代料编码、名称"
        clearable
        class="search"
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select
        v-model="mainItemId"
        class="item"
        placeholder="主料"
        filterable
        remote
        clearable
        :remote-method="searchFilterItems"
        :loading="filterItemLoading"
        @visible-change="(visible: boolean) => visible && searchFilterItems('')"
        @change="reload"
      >
        <el-option
          v-for="item in filterItems"
          :key="item.id"
          :label="`${item.code} ${item.name}`"
          :value="item.id"
        />
      </el-select>
      <el-select v-model="scene" class="scene" placeholder="场景" clearable @change="reload">
        <el-option
          v-for="item in SUBSTITUTE_SCENES"
          :key="item"
          :label="SUBSTITUTE_SCENE_LABELS[item]"
          :value="item"
        />
      </el-select>
      <el-select v-model="isActive" class="state" placeholder="启用状态" clearable @change="reload">
        <el-option label="启用" :value="1" />
        <el-option label="停用" :value="0" />
      </el-select>
      <el-button @click="reload">查询</el-button>
      <el-button
        v-permission="PERMISSIONS.masterdataSubstituteManage"
        type="primary"
        @click="openCreate"
      >
        新建替代关系
      </el-button>
      <el-button type="primary" plain @click="openPlan">需求试算</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column label="主料" min-width="220" fixed="left">
        <template #default="{ row }">
          <span class="code">{{ row.main_item_code }}</span>
          <span class="name">{{ row.main_item_name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="替代料" min-width="220">
        <template #default="{ row }">
          <span class="code">{{ row.sub_item_code }}</span>
          <span class="name">{{ row.sub_item_name }}</span>
        </template>
      </el-table-column>
      <el-table-column label="父件" width="130" show-overflow-tooltip>
        <template #default="{ row }">{{ row.parent_item_code ?? '通用' }}</template>
      </el-table-column>
      <el-table-column label="仓库" width="140" show-overflow-tooltip>
        <template #default="{ row }">{{ row.warehouse_name ?? '全仓' }}</template>
      </el-table-column>
      <el-table-column prop="priority" label="优先级" width="90" align="right" />
      <el-table-column label="替代比例" width="110" align="right">
        <template #default="{ row }">{{ ratioText(row.ratio_num, row.ratio_den) }}</template>
      </el-table-column>
      <el-table-column label="场景" width="110">
        <template #default="{ row }">{{ sceneLabel(row.scene) }}</template>
      </el-table-column>
      <el-table-column label="策略" width="120">
        <template #default="{ row }">{{ strategyLabel(row.strategy) }}</template>
      </el-table-column>
      <el-table-column label="生效期" width="200">
        <template #default="{ row }">{{ validityText(row) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.is_active ? 'success' : 'info'">
            {{ row.is_active ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column v-if="canManage" label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button
            v-permission="PERMISSIONS.masterdataSubstituteManage"
            link
            type="primary"
            @click="openEdit(row)"
          >
            编辑
          </el-button>
          <el-button
            v-permission="PERMISSIONS.masterdataSubstituteManage"
            link
            type="primary"
            @click="toggleActive(row)"
          >
            {{ row.is_active ? '停用' : '启用' }}
          </el-button>
          <el-button
            v-permission="PERMISSIONS.masterdataSubstituteManage"
            link
            type="danger"
            @click="remove(row)"
          >
            删除
          </el-button>
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

  <el-dialog v-model="dialogVisible" :title="editing ? '编辑替代关系' : '新建替代关系'" width="560px">
    <el-form :model="form" label-width="110px">
      <el-form-item label="主料" required>
        <el-select
          v-model="form.main_item_id"
          placeholder="搜索物料编码 / 名称"
          filterable
          remote
          :disabled="editing !== null"
          :remote-method="searchFormItems"
          :loading="formItemLoading"
          class="full"
          @visible-change="(visible: boolean) => visible && searchFormItems('')"
        >
          <el-option
            v-for="item in formItems"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="替代料" required>
        <el-select
          v-model="form.sub_item_id"
          placeholder="搜索物料编码 / 名称"
          filterable
          remote
          :disabled="editing !== null"
          :remote-method="searchFormItems"
          :loading="formItemLoading"
          class="full"
          @visible-change="(visible: boolean) => visible && searchFormItems('')"
        >
          <el-option
            v-for="item in formItems"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="父件">
        <el-select
          v-model="form.parent_item_id"
          placeholder="不限（通用）"
          filterable
          remote
          clearable
          :remote-method="searchFormItems"
          :loading="formItemLoading"
          class="full"
          @visible-change="(visible: boolean) => visible && searchFormItems('')"
        >
          <el-option
            v-for="item in formItems"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="仓库">
        <el-select v-model="form.warehouse_id" placeholder="不限（全仓）" clearable class="full">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="优先级">
        <el-input-number v-model="form.priority" :min="1" :max="999" :precision="0" />
      </el-form-item>
      <el-form-item label="替代比例">
        <div class="ratio">
          <el-input-number v-model="form.ratio_num" :min="1" :max="9999" :precision="0" />
          <span class="ratio-sep">:</span>
          <el-input-number v-model="form.ratio_den" :min="1" :max="9999" :precision="0" />
        </div>
        <div class="ratio-preview">
          {{ ratioPreview }}（缺口 × 分子 ÷ 分母，分配时向上取整，不存储小数数量）
        </div>
      </el-form-item>
      <el-form-item label="场景" required>
        <el-select v-model="form.scene" class="full">
          <el-option
            v-for="item in SUBSTITUTE_SCENES"
            :key="item"
            :label="SUBSTITUTE_SCENE_LABELS[item]"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="策略" required>
        <el-select v-model="form.strategy" class="full">
          <el-option
            v-for="item in SUBSTITUTE_STRATEGIES"
            :key="item"
            :label="SUBSTITUTE_STRATEGY_LABELS[item]"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="生效起止">
        <div class="ratio">
          <el-date-picker
            v-model="form.effective_from"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="生效日期"
            clearable
            class="date"
          />
          <span class="ratio-sep">~</span>
          <el-date-picker
            v-model="form.effective_to"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="失效日期"
            clearable
            class="date"
          />
        </div>
      </el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.is_active" /></el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="255" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="planVisible" title="需求试算" width="920px">
    <el-form :inline="true" :model="planForm" class="plan-form">
      <el-form-item label="主料">
        <el-select
          v-model="planForm.mainItemId"
          placeholder="搜索物料编码 / 名称"
          filterable
          remote
          :remote-method="searchPlanItems"
          :loading="planItemLoading"
          class="item"
          @visible-change="(visible: boolean) => visible && searchPlanItems('')"
        >
          <el-option
            v-for="item in planItems"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="仓库">
        <el-select v-model="planForm.warehouseId" placeholder="仓库" class="scene">
          <el-option
            v-for="item in warehouses"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="需求量">
        <el-input-number v-model="planForm.requiredQty" :min="1" :precision="0" class="qty" />
      </el-form-item>
      <el-form-item label="场景">
        <el-select v-model="planForm.scene" class="scene">
          <el-option
            v-for="item in SUBSTITUTE_SCENES"
            :key="item"
            :label="SUBSTITUTE_SCENE_LABELS[item]"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="planForm.scene === 'sales_out'" label="客户">
        <el-select v-model="planForm.customerId" placeholder="客户" clearable class="scene">
          <el-option
            v-for="item in customers"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="策略">
        <el-select v-model="planForm.strategy" class="scene">
          <el-option
            v-for="item in SUBSTITUTE_STRATEGIES"
            :key="item"
            :label="SUBSTITUTE_STRATEGY_LABELS[item]"
            :value="item"
          />
        </el-select>
      </el-form-item>
      <el-form-item v-if="planForm.strategy === 'manual'" label="手工指定">
        <el-select
          v-model="planForm.manualItemIds"
          multiple
          placeholder="选择替代料"
          class="manual"
          :disabled="manualOptions.length === 0"
        >
          <el-option
            v-for="item in manualOptions"
            :key="item.id"
            :label="`${item.code} ${item.name}`"
            :value="item.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="planLoading" @click="runPlan">试算</el-button>
      </el-form-item>
    </el-form>

    <el-alert type="info" :closable="false" show-icon class="alert" :title="strategyHint" />
    <el-alert
      v-if="planForm.scene === 'sales_out'"
      type="warning"
      :closable="false"
      show-icon
      class="alert"
      title="销售出库场景下，替代料必须已对该客户认证（物料页的客户认证），否则会被跳过并列出原因"
    />

    <template v-if="plan">
      <el-alert
        v-for="(warning, index) in planWarnings"
        :key="index"
        type="warning"
        :closable="false"
        show-icon
        class="alert"
        :title="warning"
      />

      <div class="summary">
        主料：{{ plan.mainItemCode }} · 场景：{{ SUBSTITUTE_SCENE_LABELS[plan.scene] }} ·
        需求：{{ formatQty(plan.requiredQty, 0) }} · 策略：{{ SUBSTITUTE_STRATEGY_LABELS[plan.strategy] }}
        · 已覆盖：<b>{{ formatQty(plan.filledQty, 0) }}</b> · 剩余缺口：
        <b :class="{ gap: plan.gapQty > 0 }">{{ formatQty(plan.gapQty, 0) }}</b>
      </div>

      <el-table :data="plan.allocations" border stripe size="small">
        <el-table-column label="物料" min-width="220">
          <template #default="{ row }">
            <span class="code">{{ row.itemCode }}</span>
            <span class="name">{{ row.itemName }}</span>
          </template>
        </el-table-column>
        <el-table-column label="是否主料" width="100">
          <template #default="{ row }">
            <el-tag :type="row.isMain ? 'primary' : 'success'" size="small">
              {{ row.isMain ? '主料' : '替代料' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分配数量" width="110" align="right">
          <template #default="{ row }">{{ formatQty(row.quantity, 0) }}</template>
        </el-table-column>
        <el-table-column label="折算覆盖量" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.coveredQty, 0) }}</template>
        </el-table-column>
        <el-table-column label="当时可用量" width="120" align="right">
          <template #default="{ row }">{{ formatQty(row.available, 0) }}</template>
        </el-table-column>
        <el-table-column label="比例" width="100" align="right">
          <template #default="{ row }">{{ ratioText(row.ratioNum, row.ratioDen) }}</template>
        </el-table-column>
      </el-table>

      <div class="section">被跳过的替代料（{{ plan.skipped.length }}）</div>
      <el-table :data="plan.skipped" border stripe size="small">
        <el-table-column prop="itemCode" label="物料编码" width="180" />
        <el-table-column label="跳过原因">
          <template #default="{ row }">{{ skipLabel(row.reason) }}</template>
        </el-table-column>
      </el-table>
    </template>
    <el-empty v-else description="填写条件后点击「试算」" />
  </el-dialog>
</template>

<script setup lang="ts">
import {
  PERMISSIONS,
  SUBSTITUTE_SCENES,
  SUBSTITUTE_SCENE_LABELS,
  SUBSTITUTE_SKIP_REASON_LABELS,
  SUBSTITUTE_STRATEGIES,
  SUBSTITUTE_STRATEGY_LABELS,
  type SubstituteScene,
  type SubstituteStrategy,
  type SubstitutionSkipReason,
} from '@light-erp/shared';
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { http } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { confirmAction } from '@/utils/confirm';
import { formatQty } from '@/utils/format';

interface SubstituteRow {
  id: number;
  main_item_id: number;
  main_item_code: string;
  main_item_name: string;
  sub_item_id: number;
  sub_item_code: string;
  sub_item_name: string;
  parent_item_id: number | null;
  parent_item_code: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  priority: number;
  ratio_num: number;
  ratio_den: number;
  scene: SubstituteScene;
  strategy: SubstituteStrategy;
  effective_from: string | null;
  effective_to: string | null;
  is_active: number;
  remark: string | null;
}

interface ItemOption {
  id: number;
  code: string;
  name: string;
}

interface WarehouseOption {
  id: number;
  code: string;
  name: string;
  is_active: number;
}

interface PartnerOption {
  id: number;
  code: string;
  name: string;
}

interface PlanAllocation {
  itemId: number;
  itemCode: string;
  itemName: string;
  quantity: number;
  coveredQty: number;
  isMain: boolean;
  available: number;
  unitCost: number;
  ratioNum: number;
  ratioDen: number;
}

interface PlanSkip {
  itemId: number;
  itemCode: string;
  reason: SubstitutionSkipReason;
}

interface SubstitutionPlan {
  mainItemId: number;
  mainItemCode: string;
  warehouseId: number;
  scene: SubstituteScene;
  requiredQty: number;
  strategy: SubstituteStrategy;
  allocations: PlanAllocation[];
  filledQty: number;
  gapQty: number;
  skipped: PlanSkip[];
  warnings: string[];
}

const PATH = '/api/masterdata/substitutes';

const STRATEGY_HINTS: Record<SubstituteStrategy, string> = {
  proportion: '按比例混用：主料优先，缺口按优先级由替代料依次兜底。',
  manual: '手工指定：主料优先，缺口只允许用下方手工勾选的替代料补，其余一律跳过。',
  whole_batch:
    '整批全量：不做混用——主料能全额覆盖就全用主料；否则找单一替代料整批顶上；都做不到时不分配任何物料，缺口全量返回。',
};

const auth = useAuthStore();
const canManage = computed(() => auth.has(PERMISSIONS.masterdataSubstituteManage));

const rows = ref<SubstituteRow[]>([]);
const warehouses = ref<WarehouseOption[]>([]);
const customers = ref<PartnerOption[]>([]);
const customersLoaded = ref(false);
const loading = ref(false);
const saving = ref(false);
const keyword = ref('');
const mainItemId = ref<number | undefined>(undefined);
const scene = ref<SubstituteScene | undefined>(undefined);
const isActive = ref<number | undefined>(undefined);
const page = ref(1);
const pageSize = 20;
const total = ref(0);

const filterItems = ref<ItemOption[]>([]);
const filterItemLoading = ref(false);
const formItems = ref<ItemOption[]>([]);
const formItemLoading = ref(false);

const dialogVisible = ref(false);
const editing = ref<SubstituteRow | null>(null);
const form = reactive({
  main_item_id: undefined as number | undefined,
  sub_item_id: undefined as number | undefined,
  parent_item_id: null as number | null,
  warehouse_id: null as number | null,
  priority: 1,
  ratio_num: 1,
  ratio_den: 1,
  scene: 'sales_out' as SubstituteScene,
  strategy: 'proportion' as SubstituteStrategy,
  effective_from: null as string | null,
  effective_to: null as string | null,
  is_active: true,
  remark: '',
});

const planVisible = ref(false);
const planLoading = ref(false);
const plan = ref<SubstitutionPlan | null>(null);
const planWarnings = ref<string[]>([]);
const planItems = ref<ItemOption[]>([]);
const planItemLoading = ref(false);
const manualOptions = ref<ItemOption[]>([]);
const planForm = reactive({
  mainItemId: undefined as number | undefined,
  warehouseId: undefined as number | undefined,
  requiredQty: 1,
  scene: 'sales_out' as SubstituteScene,
  customerId: undefined as number | undefined,
  strategy: 'proportion' as SubstituteStrategy,
  manualItemIds: [] as number[],
});

const strategyHint = computed(() => STRATEGY_HINTS[planForm.strategy]);

const ratioPreview = computed(() => {
  const { ratio_num: num, ratio_den: den } = form;
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return '—';
  const value = num / den;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '');
  return `1 个主料 ≈ ${text} 个替代料`;
});

function ratioText(num: number, den: number): string {
  return den === 1 ? `1 : ${num}` : `${num}/${den}`;
}

function validityText(row: SubstituteRow): string {
  if (!row.effective_from && !row.effective_to) return '长期有效';
  return `${row.effective_from ?? '不限'} ~ ${row.effective_to ?? '不限'}`;
}

function skipLabel(reason: SubstitutionSkipReason): string {
  return SUBSTITUTE_SKIP_REASON_LABELS[reason] ?? reason;
}

/** 表格行的列值来自 el-table 作用域插槽（any），统一在此收窄 */
function sceneLabel(value: unknown): string {
  return SUBSTITUTE_SCENE_LABELS[value as SubstituteScene] ?? String(value);
}

function strategyLabel(value: unknown): string {
  return SUBSTITUTE_STRATEGY_LABELS[value as SubstituteStrategy] ?? String(value);
}

/** 下拉候选合并累积：远端搜索只给一页，替换列表会让已选项失去可读标签 */
function mergeOptions(current: ItemOption[], incoming: ItemOption[]): ItemOption[] {
  const map = new Map<number, ItemOption>();
  for (const option of current) map.set(option.id, option);
  for (const option of incoming) map.set(option.id, option);
  return [...map.values()];
}

function rememberItem(target: typeof filterItems, item: ItemOption): void {
  target.value = mergeOptions(target.value, [item]);
}

async function searchItems(keywordText: string): Promise<ItemOption[]> {
  const { data } = await http.get<ItemOption[]>('/api/masterdata/items', {
    keyword: keywordText || undefined,
    isActive: '1',
    pageSize: 200,
  });
  return data;
}

async function searchFilterItems(keywordText: string): Promise<void> {
  filterItemLoading.value = true;
  try {
    filterItems.value = mergeOptions(filterItems.value, await searchItems(keywordText));
  } finally {
    filterItemLoading.value = false;
  }
}

async function searchFormItems(keywordText: string): Promise<void> {
  formItemLoading.value = true;
  try {
    formItems.value = mergeOptions(formItems.value, await searchItems(keywordText));
  } finally {
    formItemLoading.value = false;
  }
}

async function searchPlanItems(keywordText: string): Promise<void> {
  planItemLoading.value = true;
  try {
    planItems.value = mergeOptions(planItems.value, await searchItems(keywordText));
  } finally {
    planItemLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await http.get<SubstituteRow[]>(PATH, {
      keyword: keyword.value || undefined,
      mainItemId: mainItemId.value,
      scene: scene.value,
      isActive: isActive.value,
      page: page.value,
      pageSize,
    });
    rows.value = res.data;
    total.value = res.page?.total ?? 0;
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
    main_item_id: undefined,
    sub_item_id: undefined,
    parent_item_id: null,
    warehouse_id: null,
    priority: 1,
    ratio_num: 1,
    ratio_den: 1,
    scene: 'sales_out',
    strategy: 'proportion',
    effective_from: null,
    effective_to: null,
    is_active: true,
    remark: '',
  });
  dialogVisible.value = true;
}

function openEdit(row: SubstituteRow): void {
  editing.value = row;
  rememberItem(formItems, {
    id: row.main_item_id,
    code: row.main_item_code,
    name: row.main_item_name,
  });
  rememberItem(formItems, {
    id: row.sub_item_id,
    code: row.sub_item_code,
    name: row.sub_item_name,
  });
  if (row.parent_item_id !== null) {
    rememberItem(formItems, {
      id: row.parent_item_id,
      code: row.parent_item_code ?? '',
      name: '',
    });
  }
  Object.assign(form, {
    main_item_id: row.main_item_id,
    sub_item_id: row.sub_item_id,
    parent_item_id: row.parent_item_id,
    warehouse_id: row.warehouse_id,
    priority: row.priority,
    ratio_num: row.ratio_num,
    ratio_den: row.ratio_den,
    scene: row.scene,
    strategy: row.strategy,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    is_active: row.is_active === 1,
    remark: row.remark ?? '',
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  if (!form.main_item_id) {
    ElMessage.warning('请选择主料');
    return;
  }
  if (!form.sub_item_id) {
    ElMessage.warning('请选择替代料');
    return;
  }
  if (form.main_item_id === form.sub_item_id) {
    ElMessage.warning('主料与替代料不能相同');
    return;
  }
  if (!Number.isInteger(form.ratio_num) || !Number.isInteger(form.ratio_den)) {
    ElMessage.warning('替代比例必须是正整数');
    return;
  }
  const payload: Record<string, unknown> = {
    parentItemId: form.parent_item_id,
    warehouseId: form.warehouse_id,
    priority: form.priority,
    ratioNum: form.ratio_num,
    ratioDen: form.ratio_den,
    scene: form.scene,
    strategy: form.strategy,
    effectiveFrom: form.effective_from ?? undefined,
    effectiveTo: form.effective_to ?? undefined,
    isActive: form.is_active,
    remark: form.remark || undefined,
  };
  saving.value = true;
  try {
    if (editing.value) {
      await http.patch(`${PATH}/${editing.value.id}`, payload);
    } else {
      await http.post(PATH, { ...payload, mainItemId: form.main_item_id, subItemId: form.sub_item_id });
    }
    dialogVisible.value = false;
    await load();
  } catch {
    // 重复范围 / 校验失败等提示已在 api client 中统一弹出
  } finally {
    saving.value = false;
  }
}

async function toggleActive(row: SubstituteRow): Promise<void> {
  try {
    await http.patch(`${PATH}/${row.id}`, { isActive: row.is_active !== 1 });
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

async function remove(row: SubstituteRow): Promise<void> {
  if (!(await confirmAction(`确认删除替代关系「${row.main_item_code} → ${row.sub_item_code}」？`, '删除确认')))
    return;
  try {
    await http.del(`${PATH}/${row.id}`);
    await load();
  } catch {
    // 提示已在 api client 中弹出
  }
}

async function openPlan(): Promise<void> {
  planVisible.value = true;
  if (planForm.warehouseId === undefined && warehouses.value.length > 0) {
    planForm.warehouseId = warehouses.value[0]?.id;
  }
  await loadCustomers();
}

async function loadCustomers(): Promise<void> {
  if (customersLoaded.value) return;
  try {
    const { data } = await http.get<PartnerOption[]>('/api/masterdata/partners', {
      type: 'customer',
      pageSize: 200,
    });
    customers.value = data;
    customersLoaded.value = true;
  } catch {
    // 无往来单位查看权限时不影响试算（可留空客户）
  }
}

async function loadManualOptions(): Promise<void> {
  if (planForm.strategy !== 'manual' || !planForm.mainItemId) {
    manualOptions.value = [];
    return;
  }
  const { data } = await http.get<SubstituteRow[]>(PATH, {
    mainItemId: planForm.mainItemId,
    scene: planForm.scene,
    pageSize: 200,
  });
  const map = new Map<number, ItemOption>();
  for (const row of data) {
    map.set(row.sub_item_id, { id: row.sub_item_id, code: row.sub_item_code, name: row.sub_item_name });
  }
  manualOptions.value = [...map.values()];
}

async function runPlan(): Promise<void> {
  if (!planForm.mainItemId) {
    ElMessage.warning('请选择主料');
    return;
  }
  if (!planForm.warehouseId) {
    ElMessage.warning('请选择仓库');
    return;
  }
  if (!Number.isInteger(planForm.requiredQty) || planForm.requiredQty <= 0) {
    ElMessage.warning('需求量必须是正整数');
    return;
  }
  if (planForm.strategy === 'manual' && planForm.manualItemIds.length === 0) {
    ElMessage.warning('手工指定策略需至少选择一个替代料');
    return;
  }
  planLoading.value = true;
  try {
    const res = await http.get<SubstitutionPlan>(`${PATH}/plan`, {
      mainItemId: planForm.mainItemId,
      warehouseId: planForm.warehouseId,
      requiredQty: planForm.requiredQty,
      scene: planForm.scene,
      customerId: planForm.scene === 'sales_out' ? planForm.customerId : undefined,
      strategy: planForm.strategy,
      manualItemIds: planForm.strategy === 'manual' ? planForm.manualItemIds.join(',') : undefined,
    });
    plan.value = res.data;
    planWarnings.value = [
      ...res.data.warnings,
      ...res._warnings.map((item) => String(item)),
    ];
  } catch {
    plan.value = null;
    planWarnings.value = [];
  } finally {
    planLoading.value = false;
  }
}

watch([() => planForm.mainItemId, () => planForm.scene, () => planForm.strategy], () => {
  planForm.manualItemIds = [];
  void loadManualOptions().catch(() => {
    manualOptions.value = [];
  });
});

onMounted(async () => {
  const [warehouseRes] = await Promise.all([
    http.get<WarehouseOption[]>('/api/masterdata/warehouses', { pageSize: 200 }),
    searchFilterItems(''),
  ]);
  warehouses.value = warehouseRes.data;
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

.scene {
  width: 150px;
}

.state {
  width: 130px;
}

.manual {
  width: 260px;
}

.qty {
  width: 130px;
}

.full {
  width: 100%;
}

.ratio {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ratio-sep {
  color: var(--el-text-color-secondary);
}

.ratio-preview {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 18px;
}

.date {
  width: 160px;
}

.plan-form {
  margin-bottom: 4px;
}

.alert {
  margin-bottom: 8px;
}

.summary {
  margin: 8px 0 12px;
  font-size: 14px;
}

.summary .gap {
  color: var(--el-color-danger);
}

.section {
  margin: 12px 0 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.code {
  margin-right: 8px;
}

.name {
  color: var(--el-text-color-secondary);
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
