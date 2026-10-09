import {
  type SubstituteRelationBody,
  type SubstituteRelationQuery,
  type SubstituteRelationUpdateBody,
  type SubstituteScene,
  type SubstituteStrategy,
  type SubstitutionPlanQuery,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { ApiError, type PageInfo } from '../../lib/response';
import { buildSet, rethrowConstraint } from '../../lib/sqlite';
import { planSubstitution, type SubstitutionPlan } from './substitute.plan';

/**
 * 替代关系主数据维护（P10）。
 *
 * 唯一性口径：`(main_item_id, sub_item_id, scene, COALESCE(parent_item_id,0), COALESCE(warehouse_id,0))`。
 * SQLite 的 UNIQUE 不约束 NULL，所以库里的表达式索引只是**兜底**，真正的拦截必须靠
 * `assertUniqueScope` 的「先查后写」——否则「不限仓库 / 不限父件」的通用关系会被重复插入。
 *
 * 删除是**硬删除**（本项目没有软删除约定）：关系错了就应消失，而不是留一条停用行让
 * 规划仍然读到它。`item_substitute_log` 是只增不改的追溯账，**不随关系删除而清理**：
 * 历史执行事实不因配置变更而消失。
 */

// ---------- 行结构 ----------

/** 列表 DTO：同时带出主料 / 替代料 / 父件 / 仓库的可读编码与名称 */
export interface SubstituteRow {
  id: number;
  main_item_id: number;
  main_item_code: string;
  main_item_name: string;
  sub_item_id: number;
  sub_item_code: string;
  sub_item_name: string;
  parent_item_id: number | null;
  parent_item_code: string | null;
  warehouse_id: number | null;
  warehouse_name: string | null;
  priority: number;
  ratio_num: number;
  ratio_den: number;
  scene: SubstituteScene;
  strategy: SubstituteStrategy;
  effective_from: string | null;
  effective_to: string | null;
  is_active: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

/** 库中原样行（更新时用于与入参合并后再校验） */
interface SubstituteRawRow {
  id: number;
  main_item_id: number;
  sub_item_id: number;
  parent_item_id: number | null;
  warehouse_id: number | null;
  priority: number;
  ratio_num: number;
  ratio_den: number;
  scene: SubstituteScene;
  strategy: SubstituteStrategy;
  effective_from: string | null;
  effective_to: string | null;
  is_active: number;
}

export interface Paged<T> {
  list: T[];
  page: PageInfo;
}

// ---------- SQL 片段 ----------

const ROW_SELECT = `
  SELECT s.id, s.main_item_id, m.code AS main_item_code, m.name AS main_item_name,
         s.sub_item_id, b.code AS sub_item_code, b.name AS sub_item_name,
         s.parent_item_id, p.code AS parent_item_code,
         s.warehouse_id, w.name AS warehouse_name,
         s.priority, s.ratio_num, s.ratio_den, s.scene, s.strategy,
         s.effective_from, s.effective_to, s.is_active, s.remark,
         s.created_at, s.updated_at
    FROM item_substitute s
    JOIN item m ON m.id = s.main_item_id
    JOIN item b ON b.id = s.sub_item_id
    LEFT JOIN item p ON p.id = s.parent_item_id
    LEFT JOIN warehouse w ON w.id = s.warehouse_id`;

const COUNT_FROM = `
  FROM item_substitute s
  JOIN item m ON m.id = s.main_item_id
  JOIN item b ON b.id = s.sub_item_id`;

// ---------- 内部工具 ----------

function toBoolInt(value: boolean | 0 | 1 | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 1 ? 1 : 0;
}

/** 外键来自 JSON 入参，缺失时若不显式报错会变成难懂的 SQLITE_CONSTRAINT_FOREIGNKEY */
function assertItemExists(db: Db, itemId: number, message: string): void {
  const row = db.prepare('SELECT id FROM item WHERE id = ?').get(itemId);
  if (!row) throw new ApiError(400, message);
}

interface SubstituteScope {
  mainItemId: number;
  subItemId: number;
  scene: SubstituteScene;
  parentItemId: number | null;
  warehouseId: number | null;
}

/**
 * 唯一性「先查后写」：SQLite 的 UNIQUE 不约束 NULL，通用关系（父件 / 仓库为空）会绕过
 * 库里的 `uq_item_substitute_scope`，必须在服务层用 COALESCE 显式判重。
 */
function assertUniqueScope(db: Db, scope: SubstituteScope, excludeId?: number): void {
  const row = db
    .prepare(
      `SELECT id FROM item_substitute
        WHERE main_item_id = ? AND sub_item_id = ? AND scene = ?
          AND COALESCE(parent_item_id, 0) = COALESCE(?, 0)
          AND COALESCE(warehouse_id, 0) = COALESCE(?, 0)
          AND id <> ?`,
    )
    .get(
      scope.mainItemId,
      scope.subItemId,
      scope.scene,
      scope.parentItemId,
      scope.warehouseId,
      excludeId ?? -1,
    );
  if (row) throw new ApiError(409, '同一主料/替代料在该场景与范围内已存在替代关系');
}

function loadRaw(db: Db, id: number): SubstituteRawRow {
  const row = db
    .prepare(
      `SELECT id, main_item_id, sub_item_id, parent_item_id, warehouse_id, priority,
              ratio_num, ratio_den, scene, strategy, effective_from, effective_to, is_active
         FROM item_substitute WHERE id = ?`,
    )
    .get(id) as SubstituteRawRow | undefined;
  if (!row) throw new ApiError(404, '替代关系不存在');
  return row;
}

/** 生效期校验：合并「库中现值 + 入参」后判断，避免只改一端时漏检 */
function assertValidity(effectiveFrom: string | null, effectiveTo: string | null): void {
  if (effectiveFrom !== null && effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new ApiError(400, '失效日期不能早于生效日期');
  }
}

// ---------- 关系维护 ----------

export function listSubstitutes(query: SubstituteRelationQuery): Paged<SubstituteRow> {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.keyword) {
    where.push('(m.code LIKE ? OR m.name LIKE ? OR b.code LIKE ? OR b.name LIKE ?)');
    const like = `%${query.keyword}%`;
    params.push(like, like, like, like);
  }
  if (query.mainItemId !== undefined) {
    where.push('s.main_item_id = ?');
    params.push(query.mainItemId);
  }
  if (query.subItemId !== undefined) {
    where.push('s.sub_item_id = ?');
    params.push(query.subItemId);
  }
  if (query.scene !== undefined) {
    where.push('s.scene = ?');
    params.push(query.scene);
  }
  if (query.isActive !== undefined) {
    where.push('s.is_active = ?');
    params.push(query.isActive);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total ${COUNT_FROM} ${clause}`)
    .get(...params) as { total: number };

  const list = db
    .prepare(
      `${ROW_SELECT} ${clause} ORDER BY m.code, s.priority, b.code LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as SubstituteRow[];

  return { list, page: { page: query.page, pageSize: query.pageSize, total } };
}

export function createSubstitute(
  body: SubstituteRelationBody,
  userId: number | null,
): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    assertItemExists(db, body.mainItemId, '主料不存在');
    assertItemExists(db, body.subItemId, '替代料不存在');

    const scope: SubstituteScope = {
      mainItemId: body.mainItemId,
      subItemId: body.subItemId,
      scene: body.scene,
      parentItemId: body.parentItemId ?? null,
      warehouseId: body.warehouseId ?? null,
    };
    assertUniqueScope(db, scope);

    const now = new Date().toISOString();
    try {
      const info = db
        .prepare(
          `INSERT INTO item_substitute
             (main_item_id, sub_item_id, parent_item_id, warehouse_id, priority,
              ratio_num, ratio_den, scene, strategy, effective_from, effective_to,
              is_active, remark, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.mainItemId,
          scope.subItemId,
          scope.parentItemId,
          scope.warehouseId,
          body.priority,
          body.ratioNum,
          body.ratioDen,
          scope.scene,
          body.strategy,
          body.effectiveFrom ?? null,
          body.effectiveTo ?? null,
          toBoolInt(body.isActive) ?? 1,
          body.remark ?? null,
          userId,
          now,
          now,
        );
      return { id: Number(info.lastInsertRowid) };
    } catch (error) {
      // 先查后写与并发插入之间存在窗口，唯一索引是最后一道兜底
      rethrowConstraint(error, '同一主料/替代料在该场景与范围内已存在替代关系');
    }
  })();
}

export function updateSubstitute(
  id: number,
  body: SubstituteRelationUpdateBody,
): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    const existing = loadRaw(db, id);

    // 未提供的字段保持库中现值；显式 null 的父件 / 仓库表示「放开为通用」
    const parentItemId =
      body.parentItemId === undefined ? existing.parent_item_id : (body.parentItemId ?? null);
    const warehouseId =
      body.warehouseId === undefined ? existing.warehouse_id : (body.warehouseId ?? null);
    const scene = body.scene ?? existing.scene;
    const effectiveFrom =
      body.effectiveFrom === undefined ? existing.effective_from : body.effectiveFrom;
    const effectiveTo = body.effectiveTo === undefined ? existing.effective_to : body.effectiveTo;

    assertValidity(effectiveFrom, effectiveTo);

    const scopeChanged =
      parentItemId !== existing.parent_item_id ||
      warehouseId !== existing.warehouse_id ||
      scene !== existing.scene;
    if (scopeChanged) {
      assertUniqueScope(
        db,
        {
          mainItemId: existing.main_item_id,
          subItemId: existing.sub_item_id,
          scene,
          parentItemId,
          warehouseId,
        },
        id,
      );
    }

    const now = new Date().toISOString();
    const { clause, params } = buildSet([
      ['parent_item_id', body.parentItemId === undefined ? undefined : parentItemId],
      ['warehouse_id', body.warehouseId === undefined ? undefined : warehouseId],
      ['priority', body.priority],
      ['ratio_num', body.ratioNum],
      ['ratio_den', body.ratioDen],
      ['scene', body.scene],
      ['strategy', body.strategy],
      ['effective_from', body.effectiveFrom === undefined ? undefined : effectiveFrom],
      ['effective_to', body.effectiveTo === undefined ? undefined : effectiveTo],
      ['is_active', toBoolInt(body.isActive)],
      ['remark', body.remark],
    ]);

    try {
      if (clause !== '') {
        db.prepare(`UPDATE item_substitute SET ${clause}, updated_at = ? WHERE id = ?`).run(
          ...params,
          now,
          id,
        );
      } else {
        db.prepare('UPDATE item_substitute SET updated_at = ? WHERE id = ?').run(now, id);
      }
    } catch (error) {
      rethrowConstraint(error, '同一主料/替代料在该场景与范围内已存在替代关系');
    }
    return { id };
  })();
}

/** 硬删除：本项目无软删除约定；追溯账 `item_substitute_log` 不在此清理 */
export function deleteSubstitute(id: number): { id: number } {
  const db = getDb();
  return db.transaction(() => {
    loadRaw(db, id);
    db.prepare('DELETE FROM item_substitute WHERE id = ?').run(id);
    return { id };
  })();
}

// ---------- 规划适配 ----------

/**
 * 把 HTTP 查询参数（逗号分隔字符串）解析成物料 id 数组。
 * 非正整数的脏参数直接 400，而不是静默丢弃后给出一个"看起来没错"的规划结果。
 */
function parseManualItemIds(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
  const ids: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      throw new ApiError(400, 'manualItemIds 必须是逗号分隔的正整数');
    }
    const value = Number(token);
    if (value <= 0) throw new ApiError(400, 'manualItemIds 必须是逗号分隔的正整数');
    ids.push(value);
  }
  return ids.length > 0 ? ids : undefined;
}

/** 薄适配层：查询参数 → `planSubstitution` 的 camelCase 请求，不改变任何规划口径 */
export function planForQuery(query: SubstitutionPlanQuery): SubstitutionPlan {
  return planSubstitution({
    mainItemId: query.mainItemId,
    warehouseId: query.warehouseId,
    requiredQty: query.requiredQty,
    scene: query.scene,
    customerId: query.customerId ?? null,
    parentItemId: query.parentItemId ?? null,
    strategy: query.strategy,
    manualItemIds: parseManualItemIds(query.manualItemIds),
    asOf: query.asOf ?? null,
  });
}
