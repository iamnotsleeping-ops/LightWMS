import { categoryBodySchema, categoryUpdateBodySchema, idParamSchema, PERMISSIONS } from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/connection';
import { ApiError, ok } from '../../lib/response';
import { buildSet, rethrowConstraint } from '../../lib/sqlite';

const SELECT_LIST = `
  SELECT c.id, c.code, c.name, c.capacity_group, c.parent_id, c.is_active,
         p.name AS parent_name,
         (SELECT COUNT(*) FROM item i WHERE i.category_id = c.id) AS item_count
  FROM item_category c
  LEFT JOIN item_category p ON p.id = c.parent_id
  ORDER BY c.code IS NULL, c.code`;

export function registerCategoryRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataCategoryView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataCategoryManage) };

  app.get('/api/masterdata/categories', view, async () => ok(getDb().prepare(SELECT_LIST).all()));

  app.post('/api/masterdata/categories', manage, async (request) => {
    const body = categoryBodySchema.parse(request.body);
    const now = new Date().toISOString();
    try {
      const info = getDb()
        .prepare(
          `INSERT INTO item_category (code, name, capacity_group, parent_id, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.code ?? null,
          body.name,
          body.capacity_group ?? null,
          body.parent_id ?? null,
          body.is_active ?? 1,
          now,
          now,
        );
      return ok({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      rethrowConstraint(error, '分类编码已存在');
    }
  });

  app.patch('/api/masterdata/categories/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = categoryUpdateBodySchema.parse(request.body);
    const db = getDb();
    if (!db.prepare('SELECT id FROM item_category WHERE id = ?').get(id)) {
      throw new ApiError(404, '分类不存在');
    }
    if (body.parent_id === id) throw new ApiError(409, '上级分类不能是自己');

    const { clause, params } = buildSet([
      ['code', body.code === undefined ? undefined : body.code || null],
      ['name', body.name],
      ['capacity_group', body.capacity_group === undefined ? undefined : body.capacity_group || null],
      ['parent_id', body.parent_id === undefined ? undefined : (body.parent_id ?? null)],
      ['is_active', body.is_active],
    ]);
    if (clause === '') return ok({ id });

    try {
      db.prepare(
        `UPDATE item_category SET ${clause}, updated_at = ? WHERE id = ?`,
      ).run(...params, new Date().toISOString(), id);
    } catch (error) {
      rethrowConstraint(error, '分类编码已存在');
    }
    return ok({ id });
  });

  app.delete('/api/masterdata/categories/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    try {
      getDb().prepare('DELETE FROM item_category WHERE id = ?').run(id);
    } catch (error) {
      rethrowConstraint(error, '分类编码已存在');
    }
    return ok({ id });
  });
}