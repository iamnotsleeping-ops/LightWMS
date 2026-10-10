import {
  publicBomExplodeParamSchema,
  publicBomExplodeQuerySchema,
  publicBomsQuerySchema,
  publicCertificationsQuerySchema,
  publicInTransitQuerySchema,
  publicInventoryQuerySchema,
  publicItemsQuerySchema,
  publicLeadTimeStatsQuerySchema,
  publicPurchaseHistoryQuerySchema,
  publicSalesOrdersQuerySchema,
  publicSubstitutesQuerySchema,
  publicSubstitutionPlanQuerySchema,
  publicSupplierParamSchema,
  publicWarehousesQuerySchema,
} from '@light-erp/shared';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config/index';
import { sendCsv } from '../../lib/csv';
import { ApiError, ok, okPage } from '../../lib/response';
import { openapiDocument } from './openapi';
import {
  explodePublicBom,
  listPublicBoms,
  listPublicItemCertifications,
  listPublicInTransit,
  listPublicItems,
  listPublicPurchaseHistory,
  listPublicSalesOrders,
  listPublicSubstitutes,
  listPublicWarehouses,
  queryPublicInventory,
  substitutionPlan,
  supplierLeadTimeStats,
} from './public.service';

type Row = Record<string, unknown>;

/** 常量时间比较，避免逐字节比较泄漏 Key 前缀 */
function apiKeyMatches(provided: string, expected: string): boolean {
  const given = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * 注册对外只读接口。
 *
 * 鉴权：`PUBLIC_API_KEY` 非空时，所有 `/api/v1` **数据**接口都要求请求头
 * `X-API-Key`（缺失/不符 → 401）。数据接口暴露库存、采购单价、供应商提前期、
 * 销售订单行、客户认证等商业信息，不能无鉴权公开。
 *
 * 例外：`/api/v1/openapi.json` **保持公开** —— 它是契约文档、不含任何业务数据，
 * 且内部「数据接口」页面也从它渲染。
 *
 * 空 Key 只在非生产环境放行（本地开发/测试）；生产环境为空会被启动自检拦下。
 */
export function registerPublicRoutes(
  app: FastifyInstance,
  publicApiKey: string = config.publicApiKey,
): void {
  app.get('/api/v1/openapi.json', async () => openapiDocument);

  // 用插件作用域挂 onRequest：钩子只作用于本作用域内的路由，
  // 不会波及内部接口（它们有自己的 RBAC）。
  app.register(async (scope) => {
    if (publicApiKey !== '') {
      scope.addHook('onRequest', async (request) => {
        const raw = request.headers['x-api-key'];
        const provided = Array.isArray(raw) ? raw[0] : raw;
        if (typeof provided !== 'string' || !apiKeyMatches(provided, publicApiKey)) {
          throw new ApiError(401, '缺少或无效的 API Key：请在请求头携带 X-API-Key');
        }
      });
    }
    registerPublicDataRoutes(scope);
  });
}

/**
 * 对外只读**数据**接口（/api/v1）：全部 GET。
 * JSON 走统一信封；format=csv 走 text/csv（不套信封）。
 */
function registerPublicDataRoutes(app: FastifyInstance): void {
  app.get('/api/v1/items', async (request, reply) => {
    const query = publicItemsQuerySchema.parse(request.query);
    const result = listPublicItems(query);
    if (query.format === 'csv') return sendCsv(reply, result.list, 'items', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/boms', async (request, reply) => {
    const query = publicBomsQuerySchema.parse(request.query);
    const list = listPublicBoms(query);
    if (query.format === 'csv') return sendCsv(reply, list, 'boms');
    return ok(list);
  });

  app.get('/api/v1/boms/:itemCode/explode', async (request, reply) => {
    const { itemCode } = publicBomExplodeParamSchema.parse(request.params);
    const query = publicBomExplodeQuerySchema.parse(request.query);
    const { data, warnings } = explodePublicBom(itemCode, query);
    if (query.format === 'csv') {
      return sendCsv(reply, data.lines as Row[], `bom-explode-${itemCode}`, warnings);
    }
    return { code: 0, message: 'ok', data, _warnings: warnings };
  });

  app.get('/api/v1/inventory', async (request, reply) => {
    const query = publicInventoryQuerySchema.parse(request.query);
    const result = queryPublicInventory(query);
    if (query.format === 'csv') return sendCsv(reply, result.list, 'inventory', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/in-transit', async (request, reply) => {
    const query = publicInTransitQuerySchema.parse(request.query);
    const result = listPublicInTransit(query);
    if (query.format === 'csv') return sendCsv(reply, result.list, 'in-transit', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/purchase-history', async (request, reply) => {
    const query = publicPurchaseHistoryQuerySchema.parse(request.query);
    const result = listPublicPurchaseHistory(query);
    if (query.format === 'csv') {
      return sendCsv(reply, result.list, 'purchase-history', result.warnings);
    }
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/suppliers/:code/lead-time-stats', async (request, reply) => {
    const { code } = publicSupplierParamSchema.parse(request.params);
    const query = publicLeadTimeStatsQuerySchema.parse(request.query);
    const stats = supplierLeadTimeStats(code, query);
    if (query.format === 'csv') {
      return sendCsv(reply, [stats as unknown as Row], `lead-time-stats-${code}`);
    }
    return ok(stats);
  });

  app.get('/api/v1/sales-orders', async (request, reply) => {
    const query = publicSalesOrdersQuerySchema.parse(request.query);
    const result = listPublicSalesOrders(query);
    if (query.format === 'csv') return sendCsv(reply, result.list, 'sales-orders', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/item-certifications', async (request, reply) => {
    const query = publicCertificationsQuerySchema.parse(request.query);
    const result = listPublicItemCertifications(query);
    if (query.format === 'csv')
      return sendCsv(reply, result.list, 'item-certifications', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/warehouses', async (request, reply) => {
    const query = publicWarehousesQuerySchema.parse(request.query);
    const list = listPublicWarehouses(query);
    if (query.format === 'csv') return sendCsv(reply, list, 'warehouses');
    return ok(list);
  });

  app.get('/api/v1/substitutes', async (request, reply) => {
    const query = publicSubstitutesQuerySchema.parse(request.query);
    const result = listPublicSubstitutes(query);
    if (query.format === 'csv') return sendCsv(reply, result.list, 'substitutes', result.warnings);
    return okPage(result.list, result.page, result.warnings);
  });

  app.get('/api/v1/substitution-plan', async (request, reply) => {
    const query = publicSubstitutionPlanQuerySchema.parse(request.query);
    const { data, warnings } = substitutionPlan(query);
    // CSV 一行 = 一条分配；规划整体返回，page / page_size 不参与切分
    if (query.format === 'csv') {
      return sendCsv(reply, data.allocations, `substitution-plan-${data.main_item_code}`, warnings);
    }
    return { code: 0, message: 'ok', data, _warnings: warnings };
  });
}
