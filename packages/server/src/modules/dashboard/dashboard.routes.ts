import type { FastifyInstance } from 'fastify';
import { ok } from '../../lib/response';
import { dashboardOverview } from './dashboard.service';

/** 首页看板：仅需登录（无独立权限码） */
export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get('/api/dashboard/overview', { preHandler: app.authenticate }, async () =>
    ok(dashboardOverview()),
  );
}