<template>
  <el-card shadow="never">
    <div class="toolbar">
      <span class="title">系统参数</span>
      <el-button @click="load">刷新</el-button>
      <span class="hint">参数由数据库 sys_param 表维护，此处仅供查看；如需调整请由管理员在数据库侧操作</span>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="key" label="参数键" width="240" />
      <el-table-column prop="value" label="参数值" width="180" />
      <el-table-column prop="description" label="说明" min-width="320">
        <template #default="{ row }">{{ row.description || '—' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="200">
        <template #default="{ row }">{{ formatTime(row.updated_at) }}</template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<script setup lang="ts">
import { http } from '@/api/client';
import { ElMessage } from 'element-plus';
import { onMounted, ref } from 'vue';

interface ParamRow {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

const rows = ref<ParamRow[]>([]);
const loading = ref(false);

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const { data } = await http.get<ParamRow[]>('/api/system/params');
    rows.value = data;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.title {
  font-size: 16px;
  font-weight: 600;
}

.hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>