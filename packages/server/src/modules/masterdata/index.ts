import type { FastifyInstance } from 'fastify';
import { registerBomRoutes } from './bom.routes';
import { registerCategoryRoutes } from './category.routes';
import { registerItemRoutes } from './item.routes';
import { registerPartnerRoutes } from './partner.routes';
import { registerWarehouseRoutes } from './warehouse.routes';

export function registerMasterdataRoutes(app: FastifyInstance): void {
  registerCategoryRoutes(app);
  registerItemRoutes(app);
  registerPartnerRoutes(app);
  registerWarehouseRoutes(app);
  registerBomRoutes(app);
}