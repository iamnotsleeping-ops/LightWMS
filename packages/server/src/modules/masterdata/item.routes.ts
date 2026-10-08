import {
  idParamSchema,
  itemBodySchema,
  itemCertificationBodySchema,
  itemQuerySchema,
  itemUpdateBodySchema,
  PERMISSIONS,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/connection';
import { ApiError, ok, okPage } from '../../lib/response';
import { buildSet, rethrowConstraint, todayIso } from '../../lib/sqlite';

const SELECT_BASE = `
  SELECT i.id, i.code, i.name, i.base_unit, i.category_id, i.is_active, i.qty_precision,
         i.inspection_required, i.batch_managed, i.serial_managed, i.created_at, i.updated_at,
         c.code AS category_code, c.name AS category_name, c.capacity_group
  FROM item i
  LEFT JOIN item_category c ON c.id = i.category_id`;

export function registerItemRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataItemView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataItemManage) };

  app.get('/api/masterdata/items', view, async (request) => {
    const query = itemQuerySchema.parse(request.query);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword) {
      where.push('(i.code LIKE ? OR i.name LIKE ?)');
      params.push(`%${query.keyword}%`, `%${query.keyword}%`);
    }
    if (query.categoryId) {
      where.push('i.category_id = ?');
      params.push(query.categoryId);
    }
    if (query.isActive) {
      where.push('i.is_active = ?');
      params.push(Number(query.isActive));
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM item i ${clause}`)
      .get(...params) as { total: number };
    const list = db
      .prepare(`${SELECT_BASE} ${clause} ORDER BY i.code LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);

    return okPage(list, { page: query.page, pageSize: query.pageSize, total });
  });

  app.get('/api/masterdata/items/:id', view, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const db = getDb();
    const item = db.prepare(`${SELECT_BASE} WHERE i.id = ?`).get(id);
    if (!item) throw new ApiError(404, '物料不存在');
    const certifications = db
      .prepare(
        `SELECT cert.customer_id, p.code, p.name, cert.certified_at, cert.expire_at
         FROM item_customer_certification cert
         JOIN partner p ON p.id = cert.customer_id
         WHERE cert.item_id = ? ORDER BY p.code`,
      )
      .all(id);
    return ok({ ...(item as Record<string, unknown>), certifications });
  });

  app.post('/api/masterdata/items', manage, async (request) => {
    const body = itemBodySchema.parse(request.body);
    const now = new Date().toISOString();
    try {
      const info = getDb()
        .prepare(
          `INSERT INTO item (code, name, base_unit, category_id, is_active, qty_precision,
                             inspection_required, batch_managed, serial_managed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.code,
          body.name,
          body.base_unit,
          body.category_id ?? null,
          body.is_active ?? 1,
          body.qty_precision ?? 0,
          body.inspection_required ?? 0,
          body.batch_managed ?? 0,
          body.serial_managed ?? 0,
          now,
          now,
        );
      return ok({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      rethrowConstraint(error, '物料编码已存在');
    }
  });

  app.patch('/api/masterdata/items/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = itemUpdateBodySchema.parse(request.body);
    const db = getDb();
    if (!db.prepare('SELECT id FROM item WHERE id = ?').get(id)) {
      throw new ApiError(404, '物料不存在');
    }

    const { clause, params } = buildSet([
      ['code', body.code],
      ['name', body.name],
      ['base_unit', body.base_unit],
      ['category_id', body.category_id === undefined ? undefined : (body.category_id ?? null)],
      ['is_active', body.is_active],
      ['qty_precision', body.qty_precision],
      ['inspection_required', body.inspection_required],
      ['batch_managed', body.batch_managed],
      ['serial_managed', body.serial_managed],
    ]);
    if (clause === '') return ok({ id });

    try {
      db.prepare(`UPDATE item SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        new Date().toISOString(),
        id,
      );
    } catch (error) {
      rethrowConstraint(error, '物料编码已存在');
    }
    return ok({ id });
  });

  app.delete('/api/masterdata/items/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    try {
      getDb().prepare('DELETE FROM item WHERE id = ?').run(id);
    } catch (error) {
      rethrowConstraint(error, '物料编码已存在');
    }
    return ok({ id });
  });

  // 需客户认证的客户：整体替换关联表，不使用逗号拼接字符串
  app.put('/api/masterdata/items/:id/certifications', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = itemCertificationBodySchema.parse(request.body);
    const db = getDb();
    const run = db.transaction(() => {
      if (!db.prepare('SELECT id FROM item WHERE id = ?').get(id)) {
        throw new ApiError(404, '物料不存在');
      }
      db.prepare('DELETE FROM item_customer_certification WHERE item_id = ?').run(id);
      const insert = db.prepare(
        `INSERT INTO item_customer_certification (item_id, customer_id, certified_at)
         VALUES (?, ?, ?)`,
      );
      for (const customerId of body.customerIds) insert.run(id, customerId, todayIso());
    });
    try {
      run();
    } catch (error) {
      rethrowConstraint(error, '客户已存在或不存在');
    }
    return ok({ id });
  });
}