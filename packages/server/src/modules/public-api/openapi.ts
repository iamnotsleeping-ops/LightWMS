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
      '在途 / 预占等单据派生量历史不可还原，返回 null 并在 _warnings 中提示。' +
      '替代料接口分两层：/substitutes 只给「配了哪些替代关系」，/substitution-plan 给分配建议（只读试算，不写任何单据或库存）；' +
      '两者的 as_of 都只筛选替代关系生效期，可用量与成本始终是当前时点。',
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
        'x-returns': '物料数组 + page（分页）',
        parameters: [
          keywordParam,
          codeParam('category_code', 'CAT-01'),
          {
            name: 'is_active',
            in: 'query',
            required: false,
            description: '是否启用（1 启用 / 0 停用）',
            schema: { type: 'integer', enum: [0, 1] },
          },
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
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
        'x-returns': 'BOM 版本数组（不分页）',
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
        'x-returns': '{ root, lines, cycles } + _warnings（不分页）',
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
        'x-returns':
          '库存数组（on_hand / frozen / qc / total_qty + reserved / in_transit / available / projected）+ page。' +
          '口径：on_hand = 仅 available 桶数量；frozen / qc 是**独立桶**（只进 total_qty = on_hand + frozen + qc）；' +
          'available = on_hand − reserved（可承诺量 ATP，**可为负**，负值表示已超卖）；' +
          'projected = on_hand + in_transit − reserved。注意 reserved 是**软预占**：仅作报表口径，' +
          '出入库等写路径只校验物理量，系统允许超卖',
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
                item_code: 'RM-3001',
                item_name: '主控芯片',
                base_unit: 'EA',
                qty_precision: 0,
                warehouse_code: 'WH-01',
                warehouse_name: '原料仓',
                warehouse_type: 'warehouse',
                on_hand: 460,
                frozen: 20,
                qc: 300,
                total_qty: 780,
                reserved: 0,
                in_transit: 0,
                available: 460,
                projected: 460,
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
        'x-returns': '采购在途行 + page（分页）',
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
        'x-returns': '采购历史行（提前期为整单口径）+ page（分页）',
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
        'x-returns': '提前期聚合对象（不分页）',
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
        'x-returns':
          '销售订单行数组（订单号 / 行号 / 订单日期 / 客户编码 / 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 状态）+ page',
        description:
          '一行 = 销售单的一行物料。字段：订单号 / 行号 / 订单日期 / 客户（脱敏为客户编码）/ 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 订单状态。' +
          '未出库量 = quantity − shipped_qty − cancelled_qty。' +
          '未指定 status 时缺省只返回未结需求（confirmed / partial），与库存口径的 reserved 一致；' +
          '如需包含 draft / cancelled 请显式传 status。',
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
                order_date: '2026-09-18',
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
        'x-returns': '仓库数组（不分页）',
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
    '/substitutes': {
      get: {
        tags: ['public'],
        summary: 'IF-8 替代关系（关系清单，非规划结果）',
        'x-returns':
          '替代关系数组（主料 / 替代料 / 适用仓与父件 / 优先级 / 整数比例 / 场景 / 策略 / 生效期 / 是否启用）+ page',
        description:
          '只返回已配置的替代关系本身：谁可以替代谁、比例 / 优先级 / 场景 / 策略 / 生效期 / 适用仓与父件，' +
          '不计算可用量、不给出分配建议（分配建议见 IF-9 /substitution-plan）。' +
          '指定 warehouse_code 时同时返回「全仓通用」关系（warehouse_code 为 null）与该仓专属关系；' +
          '指定 as_of 时只按生效期筛选关系有效性（effective_from / effective_to，null 表示不设边界），' +
          '该筛选不影响库存——可用量始终是当前时点，且不在本接口返回范围内。',
        parameters: [
          {
            ...codeParam('main_item_code', 'RM-001'),
            required: true,
            description: '主料编码，精确匹配（必填）',
          },
          codeParam('warehouse_code', 'WH-01'),
          {
            name: 'scene',
            in: 'query',
            required: false,
            description: '替代场景',
            schema: { type: 'string', enum: ['sales_out', 'bom_plan', 'purchase_hint'] },
          },
          AS_OF_PARAM,
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: {
          '200': envelopeResponse(
            [
              {
                main_item_code: 'RM-3001',
                main_item_name: '主控芯片',
                sub_item_code: 'RM-3002',
                sub_item_name: '国产主控芯片',
                sub_base_unit: 'EA',
                parent_item_code: null,
                warehouse_code: null,
                priority: 1,
                ratio_num: 1,
                ratio_den: 1,
                scene: 'sales_out',
                strategy: 'proportion',
                effective_from: '2026-01-01',
                effective_to: null,
                is_active: 1,
              },
            ],
            true,
          ),
        },
      },
    },
    '/substitution-plan': {
      get: {
        tags: ['public'],
        summary: 'IF-9 替代规划（只读试算，整份返回）',
        'x-returns':
          '分配建议对象（allocations / filled_qty / gap_qty / skipped）+ _warnings（不分页，plan 整份返回）。' +
          '注意 filled_qty 可能**大于** required_qty（比例向上取整所致），skipped 只列「无法参与分配」的替代料，' +
          '不含「可参与但未轮到的候选」',
        description:
          '按主料 + 仓库 + 需求量给出替代分配建议；只读试算，不写任何单据或库存（调用前后库存与替代关系零变化）。' +
          '三种 strategy：proportion 主料优先，缺口按 priority 用替代料按比例（ratio_num / ratio_den）补齐；' +
          'whole_batch 不做混用——主料可全额覆盖就全用主料，否则找单一替代料整批顶上，都做不到时不做任何分配并全量返回缺口；' +
          'manual 主料优先，缺口只用手工指定的 manual_item_codes（按给定顺序）补。' +
          '规划结果整份返回、不分页：page / page_size 仅为与其它接口保持入参一致而接收，不影响结果；' +
          'format=csv 时一行 = 一条 allocation。' +
          'as_of 只筛选替代关系生效期（effective_from / effective_to），可用库存与成本始终是当前时点，历史时点不可还原，并在 _warnings 中提示。' +
          '【可用量口径】规划按**物理可用量**分配：allocations[].on_hand 即 stock_balance 中 available 桶的数量，' +
          '等于 IF-3 /inventory 的 on_hand，**不扣减**已确认未出库的销售预占 reserved——这与出库校验口径一致。' +
          'IF-3 的 available 是「可承诺量 ATP = on_hand − reserved」（可为负），两者不是同一个量；' +
          '需要 ATP 或超卖视角请取 IF-3 的 reserved / available / projected。' +
          'allocations[].available 是 on_hand 的历史别名，已弃用，将在下个版本移除。' +
          '【作用域与优先级】同一替代料可配多行（通用 / 仓专属 / 父件专属）；规划按替代料去重后只取**第一条通过全部校验**的行，' +
          '取数顺序为「仓专属 → 父件专属 → priority 升序 → id 升序」（**仓专属优先于父件专属**），' +
          '最专属行失效时回落到同一替代料的下一条有效行；跨替代料的兜底顺序按 priority 升序、同优先级按替代料编码。' +
          '【场景是硬分区】不跨场景匹配，被场景排除的关系不会出现在 skipped 中。' +
          '【manual 的返回边界】手工清单里任意一项命中「编码不存在（404）/ 无替代关系（400）/ 规则层不可用：停用、不在生效期、' +
          '仓或父件不符（400）/ 未对客户认证或认证过期（400）」时，整份请求 400，能用的项也不分配（不做部分执行）；' +
          '而「关系成立、规则允许、但该仓物理可用为 0」返回 200 并记 skipped[no_stock] —— 量不等于资格。' +
          '不指名时，停用 / 不在生效期 / 仓或父件不符会以 skipped 的形式出现在 200 响应里。',
        parameters: [
          {
            ...codeParam('main_item_code', 'RM-001'),
            required: true,
            description: '主料编码（必填）',
          },
          {
            ...codeParam('warehouse_code', 'WH-01'),
            required: true,
            description: '仓库编码（必填）',
          },
          {
            name: 'required_qty',
            in: 'query',
            required: true,
            description: '主料口径的需求量（正整数）',
            schema: { type: 'integer', minimum: 1, example: 100 },
          },
          {
            name: 'scene',
            in: 'query',
            required: false,
            description: '替代场景，缺省 sales_out',
            schema: {
              type: 'string',
              enum: ['sales_out', 'bom_plan', 'purchase_hint'],
              default: 'sales_out',
            },
          },
          {
            ...codeParam('customer_code', 'CU-01'),
            description: '客户编码；scene=sales_out 时用于客户正向认证过滤',
          },
          {
            ...codeParam('parent_item_code', 'FG-001'),
            description: '父件编码（BOM 语境）；仅匹配该父件下的专属关系与通用关系',
          },
          {
            name: 'strategy',
            in: 'query',
            required: false,
            description: '替代策略，缺省取首个候选关系上的策略',
            schema: { type: 'string', enum: ['proportion', 'whole_batch', 'manual'] },
          },
          {
            name: 'manual_item_codes',
            in: 'query',
            required: false,
            description: '逗号分隔的替代料编码，仅 strategy=manual 时使用（顺序即分配顺序）',
            schema: { type: 'string', example: 'RM-3002,RM-3003' },
          },
          AS_OF_PARAM,
          FORMAT_PARAM,
          PAGE_PARAM,
          PAGE_SIZE_PARAM,
        ],
        responses: {
          '200': envelopeResponse({
            as_of: '2026-10-08',
            main_item_code: 'RM-3001',
            warehouse_code: 'WH-01',
            scene: 'sales_out',
            strategy: 'proportion',
            required_qty: 100,
            filled_qty: 100,
            gap_qty: 0,
            allocations: [
              {
                item_code: 'RM-3001',
                item_name: '主控芯片',
                quantity: 30,
                covered_qty: 30,
                is_main: true,
                on_hand: 30,
                available: 30, // 过渡别名，已弃用
                unit_cost: 5000,
                ratio_num: 1,
                ratio_den: 1,
              },
              {
                item_code: 'RM-3002',
                item_name: '国产主控芯片',
                quantity: 70,
                covered_qty: 70,
                is_main: false,
                on_hand: 200,
                available: 200, // 过渡别名，已弃用
                unit_cost: 4800,
                ratio_num: 1,
                ratio_den: 1,
              },
            ],
            skipped: [],
          }),
          '404': { description: '主料 / 仓库 / 客户 / 父件 / 手工替代料编码不存在' },
        },
      },
    },
  },
} as const;