import { PERMISSIONS } from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createAuthorizedUser, createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { postMovement } from '../inventory/stock.engine';
import { planForQuery } from './substitute.service';

/**
 * 替代关系主数据（service + 内部路由）的接口测试。
 *
 * 走 HTTP 是为了同时覆盖「schema 校验 → 服务层校验 → 统一信封」这条真实链路；
 * 规划接口则额外直接调用 `planForQuery` 验证薄适配层。替代关系本身在
 * 设置阶段**直接写 SQL**（不经服务），避免用被测代码搭建无关用例的前置数据。
 */

const VIEW = PERMISSIONS.masterdataSubstituteView;
const MANAGE = PERMISSIONS.masterdataSubstituteManage;
const NOW = '2026-06-01T00:00:00.000Z';

let db: Db;
let app: FastifyInstance;
let fx: Fixtures;

beforeEach(async () => {
  db = createTestDb();
  fx = seedFixtures(db);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

// ---------- 夹具与工具 ----------

interface PageEnvelope {
  code: number;
  message: string;
  data: SubstituteDto[];
  page: { page: number; pageSize: number; total: number };
  _warnings: unknown[];
}

interface DataEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

interface ErrorEnvelope {
  code: number;
  message: string;
  data: null;
  _warnings: { field?: string; message: string }[];
}

interface SubstituteDto {
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
  scene: string;
  strategy: string;
  effective_from: string | null;
  effective_to: string | null;
  is_active: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

interface RelationRow {
  id: number;
  main_item_id: number;
  sub_item_id: number;
  parent_item_id: number | null;
  warehouse_id: number | null;
  priority: number;
  ratio_num: number;
  ratio_den: number;
  scene: string;
  strategy: string;
  effective_from: string | null;
  effective_to: string | null;
  is_active: number;
  remark: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

interface PlanDto {
  mainItemId: number;
  mainItemCode: string;
  warehouseId: number;
  requiredQty: number;
  strategy: string;
  allocations: { itemId: number; itemCode: string; quantity: number; isMain: boolean }[];
  filledQty: number;
  gapQty: number;
  skipped: { itemId: number; itemCode: string; reason: string }[];
  warnings: string[];
}

type Body = Record<string, unknown>;

function tokenWith(permissions: string[]): string {
  return app.jwt.sign({
    sub: createAuthorizedUser(db, permissions),
    name: 'tester',
    roles: [],
    permissions,
  });
}

const viewToken = (): string => tokenWith([VIEW]);
const manageToken = (): string => tokenWith([VIEW, MANAGE]);

const auth = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

function get(url: string, token?: string) {
  return app.inject({ method: 'GET', url, headers: token ? auth(token) : {} });
}

function post(url: string, payload: Body, token?: string) {
  return app.inject({ method: 'POST', url, headers: token ? auth(token) : {}, payload });
}

function patch(url: string, payload: Body, token?: string) {
  return app.inject({ method: 'PATCH', url, headers: token ? auth(token) : {}, payload });
}

function del(url: string, token?: string) {
  return app.inject({ method: 'DELETE', url, headers: token ? auth(token) : {} });
}

function makeItem(code: string, name = `物料${code}`): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
         VALUES (?, ?, 'EA', 1, 0, 0, ?, ?)`,
      )
      .run(code, name, now, now).lastInsertRowid,
  );
}

interface RelationOptions {
  warehouseId?: number | null;
  parentItemId?: number | null;
  priority?: number;
  ratioNum?: number;
  ratioDen?: number;
  scene?: string;
  strategy?: string;
  isActive?: 0 | 1;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** 直接写库构造替代关系：设置阶段不经被测服务 */
function insertRelation(
  mainItemId: number,
  subItemId: number,
  options: RelationOptions = {},
): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO item_substitute
           (main_item_id, sub_item_id, parent_item_id, warehouse_id, priority, ratio_num, ratio_den,
            scene, strategy, effective_from, effective_to, is_active, remark, created_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        mainItemId,
        subItemId,
        options.parentItemId ?? null,
        options.warehouseId ?? null,
        options.priority ?? 1,
        options.ratioNum ?? 1,
        options.ratioDen ?? 1,
        options.scene ?? 'sales_out',
        options.strategy ?? 'proportion',
        options.effectiveFrom ?? null,
        options.effectiveTo ?? null,
        options.isActive ?? 1,
        now,
        now,
      ).lastInsertRowid,
  );
}

function dbRelation(id: number): RelationRow {
  const row = db.prepare('SELECT * FROM item_substitute WHERE id = ?').get(id) as
    | RelationRow
    | undefined;
  if (!row) throw new Error(`替代关系 ${id} 不存在`);
  return row;
}

function countRelation(id: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM item_substitute WHERE id = ?').get(id) as {
    n: number;
  }).n;
}

function countAllRelations(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM item_substitute').get() as { n: number }).n;
}

function stock(itemId: number, qty: number, warehouseId = fx.warehouseId): void {
  if (qty <= 0) return;
  postMovement({
    productId: itemId,
    warehouseId,
    stockStatus: 'available',
    bizType: 'adjust',
    direction: 1,
    quantity: qty,
    unitCost: 500,
    occurredAt: NOW,
  });
}

// ---------- 创建与列表 ----------

describe('替代关系 · 创建与列表', () => {
  it('创建后列表返回 join 出的编码/名称与默认值', async () => {
    const subId = makeItem('RM-SUB-1', '替代件');
    const token = manageToken();

    const created = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId },
      token,
    );
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as DataEnvelope<{ id: number }>;
    expect(createdBody.code).toBe(0);
    expect(typeof createdBody.data.id).toBe('number');

    const response = await get('/api/masterdata/substitutes', tokenWith([VIEW]));
    expect(response.statusCode).toBe(200);
    const payload = response.json() as PageEnvelope;
    expect(payload.page).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      id: createdBody.data.id,
      main_item_id: fx.itemId,
      main_item_code: 'RM-001',
      main_item_name: '测试零件',
      sub_item_id: subId,
      sub_item_code: 'RM-SUB-1',
      sub_item_name: '替代件',
      parent_item_id: null,
      parent_item_code: null,
      warehouse_id: null,
      warehouse_name: null,
      priority: 1,
      ratio_num: 1,
      ratio_den: 1,
      scene: 'sales_out',
      strategy: 'proportion',
      effective_from: null,
      effective_to: null,
      is_active: 1,
      remark: null,
    });

    // 显式给仓库/父件时列表要带出可读名称，便于页面直接展示
    const warehouseCreated = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, warehouseId: fx.warehouseId },
      token,
    );
    expect(warehouseCreated.statusCode).toBe(200);
    const again = (await get(
      `/api/masterdata/substitutes?mainItemId=${fx.itemId}&keyword=SUB-1`,
      tokenWith([VIEW]),
    )).json() as PageEnvelope;
    const withWarehouse = again.data.find((row) => row.warehouse_id === fx.warehouseId);
    expect(withWarehouse).toMatchObject({ warehouse_name: '一号仓', parent_item_code: null });
  });

  it('列表支持关键字/主料/场景/启用状态过滤，并分页', async () => {
    const item2 = makeItem('RM-002', '二号零件');
    const subA = makeItem('RM-SUB-A');
    const subB = makeItem('RM-SUB-B');
    const subC = makeItem('RM-SUB-C');
    const subD = makeItem('RM-SUB-D');

    insertRelation(fx.itemId, subA, { priority: 1 });
    insertRelation(fx.itemId, subB, { priority: 2 });
    insertRelation(item2, subC, { priority: 1 });
    insertRelation(item2, subD, { priority: 3, isActive: 0 });

    const token = viewToken();
    const all = (await get('/api/masterdata/substitutes', token)).json() as PageEnvelope;
    expect(all.page.total).toBe(4);
    // 排序：主料编码 → 优先级 → 替代料编码
    expect(all.data.map((row) => row.sub_item_code)).toEqual([
      'RM-SUB-A',
      'RM-SUB-B',
      'RM-SUB-C',
      'RM-SUB-D',
    ]);

    const byMain = (await get(`/api/masterdata/substitutes?mainItemId=${fx.itemId}`, token))
      .json() as PageEnvelope;
    expect(byMain.page.total).toBe(2);

    const byKeyword = (await get('/api/masterdata/substitutes?keyword=SUB-B', token))
      .json() as PageEnvelope;
    expect(byKeyword.data.map((row) => row.sub_item_code)).toEqual(['RM-SUB-B']);

    const byScene = (await get('/api/masterdata/substitutes?scene=bom_plan', token))
      .json() as PageEnvelope;
    expect(byScene.page.total).toBe(0);

    const byActive = (await get('/api/masterdata/substitutes?isActive=0', token))
      .json() as PageEnvelope;
    expect(byActive.data.map((row) => row.sub_item_code)).toEqual(['RM-SUB-D']);

    const paged = (await get('/api/masterdata/substitutes?page=2&pageSize=3', token))
      .json() as PageEnvelope;
    expect(paged.page).toEqual({ page: 2, pageSize: 3, total: 4 });
    expect(paged.data.map((row) => row.sub_item_code)).toEqual(['RM-SUB-D']);
  });

  it('主料与替代料相同 → 400（schema 拦住，不落库）', async () => {
    const response = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: fx.itemId },
      manageToken(),
    );
    expect(response.statusCode).toBe(400);
    expect(countAllRelations()).toBe(0);
  });

  it('失效日期早于生效日期 → 400', async () => {
    const subId = makeItem('RM-SUB-1');
    const response = await post(
      '/api/masterdata/substitutes',
      {
        mainItemId: fx.itemId,
        subItemId: subId,
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-05-31',
      },
      manageToken(),
    );
    expect(response.statusCode).toBe(400);
    expect(countAllRelations()).toBe(0);
  });

  it('主料 / 替代料不存在 → 400 且给出可读提示', async () => {
    const token = manageToken();
    const subId = makeItem('RM-SUB-1');

    const missingMain = await post(
      '/api/masterdata/substitutes',
      { mainItemId: 999999, subItemId: subId },
      token,
    );
    expect(missingMain.statusCode).toBe(400);
    expect((missingMain.json() as ErrorEnvelope).message).toBe('主料不存在');

    const missingSub = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: 999999 },
      token,
    );
    expect(missingSub.statusCode).toBe(400);
    expect((missingSub.json() as ErrorEnvelope).message).toBe('替代料不存在');
    expect(countAllRelations()).toBe(0);
  });
});

// ---------- 唯一性 ----------

describe('替代关系 · 范围唯一性（COALESCE）', () => {
  it('同一范围重复创建 → 409 且提示已存在', async () => {
    const subId = makeItem('RM-SUB-1');
    const token = manageToken();
    const body: Body = { mainItemId: fx.itemId, subItemId: subId };

    expect((await post('/api/masterdata/substitutes', body, token)).statusCode).toBe(200);
    const duplicate = await post('/api/masterdata/substitutes', body, token);

    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as ErrorEnvelope).message).toBe(
      '同一主料/替代料在该场景与范围内已存在替代关系',
    );
    expect(countAllRelations()).toBe(1);
  });

  it('同主料 / 替代料：限定仓库的行与不限仓库的通用行可共存', async () => {
    const subId = makeItem('RM-SUB-1');
    const token = manageToken();

    const generic = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId },
      token,
    );
    const scoped = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, warehouseId: fx.warehouseId },
      token,
    );

    expect(generic.statusCode).toBe(200);
    expect(scoped.statusCode).toBe(200);
    expect(countAllRelations()).toBe(2);

    // 同仓库再来一条仍被拦（越过 NULL 的重复必须由服务层 COALESCE 判重兜住）
    const duplicateScoped = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, warehouseId: fx.warehouseId },
      token,
    );
    expect(duplicateScoped.statusCode).toBe(409);

    // 换场景即换分区，可以再建一条同范围关系
    const otherScene = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, scene: 'bom_plan' },
      token,
    );
    expect(otherScene.statusCode).toBe(200);
    expect(countAllRelations()).toBe(3);
  });
});

// ---------- 更新 ----------

describe('替代关系 · 更新', () => {
  it('只改提供的字段，并刷新 updated_at', async () => {
    const subId = makeItem('RM-SUB-1');
    const token = manageToken();
    const created = await post(
      '/api/masterdata/substitutes',
      {
        mainItemId: fx.itemId,
        subItemId: subId,
        priority: 3,
        ratioNum: 2,
        ratioDen: 3,
        scene: 'bom_plan',
        effectiveFrom: '2026-06-01',
        remark: '初始备注',
      },
      token,
    );
    const id = (created.json() as DataEnvelope<{ id: number }>).data.id;

    const before = dbRelation(id);
    db.prepare('UPDATE item_substitute SET updated_at = ? WHERE id = ?').run(
      '2000-01-01T00:00:00.000Z',
      id,
    );

    const updated = await patch(`/api/masterdata/substitutes/${id}`, { priority: 9 }, token);
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as DataEnvelope<{ id: number }>).data).toEqual({ id });

    const after = dbRelation(id);
    expect(after.priority).toBe(9);
    // 未提供的字段原样保留
    expect(after).toMatchObject({
      ratio_num: 2,
      ratio_den: 3,
      scene: 'bom_plan',
      effective_from: '2026-06-01',
      effective_to: null,
      is_active: 1,
      remark: '初始备注',
      created_at: before.created_at,
    });
    expect(after.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('改成与既有关系相同的范围 → 409 且原行不变（事务回滚）', async () => {
    const subId = makeItem('RM-SUB-1');
    const token = manageToken();
    const generic = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId },
      token,
    );
    const scoped = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, warehouseId: fx.warehouseId },
      token,
    );
    const genericId = (generic.json() as DataEnvelope<{ id: number }>).data.id;
    const scopedId = (scoped.json() as DataEnvelope<{ id: number }>).data.id;

    const conflict = await patch(
      `/api/masterdata/substitutes/${scopedId}`,
      { warehouseId: null },
      token,
    );
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as ErrorEnvelope).message).toBe(
      '同一主料/替代料在该场景与范围内已存在替代关系',
    );
    expect(dbRelation(scopedId).warehouse_id).toBe(fx.warehouseId);
    expect(dbRelation(genericId).warehouse_id).toBeNull();

    // 只与自己相同的范围不算冲突（排除自身）
    const self = await patch(
      `/api/masterdata/substitutes/${scopedId}`,
      { warehouseId: fx.warehouseId, priority: 4 },
      token,
    );
    expect(self.statusCode).toBe(200);
    expect(dbRelation(scopedId).priority).toBe(4);
  });

  it('与库中现值合并后再校验生效期：只改 effectiveTo 也会被拦', async () => {
    const subId = makeItem('RM-SUB-1');
    const token = manageToken();
    const created = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId, effectiveFrom: '2026-06-01' },
      token,
    );
    const id = (created.json() as DataEnvelope<{ id: number }>).data.id;

    const invalid = await patch(
      `/api/masterdata/substitutes/${id}`,
      { effectiveTo: '2026-05-31' },
      token,
    );
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as ErrorEnvelope).message).toBe('失效日期不能早于生效日期');
    expect(dbRelation(id).effective_to).toBeNull();
  });

  it('更新不存在的关系 → 404', async () => {
    const response = await patch(
      '/api/masterdata/substitutes/999999',
      { priority: 2 },
      manageToken(),
    );
    expect(response.statusCode).toBe(404);
    expect((response.json() as ErrorEnvelope).message).toBe('替代关系不存在');
  });
});

// ---------- 删除 ----------

describe('替代关系 · 删除', () => {
  it('硬删除行，且不动追溯日志；重复删除 404', async () => {
    const subId = makeItem('RM-SUB-1');
    const id = insertRelation(fx.itemId, subId);
    const logId = Number(
      db
        .prepare(
          `INSERT INTO item_substitute_log
             (biz_type, biz_id, warehouse_id, main_item_id, main_need_qty, sub_item_id, created_at)
           VALUES ('sales_out', 1, ?, ?, 10, ?, ?)`,
        )
        .run(fx.warehouseId, fx.itemId, subId, NOW).lastInsertRowid,
    );

    const response = await del(`/api/masterdata/substitutes/${id}`, manageToken());
    expect(response.statusCode).toBe(200);
    expect((response.json() as DataEnvelope<{ id: number }>).data).toEqual({ id });
    expect(countRelation(id)).toBe(0);
    // 追溯账只增不改：历史执行事实不因配置删除而消失
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM item_substitute_log WHERE id = ?').get(logId),
    ).toEqual({ n: 1 });

    const again = await del(`/api/masterdata/substitutes/${id}`, manageToken());
    expect(again.statusCode).toBe(404);
    expect((again.json() as ErrorEnvelope).message).toBe('替代关系不存在');
  });
});

// ---------- 规划接口 ----------

describe('替代关系 · 规划 GET /api/masterdata/substitutes/plan', () => {
  it('返回规划结果，且路由未被 /:id 吞掉', async () => {
    const subId = makeItem('RM-SUB-1');
    stock(fx.itemId, 30);
    stock(subId, 200);
    insertRelation(fx.itemId, subId, { warehouseId: fx.warehouseId });
    const token = viewToken();

    const response = await get(
      `/api/masterdata/substitutes/plan?mainItemId=${fx.itemId}&warehouseId=${fx.warehouseId}&requiredQty=100`,
      token,
    );
    expect(response.statusCode).toBe(200);
    const payload = response.json() as DataEnvelope<PlanDto>;
    expect(payload.data.mainItemId).toBe(fx.itemId);
    expect(payload.data.mainItemCode).toBe('RM-001');
    expect(payload.data.strategy).toBe('proportion');
    expect(payload.data.allocations).toEqual([
      expect.objectContaining({ itemId: fx.itemId, quantity: 30, isMain: true }),
      expect.objectContaining({ itemId: subId, quantity: 70, isMain: false }),
    ]);
    expect(payload.data.filledQty).toBe(100);
    expect(payload.data.gapQty).toBe(0);

    // 若 'plan' 被 /:id 抢先匹配，缺失必填参数时不会是「参数校验失败」
    const missingParams = await get('/api/masterdata/substitutes/plan', token);
    expect(missingParams.statusCode).toBe(400);
    expect((missingParams.json() as ErrorEnvelope).message).toBe('参数校验失败');
  });

  it('planForQuery 适配：manualItemIds 逗号分隔解析为数组，脏参数 400', async () => {
    const first = makeItem('RM-SUB-1');
    const second = makeItem('RM-SUB-2');
    stock(first, 100);
    stock(second, 100);
    insertRelation(fx.itemId, first, { priority: 1 });
    insertRelation(fx.itemId, second, { priority: 2 });

    const plan = planForQuery({
      mainItemId: fx.itemId,
      warehouseId: fx.warehouseId,
      requiredQty: 50,
      scene: 'sales_out',
      strategy: 'manual',
      manualItemIds: `${second}`,
    });
    expect(plan.allocations).toEqual([
      expect.objectContaining({ itemId: second, quantity: 50, isMain: false }),
    ]);
    expect(plan.skipped).toContainEqual({
      itemId: first,
      itemCode: 'RM-SUB-1',
      reason: 'manual_excluded',
    });

    const token = viewToken();
    const viaHttp = await get(
      `/api/masterdata/substitutes/plan?mainItemId=${fx.itemId}&warehouseId=${fx.warehouseId}&requiredQty=50&strategy=manual&manualItemIds=${second}`,
      token,
    );
    expect(viaHttp.statusCode).toBe(200);
    expect((viaHttp.json() as DataEnvelope<PlanDto>).data.allocations).toEqual([
      expect.objectContaining({ itemId: second, quantity: 50 }),
    ]);

    const dirty = await get(
      `/api/masterdata/substitutes/plan?mainItemId=${fx.itemId}&warehouseId=${fx.warehouseId}&requiredQty=50&strategy=manual&manualItemIds=abc`,
      token,
    );
    expect(dirty.statusCode).toBe(400);
    expect((dirty.json() as ErrorEnvelope).message).toContain('manualItemIds');

    // 空串按未提供处理 → 由规划模块给出「手工指定必须提供 manualItemIds」
    expect(() =>
      planForQuery({
        mainItemId: fx.itemId,
        warehouseId: fx.warehouseId,
        requiredQty: 50,
        scene: 'sales_out',
        strategy: 'manual',
        manualItemIds: ' , ',
      }),
    ).toThrow(ApiError);
  });
});

// ---------- 权限边界 ----------

describe('替代关系 · 权限边界', () => {
  it('缺少令牌 → 401', async () => {
    const response = await get('/api/masterdata/substitutes');
    expect(response.statusCode).toBe(401);
    expect((response.json() as ErrorEnvelope).code).toBe(401);
  });

  it('有令牌但无查看权限 → GET 403；无维护权限 → POST 403', async () => {
    const subId = makeItem('RM-SUB-1');
    const none = tokenWith([]);
    const onlyView = tokenWith([VIEW]);

    const list = await get('/api/masterdata/substitutes', none);
    expect(list.statusCode).toBe(403);

    const plan = await get(
      `/api/masterdata/substitutes/plan?mainItemId=${fx.itemId}&warehouseId=${fx.warehouseId}&requiredQty=10`,
      none,
    );
    expect(plan.statusCode).toBe(403);

    const created = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId },
      onlyView,
    );
    expect(created.statusCode).toBe(403);
    expect((created.json() as ErrorEnvelope).code).toBe(403);
    expect(countAllRelations()).toBe(0);

    // 有维护权限即可写
    const managed = await post(
      '/api/masterdata/substitutes',
      { mainItemId: fx.itemId, subItemId: subId },
      manageToken(),
    );
    expect(managed.statusCode).toBe(200);
    expect(countAllRelations()).toBe(1);
  });
});
