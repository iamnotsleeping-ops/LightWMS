import {
  publicBomExplodeParamSchema,
  publicBomExplodeQuerySchema,
  publicBomsQuerySchema,
  publicInTransitQuerySchema,
  publicInventoryQuerySchema,
  publicItemsQuerySchema,
  publicLeadTimeStatsQuerySchema,
  publicPurchaseHistoryQuerySchema,
  publicSalesOrdersQuerySchema,
  publicSupplierParamSchema,
  publicWarehousesQuerySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { sendCsv } from '../../lib/csv';
import { ok, okPage } from '../../lib/response';
import { openapiDocument } from './openapi';
import {
  explodePublicBom,
  listPublicBoms,
  listPublicInTransit,
  listPublicItems,
  listPublicPurchaseHistory,
  listPublicSalesOrders,
  listPublicWarehouses,
  queryPublicInventory,
  supplierLeadTimeStats,
} from './public.service';

type Row = Record<string, unknown>;

/**
 * 对外只读数据接口（/api/v1）：全部 GET、**不挂鉴权 preHandler** 即公开。
 * JSON 走统一信封；format=csv 走 text/csv（不套信封）。
 */
export function registerPublicRoutes(app: FastifyInstance): void {
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

  app.get('/api/v1/warehouses', async (request, reply) => {
    const query = publicWarehousesQuerySchema.parse(request.query);
    const list = listPublicWarehouses(query);
    if (query.format === 'csv') return sendCsv(reply, list, 'warehouses');
    return ok(list);
  });

  app.get('/api/v1/openapi.json', async () => openapiDocument);
}