import {
  idParamSchema,
  PERMISSIONS,
  salesOrderBodySchema,
  salesOrderQuerySchema,
  salesOrderUpdateBodySchema,
  salesOutboundBodySchema,
  salesReturnBodySchema,
  salesReturnQuerySchema,
  usesSubstitution,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { loadAuthState } from '../../plugins/auth';
import { ok, okPage } from '../../lib/response';
import { createSalesReturn, shipSales } from './sales.outbound';
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  deleteOrder,
  getOrderDetail,
  listOrders,
  listReturns,
  updateOrder,
} from './sales.service';

export function registerSalesRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.salesOrderView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.salesOrderManage) };
  const confirm = { preHandler: app.requirePermission(PERMISSIONS.salesOrderConfirm) };
  const outbound = { preHandler: app.requirePermission(PERMISSIONS.salesOutboundManage) };

  app.get('/api/sales/orders', view, async (request) => {
    const query = salesOrderQuerySchema.parse(request.query);
    const { list, page } = listOrders(query);
    return okPage(list, page);
  });

  app.get('/api/sales/orders/:id', view, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(getOrderDetail(id));
  });

  app.post('/api/sales/orders', manage, async (request) => {
    const body = salesOrderBodySchema.parse(request.body);
    return ok(createOrder(body, request.user.sub));
  });

  app.patch('/api/sales/orders/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = salesOrderUpdateBodySchema.parse(request.body);
    return ok(updateOrder(id, body));
  });

  app.delete('/api/sales/orders/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteOrder(id));
  });

  app.post('/api/sales/orders/:id/confirm', confirm, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(confirmOrder(id));
  });

  app.post('/api/sales/orders/:id/cancel', confirm, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(cancelOrder(id));
  });

  app.post('/api/sales/outbound', outbound, async (request, reply) => {
    const body = salesOutboundBodySchema.parse(request.body);

    // P10：用替代料出库需要单独的 sales.outbound.substitute 权限，使运维可以按角色
    // 单独收回「替代出库」能力而不影响正常出库（只读的替代建议不受此限制）。
    // 授权以数据库为准（与 requirePermission 同源），不能信任 JWT 里的权限快照。
    if (usesSubstitution(body.lines)) {
      const state = loadAuthState(request.user.sub, PERMISSIONS.salesOutboundSubstitute);
      if (!state || !state.active || !state.allowed) {
        return reply
          .status(403)
          .send({ code: 403, message: '无替代料出库权限', data: null, _warnings: [] });
      }
    }

    return ok(shipSales(body, request.user.sub));
  });

  app.get('/api/sales/returns', view, async (request) => {
    const query = salesReturnQuerySchema.parse(request.query);
    const { list, page } = listReturns(query);
    return okPage(list, page);
  });

  app.post('/api/sales/returns', outbound, async (request) => {
    const body = salesReturnBodySchema.parse(request.body);
    return ok(createSalesReturn(body, request.user.sub));
  });
}