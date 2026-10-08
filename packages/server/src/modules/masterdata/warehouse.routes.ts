import {
  idParamSchema,
  PERMISSIONS,
  warehouseBodySchema,
  warehouseUpdateBodySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/connection';
import { ApiError, ok } from '../../lib/response';
import { buildSet, rethrowConstraint } from '../../lib/sqlite';

const SELECT_LIST = `
  SELECT w.id, w.code, w.name, w.type, w.parent_id, w.is_active, w.created_at, w.updated_at,
         p.name AS parent_name
  FROM warehouse w
  LEFT JOIN warehouse p ON p.id = w.parent_id
  ORDER BY w.type, w.code`;

export function registerWarehouseRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataWarehouseView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataWarehouseManage) };

  app.get('/api/masterdata/warehouses', view, async () => ok(getDb().prepare(SELECT_LIST).all()));

  app.post('/api/masterdata/warehouses', manage, async (request) => {
    const body = warehouseBodySchema.parse(request.body);
    const now = new Date().toISOString();
    try {
      const info = getDb()
        .prepare(
          `INSERT INTO warehouse (code, name, type, parent_id, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.code,
          body.name,
          body.type,
          body.parent_id ?? null,
          body.is_active ?? 1,
          now,
          now,
        );
      return ok({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      rethrowConstraint(error, '仓库编码已存在');
    }
  });

  app.patch('/api/masterdata/warehouses/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = warehouseUpdateBodySchema.parse(request.body);
    const db = getDb();
    if (!db.prepare('SELECT id FROM warehouse WHERE id = ?').get(id)) {
      throw new ApiError(404, '仓库不存在');
    }
    if (body.parent_id === id) throw new ApiError(409, '上级仓库不能是自己');

    const { clause, params } = buildSet([
      ['code', body.code],
      ['name', body.name],
      ['type', body.type],
      ['parent_id', body.parent_id === undefined ? undefined : (body.parent_id ?? null)],
      ['is_active', body.is_active],
    ]);
    if (clause === '') return ok({ id });

    try {
      db.prepare(`UPDATE warehouse SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        new Date().toISOString(),
        id,
      );
    } catch (error) {
      rethrowConstraint(error, '仓库编码已存在');
    }
    return ok({ id });
  });

  app.delete('/api/masterdata/warehouses/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    try {
      getDb().prepare('DELETE FROM warehouse WHERE id = ?').run(id);
    } catch (error) {
      rethrowConstraint(error, '仓库编码已存在');
    }
    return ok({ id });
  });
}