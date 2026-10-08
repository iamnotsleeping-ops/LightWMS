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

/**
 * 统一信封样例：`data` 传入该接口的真实响应片段（字段名与类型与线上一致），
 * 便于下游直接按样例生成客户端 / 做断言。`paged=true` 时补上 `page`（仅分页接口有）。
 */
const envelopeResponse = (data: unknown, paged = false) => ({
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
      example: {
        code: 0,
        message: 'ok',
        data,
        ...(paged ? { page: { page: 1, pageSize: 100, total: 9 } } : {}),
        _warnings: [],
      },
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
        responses: {
          '200': envelopeResponse(
            [
              {
                id: 1,
                code: 'FG-1001',
                name: '智能网关 A',
                base_unit: 'EA',
                qty_precision: 0,
                category_code: 'CAT-FG',
                category_name: '成品',
                capacity_group: null,
                is_active: 1,
                inspection_required: 0,
                batch_managed: 0,
                serial_managed: 0,
                created_at: '2026-10-08T02:45:18.125Z',
                updated_at: '2026-10-08T02:45:18.125Z',
              },
            ],
            true,
          ),
        },
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
        responses: {
          '200': envelopeResponse([
            {
              id: 2,
              parent_item_code: 'FG-1001',
              parent_item_name: '智能网关 A',
              parent_base_unit: 'EA',
              child_item_code: 'RM-3002',
              child_item_name: '铝合金外壳',
              child_base_unit: 'EA',
              qty_per: 1,
              scrap_rate: 0,
              effective_from: '2026-01-01',
              effective_to: '2026-06-30',
            },
          ]),
        },
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
          '200': envelopeResponse({
            as_of: '2026-10-08',
            root: {
              item_code: 'FG-1001',
              item_name: '智能网关 A',
              base_unit: 'EA',
              qty_precision: 0,
              required_qty: 1,
            },
            lines: [
              {
                level: 1,
                item_code: 'RM-3002',
                item_name: '铝合金外壳',
                base_unit: 'EA',
                qty_precision: 0,
                qty_per: 1,
                scrap_rate: 0,
                required_qty: 1,
                is_leaf: true,
                cyclic: false,
              },
            ],
            cycles: [],
          }),
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
        responses: {
          '200': envelopeResponse(
            [
              {
                item_code: 'FG-1001',
                item_name: '智能网关 A',
                base_unit: 'EA',
                qty_precision: 0,
                warehouse_code: 'WH-02',
                warehouse_name: '成品仓',
                warehouse_type: 'warehouse',
                on_hand: 38,
                frozen: 0,
                reserved: 25,
                in_transit: 0,
                available: 13,
                projected: 13,
              },
            ],
            true,
          ),
        },
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
        responses: {
          '200': envelopeResponse(
            [
              {
                order_no: 'PO-20261005-0001',
                order_date: '2026-10-05',
                status: 'confirmed',
                supplier_code: 'SU-1002',
                supplier_name: '精密结构件',
                line_no: 1,
                item_code: 'RM-3002',
                item_name: '铝合金外壳',
                base_unit: 'EA',
                warehouse_code: 'WH-01',
                warehouse_name: '原料仓',
                quantity: 500,
                received_qty: 0,
                cancelled_qty: 0,
                in_transit: 500,
                promised_date: '2026-10-13',
              },
            ],
            true,
          ),
        },
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
        responses: {
          '200': envelopeResponse(
            [
              {
                order_no: 'PO-20260926-0001',
                order_date: '2026-09-26',
                status: 'partial',
                supplier_code: 'SU-1003',
                supplier_name: '新能源电池',
                line_no: 1,
                item_code: 'RM-3003',
                item_name: '锂离子电芯',
                quantity: 400,
                received_qty: 150,
                unit_price: 2480,
                promised_date: '2026-10-02',
                first_received_at: '2026-10-02T02:00:00.000Z',
                last_received_at: '2026-10-02T02:00:00.000Z',
                lead_time_days: 6,
                promised_lead_time_days: 6,
                on_time: true,
              },
            ],
            true,
          ),
        },
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
          '200': envelopeResponse({
            supplier_code: 'SU-1001',
            supplier_name: '华芯电子',
            order_count: 1,
            line_count: 1,
            received_line_count: 1,
            avg_lead_time_days: 6,
            min_lead_time_days: 6,
            max_lead_time_days: 6,
            avg_promised_lead_time_days: 7,
            on_time_rate: 1,
            last_order_date: '2026-09-13',
          }),
          '404': { description: '供应商不存在' },
        },
      },
    },
    '/sales-orders': {
      get: {
        tags: ['public'],
        summary: 'IF-6 销售订单行',
        description:
          '一行 = 销售单的一行物料。字段：订单号 / 行号 / 客户（脱敏为客户编码）/ 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 订单状态。' +
          '未出库量 = quantity − shipped_qty − cancelled_qty。',
        parameters: [
          keywordParam,
          codeParam('order_no', 'SO-20260101-0001'),
          codeParam('customer_code', 'CU-01'),
          codeParam('customer_name', '华东经销'),
          codeParam('item_code', 'FG-1001'),
          codeParam('warehouse_code', 'WH-01'),
          {
            name: 'status',
            in: 'query',
            required: false,
            description: '逗号分隔多值',
            schema: { type: 'string', example: 'confirmed,partial' },
          },
          { ...dateParam('order_date'), description: '订单日期，精确匹配（YYYY-MM-DD）' },
          { ...dateParam('date_from'), description: '要求交期起（YYYY-MM-DD）' },
          { ...dateParam('date_to'), description: '要求交期止（YYYY-MM-DD）' },
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: {
          '200': envelopeResponse(
            [
              {
                order_no: 'SO-20260918-0001',
                line_no: 1,
                customer_code: 'CU-2001',
                item_code: 'FG-1001',
                warehouse_code: 'WH-02',
                quantity: 50,
                shipped_qty: 50,
                unshipped: 0,
                due_date: '2026-09-28',
                status: 'shipped',
              },
            ],
            true,
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
        responses: {
          '200': envelopeResponse([
            {
              code: 'PLANT-01',
              name: '总装厂',
              type: 'plant',
              parent_code: null,
              parent_name: null,
              is_active: 1,
              created_at: '2026-10-08T02:45:18.125Z',
              updated_at: '2026-10-08T02:45:18.125Z',
            },
          ]),
        },
      },
    },
  },
} as const;