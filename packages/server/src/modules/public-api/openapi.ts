/**
 * 对外只读接口的 OpenAPI 3.1 文档（单一来源，经 GET /api/v1/openapi.json 公开输出）。
 * 手写静态文档，不引入 @fastify/swagger 依赖。
 */

const FORMAT_PARAM = {
  name: 'format',
  in: 'query',
  required: false,
  description: '响应格式，缺省 json',
  schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
};

const PAGE_PARAM = {
  name: 'page',
  in: 'query',
  required: false,
  description: '页码，从 1 开始',
  schema: { type: 'integer', minimum: 1, default: 1 },
};

const PAGE_SIZE_PARAM = {
  name: 'page_size',
  in: 'query',
  required: false,
  description: '每页条数，默认 100，上限 1000',
  schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
};

const AS_OF_PARAM = {
  name: 'as_of',
  in: 'query',
  required: false,
  description: '历史时点，YYYY-MM-DD 或 ISO 8601；缺省为当前时点',
  schema: { type: 'string', example: '2026-03-15' },
};

const codeParam = (name: string, example: string) => ({
  name,
  in: 'query',
  required: false,
  description: `${name} 精确匹配`,
  schema: { type: 'string', example },
});

const dateParam = (name: string) => ({
  name,
  in: 'query',
  required: false,
  description: `${name}（YYYY-MM-DD）`,
  schema: { type: 'string', example: '2026-01-01' },
});

const keywordParam = {
  name: 'keyword',
  in: 'query',
  required: false,
  description: '关键字模糊匹配',
  schema: { type: 'string' },
};

const envelopeResponse = (dataDescription: string) => ({
  description: '统一信封；format=csv 时返回 text/csv（不套信封）',
  headers: {
    'X-Warnings': {
      description: '仅 CSV 且存在告警时输出，值为告警条数',
      schema: { type: 'integer' },
    },
  },
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Envelope' },
      example: { code: 0, message: 'ok', data: dataDescription, _warnings: [] },
    },
  },
});

