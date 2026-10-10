<template>
  <el-card shadow="never">
    <template #header>
      <div class="doc-header">
        <span class="title">对外只读数据接口</span>
        <el-link type="primary" :href="openapiUrl" target="_blank">
          查看 OpenAPI 文档（/api/v1/openapi.json）
        </el-link>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="接口约定"
      description="前缀 /api/v1，全部 GET；除 openapi.json（契约文档）外所有数据接口都要求请求头 X-API-Key（缺失或无效返回 401），支持 format=json|csv。历史时点用 as_of（YYYY-MM-DD 或 ISO 8601）；在途 / 预占等单据派生量历史不可还原，返回 null 并在 _warnings 中提示。分页 page 默认 1、page_size 默认 100（上限 1000）。"
    />

    <el-alert
      v-if="loadError"
      type="error"
      :closable="false"
      show-icon
      title="接口清单加载失败"
      :description="loadError"
      class="load-error"
    />

    <!--
      清单完全由 /api/v1/openapi.json 渲染，页内不再维护第二份接口表：
      此前这里是硬编码数组，新增 IF-8 / IF-9 时页面照旧显示 9 条，属于典型的双源漂移。
      后端 public.test.ts 有断言保证每个对外接口都带 summary（IF-x 前缀）与 x-returns，
      因此这里不会出现"渲染出残缺行"的情况。
    -->
    <el-table v-loading="loading" :data="interfaces" border stripe class="doc-table">
      <el-table-column prop="ifNo" label="编号" width="100" />
      <el-table-column prop="path" label="路径" min-width="230" />
      <el-table-column prop="params" label="查询参数" min-width="300" />
      <el-table-column prop="returns" label="返回" min-width="240" />
    </el-table>
    <p class="tip">
      共 {{ interfaces.length }} 条对外接口，均取自服务端 OpenAPI 文档（含 1 条文档接口
      openapi.json）；本页不再单独维护接口清单，新增接口会自动出现在这里。
    </p>

    <el-divider content-position="left">调用示例（JSON）</el-divider>
    <el-collapse>
      <el-collapse-item v-for="item in interfaces" :key="item.ifNo" :title="`${item.ifNo} · ${item.path}`">
        <pre class="code">{{ item.curl }}</pre>
        <p v-if="item.description" class="tip">{{ item.description }}</p>
      </el-collapse-item>
    </el-collapse>

    <el-divider content-position="left">CSV 导出</el-divider>
    <pre class="code">{{ csvExample }}</pre>
    <p class="tip">CSV 带 UTF-8 BOM、不套信封；存在告警时通过响应头 X-Warnings 返回条数。</p>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

const apiBase = `${window.location.origin}/api/v1`;
const openapiUrl = `${apiBase}/openapi.json`;

interface ParamSpec {
  name: string;
  in?: string;
  required?: boolean;
  schema?: { example?: unknown; default?: unknown; enum?: unknown[] };
}

interface OperationSpec {
  summary?: string;
  description?: string;
  parameters?: ParamSpec[];
  'x-returns'?: string;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OperationSpec>>;
}

interface ApiDoc {
  ifNo: string;
  path: string;
  params: string;
  returns: string;
  curl: string;
  description?: string;
}

const interfaces = ref<ApiDoc[]>([]);
const loading = ref(true);
const loadError = ref('');

/** IF-9b / IF-2 之类的编号排序：先按主号，再按子号（无子号在前） */
function ifNoRank(ifNo: string): [number, string] {
  const matched = /^IF-(\d+)([a-z]*)$/.exec(ifNo);
  if (!matched) return [Number.MAX_SAFE_INTEGER, ifNo];
  return [Number(matched[1]), matched[2]];
}

function sampleValue(param: ParamSpec): string | null {
  const { example, default: fallback, enum: options } = param.schema ?? {};
  const picked = example ?? fallback ?? (Array.isArray(options) ? options[0] : undefined);
  if (picked === undefined || picked === null) return null;
  return String(picked);
}

/** 由参数的真实 example 生成 curl，避免示例与契约脱节 */
function buildCurl(path: string, params: ParamSpec[]): string {
  const query = params
    .filter((param) => param.in === 'query' || param.in === undefined)
    .filter((param) => param.name !== 'format')
    .map((param) => {
      const value = param.required ? (sampleValue(param) ?? '') : sampleValue(param);
      return value === null ? null : `${param.name}=${encodeURIComponent(value)}`;
    })
    .filter((pair): pair is string => pair !== null && !pair.endsWith('='));
  const url = `${apiBase}${path.replace('{itemCode}', 'FG-1001').replace('{code}', 'SU-1001')}`;
  const queryString = query.length > 0 ? `?${query.join('&')}` : '';
  // 数据接口都要 API Key：示例里一并给出，否则复制出去就是 401
  return `GET ${url}${queryString}\n  -H "X-API-Key: $PUBLIC_API_KEY"`;
}

onMounted(async () => {
  try {
    // 该端点返回的是裸 OpenAPI 文档（不套统一信封），故不能用会拆信封的 http.get
    const response = await fetch(openapiUrl);
    if (!response.ok) throw new Error(`GET ${openapiUrl} 返回 HTTP ${response.status}`);
    const document = (await response.json()) as OpenApiDocument;
    const rows: ApiDoc[] = [];
    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      const operation = operations.get;
      if (!operation) continue;
      const summary = operation.summary ?? '';
      const matched = /^(IF-\S+)\s+(.*)$/.exec(summary);
      const params = (operation.parameters ?? []).filter(
        (param) => param.in === 'query' || param.in === undefined,
      );
      rows.push({
        ifNo: matched ? matched[1] : '—',
        path,
        params: params.map((param) => param.name).join(', ') || '—',
        returns: operation['x-returns'] ?? '—',
        curl: buildCurl(path, params),
        description: operation.description,
      });
    }
    rows.sort((a, b) => {
      const [aMain, aSub] = ifNoRank(a.ifNo);
      const [bMain, bSub] = ifNoRank(b.ifNo);
      return aMain - bMain || aSub.localeCompare(bSub);
    });
    interfaces.value = rows;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '无法读取 OpenAPI 文档';
  } finally {
    loading.value = false;
  }
});

const csvExample = `GET ${apiBase}/items?format=csv
  -H "X-API-Key: $PUBLIC_API_KEY"
GET ${apiBase}/inventory?as_of=2026-03-15&format=csv
  -H "X-API-Key: $PUBLIC_API_KEY"`;
</script>

<style scoped>
.doc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.doc-header .title {
  font-weight: 600;
}
.doc-table {
  margin-top: 16px;
}
.load-error {
  margin-top: 12px;
}
.code {
  margin: 0;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.tip {
  margin: 8px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
