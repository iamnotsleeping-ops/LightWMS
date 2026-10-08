import {
  idParamSchema,
  PERMISSIONS,
  purchaseInboundBodySchema,
  purchaseOrderBodySchema,
  purchaseOrderQuerySchema,
  purchaseOrderUpdateBodySchema,
  purchaseReturnBodySchema,
  purchaseReturnQuerySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { ok, okPage } from '../../lib/response';
import { createPurchaseReturn, receivePurchase } from './purchase.inbound';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  deleteOrder,
  getOrderDetail,
  listOrders,
  listReturns,
  updateOrder,
} from './purchase.service';

export function registerPurchaseRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.purchaseOrderView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.purchaseOrderManage) };
  const confirm = { preHandler: app.requirePermission(PERMISSIONS.purchaseOrderConfirm) };
  const inbound = { preHandler: app.requirePermission(PERMISSIONS.purchaseInboundManage) };

  app.get('/api/purchase/orders', view, async (request) => {
    const query = purchaseOrderQuerySchema.parse(request.query);
    const { list, page } = listOrders(query);
    return okPage(list, page);
  });

  app.get('/api/purchase/orders/:id', view, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(getOrderDetail(id));
  });

  app.post('/api/purchase/orders', manage, async (request) => {
    const body = purchaseOrderBodySchema.parse(request.body);
    return ok(createOrder(body, request.user.sub));
  });

  app.patch('/api/purchase/orders/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = purchaseOrderUpdateBodySchema.parse(request.body);
    return ok(updateOrder(id, body));
  });

  app.delete('/api/purchase/orders/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteOrder(id));
  });

  app.post('/api/purchase/orders/:id/confirm', confirm, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(confirmOrder(id));
  });

  app.post('/api/purchase/orders/:id/cancel', confirm, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(cancelOrder(id));
  });

  app.post('/api/purchase/inbound', inbound, async (request) => {
    const body = purchaseInboundBodySchema.parse(request.body);
    return ok(receivePurchase(body, request.user.sub));
  });

  app.get('/api/purchase/returns', view, async (request) => {
    const query = purchaseReturnQuerySchema.parse(request.query);
    const { list, page } = listReturns(query);
    return okPage(list, page);
  });

  app.post('/api/purchase/returns', inbound, async (request) => {
    const body = purchaseReturnBodySchema.parse(request.body);
    return ok(createPurchaseReturn(body, request.user.sub));
  });
}