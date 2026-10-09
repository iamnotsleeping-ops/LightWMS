import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config/index';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.routes';
import { registerInventoryRoutes } from './modules/inventory/routes';
import { registerMasterdataRoutes } from './modules/masterdata';
import { registerPurchaseRoutes } from './modules/purchase/routes';
import { registerPublicRoutes } from './modules/public-api/public.routes';
import { registerReportRoutes } from './modules/report/report.routes';
import { registerSalesRoutes } from './modules/sales/routes';
import { registerSubstituteRoutes } from './modules/substitute/substitute.routes';
import { registerSystemRoutes } from './modules/system/routes';
import { registerAuth } from './plugins/auth';
import { registerErrorHandler } from './plugins/error-handler';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.env === 'development' ? 'info' : 'warn' },
  });

  registerErrorHandler(app);
  await app.register(cors, { origin: true });
  await registerAuth(app);

  app.get('/health', async () => ({
    code: 0,
    message: 'ok',
    data: { status: 'up', env: config.env, auth_provider: config.auth.provider },
  }));

  registerAuthRoutes(app);
  registerSystemRoutes(app);
  registerMasterdataRoutes(app);
  registerSubstituteRoutes(app);
  registerInventoryRoutes(app);
  registerPurchaseRoutes(app);
  registerSalesRoutes(app);
  registerPublicRoutes(app);
  registerReportRoutes(app);
  registerDashboardRoutes(app);

  return app;
}