export const openapiDocument = {
  openapi: '3.1.0',
  info: {
    title: '轻量级进销存系统 · 对外只读数据接口',
    version: '1.0.0',
    description:
      '供下游供应链计划与推演引擎消费的只读接口。全部 GET、无需鉴权、支持 format=json|csv。' +
      '历史时点（as_of）一律从 stock_transaction 按 occurred_at <= as_of 重算；' +
      '在途 / 预占等单据派生量历史不可还原，返回 null 并在 _warnings 中提示。',
  },
  servers: [{ url: '/api/v1' }],
  tags: [{ name: 'public', description: '对外只读接口' }],
  components: {
    schemas: {
      PageInfo: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          pageSize: { type: 'integer' },
          total: { type: 'integer' },
        },
        required: ['page', 'pageSize', 'total'],
      },
      Envelope: {
        type: 'object',
        properties: {
          code: { type: 'integer', example: 0, description: '0 为成功，失败取 HTTP 状态码' },
          message: { type: 'string', example: 'ok' },
          data: { description: '数组或对象，随接口而定' },
          page: { $ref: '#/components/schemas/PageInfo' },
          _warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['code', 'message', 'data', '_warnings'],
      },
    },
  },
  paths: {
    '/items': {
      get: {
        tags: ['public'],
        summary: 'IF-1 物料主数据',
        parameters: [keywordParam, codeParam('category_code', 'CAT-01'), FORMAT_PARAM, PAGE_PARAM, PAGE_SIZE_PARAM],
        responses: { '200': envelopeResponse('[物料]') },
      },
    },
    '/boms': {
      get: {
        tags: ['public'],
        summary: 'IF-2 BOM（多版本，按 as_of 取生效版）',
        parameters: [
          AS_OF_PARAM,
          codeParam('parent_item_code', 'FG-001'),
          codeParam('child_item_code', 'RM-001'),
          keywordParam,
          FORMAT_PARAM,
        ],
        responses: { '200': envelopeResponse('[BOM 版本]（不分页）') },
      },
    },
    '/boms/{itemCode}/explode': {
      get: {
        tags: ['public'],
        summary: 'IF-2b BOM 多层展开（含循环检测）',
        parameters: [
          {
            name: 'itemCode',
            in: 'path',
            required: true,
            description: '根物料编码',
            schema: { type: 'string', example: 'FG-001' },
          },
          AS_OF_PARAM,
          {
            name: 'qty',
            in: 'query',
            required: false,
            description: '根物料需求数量，缺省 1',
            schema: { type: 'number', default: 1 },
          },
          FORMAT_PARAM,
        ],
        responses: {
          '200': envelopeResponse('{ as_of, root, lines, cycles }'),
          '404': { description: '物料不存在' },
        },
      },
    },
    '/inventory': {
      get: {
        tags: ['public'],
        summary: 'IF-3 库存（含历史快照）',
        parameters: [
          AS_OF_PARAM,
          keywordParam,
          codeParam('item_code', 'RM-001'),
          codeParam('warehouse_code', 'WH-01'),
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: { '200': envelopeResponse('[库存（六项口径）]') },
      },
    },
    '/in-transit': {
      get: {
        tags: ['public'],
        summary: 'IF-4 在途 / 采购订单',
        parameters: [
          AS_OF_PARAM,
          codeParam('supplier_code', 'SU-01'),
          codeParam('item_code', 'RM-001'),
          {
            name: 'status',
            in: 'query',
            required: false,
            description: '逗号分隔多值，缺省 confirmed,partial',
            schema: { type: 'string', example: 'confirmed,partial' },
          },
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: { '200': envelopeResponse('[采购在途行]') },
      },
    },
    '/purchase-history': {
      get: {
        tags: ['public'],
        summary: 'IF-5 历史采购订单（提前期，整单口径）',
        parameters: [
          codeParam('supplier_code', 'SU-01'),
          codeParam('item_code', 'RM-001'),
          dateParam('date_from'),
          dateParam('date_to'),
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: { '200': envelopeResponse('[采购历史行（提前期为整单口径）]') },
      },
    },
    '/suppliers/{code}/lead-time-stats': {
      get: {
        tags: ['public'],
        summary: 'IF-5b 供应商提前期聚合',
        parameters: [
          {
            name: 'code',
            in: 'path',
            required: true,
            description: '供应商编码',
            schema: { type: 'string', example: 'SU-01' },
          },
          codeParam('item_code', 'RM-001'),
          dateParam('date_from'),
          dateParam('date_to'),
          FORMAT_PARAM,
        ],
        responses: {
          '200': envelopeResponse('{ supplier_code, order_count, avg_lead_time_days, on_time_rate, ... }'),
          '404': { description: '供应商不存在' },
        },
      },
    },
    '/sales-orders': {
      get: {
        tags: ['public'],
        summary: 'IF-6 销售订单行',
        description:
          '一行 = 销售单的一行物料。字段：订单号 / 行号 / 客户（脱敏为客户编码）/ 物料编码 / 数量 / 要求交期 / 订单状态。',
        parameters: [
          keywordParam,
          codeParam('order_no', 'SO-20260101-0001'),
          codeParam('customer_code', 'CU-01'),
          codeParam('item_code', 'FG-1001'),
          {
            name: 'status',
            in: 'query',
            required: false,
            description: '逗号分隔多值',
            schema: { type: 'string', example: 'confirmed,partial' },
          },
          { ...dateParam('date_from'), description: '要求交期起（YYYY-MM-DD）' },
          { ...dateParam('date_to'), description: '要求交期止（YYYY-MM-DD）' },
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: {
          '200': envelopeResponse(
            '[{ order_no, line_no, customer_code, item_code, quantity, due_date, status }]',
          ),
        },
      },
    },
    '/warehouses': {
      get: {
        tags: ['public'],
        summary: 'IF-7 工厂 / 仓库主数据',
        parameters: [
          {
            name: 'type',
            in: 'query',
            required: false,
            description: '仓库类型',
            schema: { type: 'string', enum: ['plant', 'warehouse', 'port'] },
          },
          {
            name: 'is_active',
            in: 'query',
            required: false,
            description: '是否启用（1 启用 / 0 停用）',
            schema: { type: 'integer', enum: [0, 1] },
          },
          FORMAT_PARAM,
        ],
        responses: { '200': envelopeResponse('[仓库]（不分页）') },
      },
    },
  },
} as const;