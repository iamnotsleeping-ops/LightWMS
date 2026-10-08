import {
  bomBodySchema,
  bomExplodeQuerySchema,
  bomQuerySchema,
  bomUpdateBodySchema,
  idParamSchema,
  PERMISSIONS,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/connection';
import { ApiError, ok } from '../../lib/response';
import { buildSet, rethrowConstraint } from '../../lib/sqlite';
import { assertBomNoOverlap, explodeBom, listBoms } from './bom.service';

export function registerBomRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataBomView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataBomManage) };

  app.get('/api/masterdata/boms', view, async (request) => {
    const query = bomQuerySchema.parse(request.query);
    return ok(listBoms(query));
  });

  app.get('/api/masterdata/boms/explode', view, async (request) => {
    const query = bomExplodeQuerySchema.parse(request.query);
    const result = explodeBom(query);
    return { code: 0, message: 'ok', data: result, _warnings: result.warnings };
  });

  app.post('/api/masterdata/boms', manage, async (request) => {
    const body = bomBodySchema.parse(request.body);
    if (body.parent_item_id === body.child_item_id) {
      throw new ApiError(409, '父件与子件不能是同一个物料');
    }
    assertBomNoOverlap(
      body.parent_item_id,
      body.child_item_id,
      body.effective_from ?? null,
      body.effective_to ?? null,
    );
    const now = new Date().toISOString();
    try {
      const info = getDb()
        .prepare(
          `INSERT INTO bom (parent_item_id, child_item_id, qty_per, scrap_rate,
                            effective_from, effective_to, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          body.parent_item_id,
          body.child_item_id,
          body.qty_per,
          body.scrap_rate ?? 0,
          body.effective_from ?? null,
          body.effective_to ?? null,
          now,
          now,
        );
      return ok({ id: Number(info.lastInsertRowid) });
    } catch (error) {
      rethrowConstraint(error, '同一父件、子件与生效日期只能存在一条 BOM 版本');
    }
  });

  app.patch('/api/masterdata/boms/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = bomUpdateBodySchema.parse(request.body);
    const db = getDb();
    const current = db
      .prepare(
        `SELECT parent_item_id, child_item_id, effective_from, effective_to
           FROM bom WHERE id = ?`,
      )
      .get(id) as
      | {
          parent_item_id: number;
          child_item_id: number;
          effective_from: string | null;
          effective_to: string | null;
        }
      | undefined;
    if (!current) {
      throw new ApiError(404, 'BOM 记录不存在');
    }

    // 生效期以「合并后的值」参与重叠校验，避免仅改用量时误判
    const nextFrom =
      body.effective_from === undefined ? current.effective_from : (body.effective_from ?? null);
    const nextTo =
      body.effective_to === undefined ? current.effective_to : (body.effective_to ?? null);
    assertBomNoOverlap(
      current.parent_item_id,
      current.child_item_id,
      nextFrom,
      nextTo,
      id,
    );

    const { clause, params } = buildSet([
      ['qty_per', body.qty_per],
      ['scrap_rate', body.scrap_rate],
      ['effective_from', body.effective_from === undefined ? undefined : nextFrom],
      ['effective_to', body.effective_to === undefined ? undefined : nextTo],
    ]);
    if (clause === '') return ok({ id });

    try {
      db.prepare(`UPDATE bom SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...params,
        new Date().toISOString(),
        id,
      );
    } catch (error) {
      rethrowConstraint(error, '同一父件、子件与生效日期只能存在一条 BOM 版本');
    }
    return ok({ id });
  });

  app.delete('/api/masterdata/boms/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    try {
      getDb().prepare('DELETE FROM bom WHERE id = ?').run(id);
    } catch (error) {
      rethrowConstraint(error, 'BOM 记录删除失败');
    }
    return ok({ id });
  });
}