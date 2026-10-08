import {
  alertQuerySchema,
  alertRuleBodySchema,
  alertRuleQuerySchema,
  alertRuleUpdateBodySchema,
  balanceQuerySchema,
  idParamSchema,
  inventoryQuerySchema,
  PERMISSIONS,
  stockStatusChangeBodySchema,
  stockTransactionQuerySchema,
  stocktakeOrderBodySchema,
  stocktakeOrderQuerySchema,
  stocktakeOrderUpdateBodySchema,
  transferOrderBodySchema,
  transferOrderQuerySchema,
  transferOrderUpdateBodySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { ok, okPage } from '../../lib/response';
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  queryAlerts,
  updateAlertRule,
} from './alert.service';
import { changeStockStatus } from './stock.engine';
import { queryBalances, queryStockList, queryTransactions } from './stock.query';
import {
  cancelStocktake,
  createStocktake,
  deleteStocktake,
  getStocktakeDetail,
  listStocktakes,
  postStocktake,
  updateStocktake,
} from './stocktake.service';
import {
  cancelTransfer,
  confirmTransfer,
  createTransfer,
  deleteTransfer,
  getTransferDetail,
  listTransfers,
  receiveTransfer,
  shipTransfer,
  updateTransfer,
} from './transfer.service';

export function registerInventoryRoutes(app: FastifyInstance): void {
  const queryView = { preHandler: app.requirePermission(PERMISSIONS.inventoryQueryView) };
  const transactionView = { preHandler: app.requirePermission(PERMISSIONS.inventoryTransactionView) };
  const statusManage = { preHandler: app.requirePermission(PERMISSIONS.inventoryStatusManage) };
  const transferView = { preHandler: app.requirePermission(PERMISSIONS.inventoryTransferView) };
  const transferManage = { preHandler: app.requirePermission(PERMISSIONS.inventoryTransferManage) };
  const stocktakeView = { preHandler: app.requirePermission(PERMISSIONS.inventoryStocktakeView) };
  const stocktakeManage = { preHandler: app.requirePermission(PERMISSIONS.inventoryStocktakeManage) };
  const alertView = { preHandler: app.requirePermission(PERMISSIONS.inventoryAlertView) };
  const alertManage = { preHandler: app.requirePermission(PERMISSIONS.inventoryAlertManage) };

  // ---------- 库存查询 ----------
  app.get('/api/inventory/stocks', queryView, async (request) => {
    const query = inventoryQuerySchema.parse(request.query);
    const { list, page, portAsInventory, asOf } = queryStockList(query);

    const warnings = [`port_stock_as_inventory=${portAsInventory}`];
    if (asOf) {
      warnings.push(
        `历史时点（${asOf}）仅支持实物量口径 on_hand / frozen；reserved / in_transit / available / projected 依赖单据当时状态、不可还原，返回 null`,
      );
    }
    return okPage(list, page, warnings);
  });

  app.get('/api/inventory/balances', queryView, async (request) => {
    const query = balanceQuerySchema.parse(request.query);
    return ok(queryBalances(query));
  });

  app.get('/api/inventory/transactions', transactionView, async (request) => {
    const query = stockTransactionQuerySchema.parse(request.query);
    const { list, page } = queryTransactions(query);
    return okPage(list, page);
  });

  app.post('/api/inventory/status-change', statusManage, async (request) => {
    const body = stockStatusChangeBodySchema.parse(request.body);
    const transactionIds = changeStockStatus(body);
    return ok({ transactionIds });
  });

  // ---------- 库存调拨 ----------
  app.get('/api/inventory/transfers', transferView, async (request) => {
    const query = transferOrderQuerySchema.parse(request.query);
    const { list, page } = listTransfers(query);
    return okPage(list, page);
  });

  app.get('/api/inventory/transfers/:id', transferView, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(getTransferDetail(id));
  });

  app.post('/api/inventory/transfers', transferManage, async (request) => {
    const body = transferOrderBodySchema.parse(request.body);
    return ok(createTransfer(body, request.user.sub));
  });

  app.patch('/api/inventory/transfers/:id', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = transferOrderUpdateBodySchema.parse(request.body);
    return ok(updateTransfer(id, body));
  });

  app.delete('/api/inventory/transfers/:id', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteTransfer(id));
  });

  app.post('/api/inventory/transfers/:id/confirm', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(confirmTransfer(id));
  });

  app.post('/api/inventory/transfers/:id/cancel', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(cancelTransfer(id));
  });

  app.post('/api/inventory/transfers/:id/ship', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(shipTransfer(id));
  });

  app.post('/api/inventory/transfers/:id/receive', transferManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(receiveTransfer(id));
  });

  // ---------- 库存盘点 ----------
  app.get('/api/inventory/stocktakes', stocktakeView, async (request) => {
    const query = stocktakeOrderQuerySchema.parse(request.query);
    const { list, page } = listStocktakes(query);
    return okPage(list, page);
  });

  app.get('/api/inventory/stocktakes/:id', stocktakeView, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(getStocktakeDetail(id));
  });

  app.post('/api/inventory/stocktakes', stocktakeManage, async (request) => {
    const body = stocktakeOrderBodySchema.parse(request.body);
    return ok(createStocktake(body, request.user.sub));
  });

  app.patch('/api/inventory/stocktakes/:id', stocktakeManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = stocktakeOrderUpdateBodySchema.parse(request.body);
    return ok(updateStocktake(id, body));
  });

  app.delete('/api/inventory/stocktakes/:id', stocktakeManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteStocktake(id));
  });

  app.post('/api/inventory/stocktakes/:id/post', stocktakeManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(postStocktake(id));
  });

  app.post('/api/inventory/stocktakes/:id/cancel', stocktakeManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(cancelStocktake(id));
  });

  // ---------- 库存预警 ----------
  app.get('/api/inventory/alert-rules', alertView, async (request) => {
    const query = alertRuleQuerySchema.parse(request.query);
    const { list, page } = listAlertRules(query);
    return okPage(list, page);
  });

  app.post('/api/inventory/alert-rules', alertManage, async (request) => {
    const body = alertRuleBodySchema.parse(request.body);
    return ok(createAlertRule(body));
  });

  app.patch('/api/inventory/alert-rules/:id', alertManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = alertRuleUpdateBodySchema.parse(request.body);
    return ok(updateAlertRule(id, body));
  });

  app.delete('/api/inventory/alert-rules/:id', alertManage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteAlertRule(id));
  });

  app.get('/api/inventory/alerts', alertView, async (request) => {
    const query = alertQuerySchema.parse(request.query);
    return ok(queryAlerts(query));
  });
}