<template>
  <el-card shadow="never">
    <template #header>
      <div class="doc-header">
        <span class="title">对外只读数据接口</span>
        <el-link type="primary" :href="openapiUrl" target="_blank">查看 OpenAPI 文档（/api/v1/openapi.json）</el-link>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="接口约定"
      description="前缀 /api/v1，全部 GET、无需鉴权，支持 format=json|csv。历史时点用 as_of（YYYY-MM-DD 或 ISO 8601）；在途 / 预占等单据派生量历史不可还原，返回 null 并在 _warnings 中提示。分页 page 默认 1、page_size 默认 100（上限 1000）。"
    />

    <el-table :data="interfaces" border stripe class="doc-table">
      <el-table-column prop="ifNo" label="编号" width="100" />
      <el-table-column prop="path" label="路径" min-width="240" />
      <el-table-column prop="params" label="查询参数" min-width="280" />
      <el-table-column prop="returns" label="返回" min-width="220" />
    </el-table>

    <el-divider content-position="left">调用示例（JSON）</el-divider>
    <el-collapse>
      <el-collapse-item v-for="item in interfaces" :key="item.ifNo" :title="`${item.ifNo} · ${item.path}`">
        <pre class="code">{{ item.curl }}</pre>
      </el-collapse-item>
    </el-collapse>

    <el-divider content-position="left">CSV 导出</el-divider>
    <pre class="code">{{ csvExample }}</pre>
    <p class="tip">CSV 带 UTF-8 BOM、不套信封；存在告警时通过响应头 X-Warnings 返回条数。</p>
  </el-card>
</template>

<script setup lang="ts">
const apiBase = `${window.location.origin}/api/v1`;
const openapiUrl = `${apiBase}/openapi.json`;

interface ApiDoc {
  ifNo: string;
  path: string;
  params: string;
  returns: string;
  curl: string;
}

const base = 'GET ';

const interfaces: ApiDoc[] = [
  {
    ifNo: 'IF-1',
    path: '/items',
    params: 'keyword, category_code, is_active, page, page_size, format',
    returns: '物料数组 + page',
    curl: `${base} ${apiBase}/items?page=1&page_size=5`,
  },
  {
    ifNo: 'IF-2',
    path: '/boms',
    params: 'as_of, parent_item_code, child_item_code, keyword, format',
    returns: 'BOM 版本数组（不分页）',
    curl: `${base} ${apiBase}/boms?as_of=2026-03-15`,
  },
  {
    ifNo: 'IF-2b',
    path: '/boms/{itemCode}/explode',
    params: 'as_of, qty, format',
    returns: '{ root, lines, cycles } + _warnings',
    curl: `${base} ${apiBase}/boms/FG-001/explode?qty=10`,
  },
  {
    ifNo: 'IF-3',
    path: '/inventory',
    params: 'as_of, keyword, item_code, warehouse_code, page, page_size, format',
    returns: '库存数组（六项口径）+ page',
    curl: `${base} ${apiBase}/inventory?item_code=RM-001`,
  },
  {
    ifNo: 'IF-4',
    path: '/in-transit',
    params: 'as_of, supplier_code, item_code, status, page, page_size, format',
    returns: '采购在途行 + page',
    curl: `${base} ${apiBase}/in-transit?status=confirmed,partial`,
  },
  {
    ifNo: 'IF-5',
    path: '/purchase-history',
    params: 'supplier_code, item_code, date_from, date_to, page, page_size, format',
    returns: '采购历史行（提前期为整单口径）+ page',
    curl: `${base} ${apiBase}/purchase-history?supplier_code=SU-01`,
  },
  {
    ifNo: 'IF-5b',
    path: '/suppliers/{code}/lead-time-stats',
    params: 'item_code, date_from, date_to, format',
    returns: '提前期聚合对象',
    curl: `${base} ${apiBase}/suppliers/SU-01/lead-time-stats`,
  },
  {
    ifNo: 'IF-6',
    path: '/sales-orders',
    params:
      'keyword, order_no, customer_code, customer_name, item_code, warehouse_code, status, order_date, date_from, date_to, page, page_size, format',
    returns:
      '销售订单行数组（订单号/行号/客户编码/物料编码/仓库编码/数量/已出库量/未出库量/要求交期/状态）+ page',
    curl: `${base} ${apiBase}/sales-orders?warehouse_code=WH-01&order_date=2026-01-01`,
  },
  {
    ifNo: 'IF-7',
    path: '/warehouses',
    params: 'type, is_active, format',
    returns: '仓库数组（不分页）',
    curl: `${base} ${apiBase}/warehouses?type=warehouse`,
  },
];

const csvExample = `${base} ${apiBase}/items?format=csv
${base} ${apiBase}/inventory?as_of=2026-03-15&format=csv`;
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