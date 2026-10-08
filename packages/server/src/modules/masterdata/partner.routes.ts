import {
  idParamSchema,
  partnerBodySchema,
  partnerQuerySchema,
  partnerUpdateBodySchema,
  PERMISSIONS,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/connection';
import { ApiError, ok, okPage } from '../../lib/response';
import { buildSet, rethrowConstraint } from '../../lib/sqlite';

const SELECT_BASE = `
  SELECT p.id, p.code, p.name, p.type, p.contact, p.phone, p.address, p.is_active,
         p.created_at, p.updated_at
  FROM partner p`;

export function registerPartnerRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataPartnerView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataPartnerManage) };

  app.get('/api/masterdata/partners', view, async (request) => {
    const query = partnerQuerySchema.parse(request.query);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.keyword) {
      where.push('(p.code LIKE ? OR p.name LIKE ?)');
      params.push(`%${query.keyword}%`, `%${query.keyword}%`);
    }
    if (query.type) {
      // both 类型的单位同时出现在客户与供应商筛选结果中
      where.push(query.type === 'both' ? 'p.type = ?' : '(p.type = ? OR p.type = ?)');
      params.push(query.type, ...(query.type === 'both' ? [] : ['both']));
    }
    if (query.isActive) {
      where.push('p.is_active = ?');
      params.push(Number(query.isActive));
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM partner p ${clause}`)
      .get(...params) as { total: number };
    const list = db
      .prepare(`${SELECT_BASE} ${clause} ORDER BY p.code LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);

    return okPage(list, { page: query.page, pageSize: query.pageSize, total });
  });

  app.post('/api/masterdata/partners', manage, async (request) => {
    const body = partnerBodySchema.parse(request.body);
    const now = new Date().toISOString();
    try {
      const info = getDb()
        .prepare(
          `INSERT INTO partner (code, name, type, contact, phone, address, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.code,
          body.name,
          body.type,
          body.contact ?? null,
          body.phone ?? null,
          body.address ?? null,
          body.is_active ?? 1,
          now,
          now,
        );
      return ok({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      rethrowConstraint(error, '往来单位编码已存在');
    }
  });

  app.patch('/api/masterdata/partners/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = partnerUpdateBodySchema.parse(request.body);
    const db = getDb();
    if (!db.prepare('SELECT id FROM partner WHERE id = ?').get(id)) {
      throw new ApiError(404, '往来单位不存在');
    }

    const optional = (value: string | undefined): string | null | undefined =>
      value === undefined ? undefined : value || null;
    const { clause, params } = buildSet([
      ['code', body.code],
      ['name', body.name],
      ['type', body.type],
      ['contact', optional(body.contact)],
      ['phone', optional(body.phone)],
      ['address', optional(body.address)],
      ['is_active', body.is_active],
    ]);
    if (clause === '') return ok({ id });

    try {
      db.prepare(`UPDATE partner SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        new Date().toISOString(),
        id,
      );
    } catch (error) {
      rethrowConstraint(error, '往来单位编码已存在');
    }
    return ok({ id });
  });

  app.delete('/api/masterdata/partners/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    try {
      getDb().prepare('DELETE FROM partner WHERE id = ?').run(id);
    } catch (error) {
      rethrowConstraint(error, '往来单位编码已存在');
    }
    return ok({ id });
  });
}