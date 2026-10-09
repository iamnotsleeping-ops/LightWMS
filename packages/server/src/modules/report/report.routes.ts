import {
  itemMovementQuerySchema,
  ledgerQuerySchema,
  PERMISSIONS,
  stockSnapshotQuerySchema,
  substituteUsageQuerySchema,
  supplierLeadTimeQuerySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { sendCsv } from '../../lib/csv';
import { okPage } from '../../lib/response';
import {
  queryInventoryLedger,
  queryItemMovement,
  queryStockSnapshot,
  querySubstituteUsage,
  querySupplierLeadTime,
} from './report.service';

/**
 * 内部管理报表（/api/reports/*）：需登录 + report.view 权限。
 * format=csv → 同步下载（复用 P7 CSV，不套信封）；否则 JSON 走统一信封。
 *
 * CSV 分支一律以 `{ all: true }` 调用服务层：导出语义是「当前筛选条件下的全部行」，
 * 若沿用分页（默认 pageSize=20）会静默只导出第一页。
 */
export function registerReportRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.reportView) };

  app.get('/api/reports/inventory-ledger', view, async (request, reply) => {
    const query = ledgerQuerySchema.parse(request.query);
    const { list, page, warnings } = queryInventoryLedger(query, { all: query.format === 'csv' });
    if (query.format === 'csv') return sendCsv(reply, list, 'inventory-ledger', warnings);
    return okPage(list, page, warnings);
  });

  app.get('/api/reports/stock-snapshot', view, async (request, reply) => {
    const query = stockSnapshotQuerySchema.parse(request.query);
    const { list, page, warnings } = queryStockSnapshot(query, { all: query.format === 'csv' });
    if (query.format === 'csv') return sendCsv(reply, list, 'stock-snapshot', warnings);
    return okPage(list, page, warnings);
  });

  app.get('/api/reports/item-movement', view, async (request, reply) => {
    const query = itemMovementQuerySchema.parse(request.query);
    const { list, page, warnings } = queryItemMovement(query, { all: query.format === 'csv' });
    if (query.format === 'csv') return sendCsv(reply, list, 'item-movement', warnings);
    return okPage(list, page, warnings);
  });

  app.get('/api/reports/supplier-lead-time', view, async (request, reply) => {
    const query = supplierLeadTimeQuerySchema.parse(request.query);
    const { list, page, warnings } = querySupplierLeadTime(query, { all: query.format === 'csv' });
    if (query.format === 'csv') return sendCsv(reply, list, 'supplier-lead-time', warnings);
    return okPage(list, page, warnings);
  });

  app.get('/api/reports/substitute-usage', view, async (request, reply) => {
    const query = substituteUsageQuerySchema.parse(request.query);
    const { list, page, warnings } = querySubstituteUsage(query, { all: query.format === 'csv' });
    if (query.format === 'csv') return sendCsv(reply, list, 'substitute-usage', warnings);
    return okPage(list, page, warnings);
  });
}