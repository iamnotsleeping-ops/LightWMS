import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import { postMovement } from '../inventory/stock.engine';
import { planSubstitution, type SubstitutionRequest } from './substitute.plan';

/**
 * 替代料规划模块的接口测试。
 *
 * 直接对 `planSubstitution` 断言（内存库、不写库、无需 HTTP）——接口即测试面。
 * 覆盖方案 §9 的边界：整数比例与取整、三种策略、客户正向认证、一层不嵌套、
 * 仓/父件覆盖回落、配置层跳过原因、决定性排序、不写库。
 */

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

const NOW = '2026-06-01T00:00:00.000Z';
const TODAY = '2026-06-01';

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

/** 造 available 桶库存 */
function stock(itemId: number, qty: number, warehouseId = fx.warehouseId, unitCost = 500): void {
  if (qty <= 0) return;
  postMovement({
    productId: itemId,
    warehouseId,
    stockStatus: 'available',
    bizType: 'adjust',
    direction: 1,
    quantity: qty,
    unitCost,
    occurredAt: NOW,
  });
}

interface RelOptions {
  workspaceId?: number | null;
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

function relate(mainId: number, subId: number, options: RelOptions = {}): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO item_substitute
           (main_item_id, sub_item_id, parent_item_id, warehouse_id, priority, ratio_num, ratio_den,
            scene, strategy, is_active, effective_from, effective_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        mainId,
        subId,
        options.parentItemId ?? null,
        options.workspaceId === undefined ? null : options.workspaceId,
        options.priority ?? 1,
        options.ratioNum ?? 1,
        options.ratioDen ?? 1,
        options.scene ?? 'sales_out',
        options.strategy ?? 'proportion',
        options.isActive ?? 1,
        options.effectiveFrom ?? null,
        options.effectiveTo ?? null,
        now,
        now,
      ).lastInsertRowid,
  );
}

function certify(itemId: number, customerId: number, expireAt: string | null = null): void {
  db.prepare(
    `INSERT INTO item_customer_certification (item_id, customer_id, certified_at, expire_at)
     VALUES (?, ?, ?, ?)`,
  ).run(itemId, customerId, TODAY, expireAt);
}

function plan(overrides: Partial<SubstitutionRequest> & { mainItemId: number; requiredQty: number }) {
  return planSubstitution(
    {
      warehouseId: fx.warehouseId,
      scene: 'sales_out',
      asOf: TODAY,
      ...overrides,
    },
    db,
  );
}

/** 守恒不变式：分配折算覆盖量 + 缺口 === 需求 */
function expectConserved(result: ReturnType<typeof plan>) {
  expect(result.filledQty + result.gapQty).toBe(result.requiredQty);
  const sum = result.allocations.reduce((total, entry) => total + entry.coveredQty, 0);
  expect(sum).toBe(result.filledQty);
}

describe('替代料规划 · 基线与按比例混用', () => {
  it('主料库存充足 → 全部用主料，不启用替代料', () => {
    const sub = makeItem('RM-SUB-1');
    stock(fx.itemId, 100);
    stock(sub, 100);
    relate(fx.itemId, sub);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 80 });

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ itemId: fx.itemId, quantity: 80, isMain: true });
    expect(result.gapQty).toBe(0);
    expectConserved(result);
  });

  it('主料不足 → 主料优先，缺口按 1:1 由替代料补齐', () => {
    const sub = makeItem('RM-SUB-1');
    stock(fx.itemId, 30);
    stock(sub, 200);
    relate(fx.itemId, sub);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100 });

    expect(result.allocations).toEqual([
      expect.objectContaining({ itemId: fx.itemId, quantity: 30, isMain: true }),
      expect.objectContaining({ itemId: sub, quantity: 70, isMain: false }),
    ]);
    expect(result.gapQty).toBe(0);
    expectConserved(result);
  });

  it('替代比例 1:2（1 个主料换 2 个替代料）按比例换算', () => {
    const sub = makeItem('RM-SUB-1');
    stock(fx.itemId, 30);
    stock(sub, 200);
    relate(fx.itemId, sub, { ratioNum: 1, ratioDen: 2 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100 });

    // 缺口 70 → 需要 35 个替代料（70 × 1 / 2），折算覆盖 70
    expect(result.allocations[1]).toMatchObject({ itemId: sub, quantity: 35, coveredQty: 70 });
    expect(result.gapQty).toBe(0);
    expectConserved(result);
  });

  it('多个替代料按优先级依次兜底，前一个不够则继续下一个', () => {
    const first = makeItem('RM-SUB-1');
    const second = makeItem('RM-SUB-2');
    stock(first, 40);
    stock(second, 100);
    relate(fx.itemId, first, { priority: 1 });
    relate(fx.itemId, second, { priority: 2 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100 });

    // 主料无库存 → 不产生主料分配行；先给优先的 RM-SUB-1（40），剩余 60 由 RM-SUB-2 补
    expect(result.allocations[0]).toMatchObject({ itemCode: 'RM-SUB-1', quantity: 40 });
    expect(result.allocations[1]).toMatchObject({ itemCode: 'RM-SUB-2', quantity: 60 });
    expect(result.gapQty).toBe(0);
    expectConserved(result);
  });
});

describe('替代料规划 · 整数取整', () => {
  it('比例 2/3 且不能整除 → 向上取整并给出可核对告警', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { ratioNum: 2, ratioDen: 3 });

    // 缺口 4 → ceil(4 × 2 / 3) = 3 个替代料 → 折算 floor(3 × 3 / 2) = 4
    const result = plan({ mainItemId: fx.itemId, requiredQty: 4 });

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ itemId: sub, quantity: 3, coveredQty: 4 });
    expect(result.gapQty).toBe(0);
    expect(result.warnings.join('\n')).toContain('向上取整');
    expect(result.warnings.join('\n')).toContain('缺口 4 → 分配 3');
    expectConserved(result);
  });

  it('比例整除时不产生取整告警（避免噪音）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { ratioNum: 2, ratioDen: 3 });

    // 缺口 3 → 3 × 2 / 3 = 2 整除
    const result = plan({ mainItemId: fx.itemId, requiredQty: 3 });

    expect(result.allocations[0]).toMatchObject({ quantity: 2, coveredQty: 3 });
    expect(result.warnings.join('\n')).not.toContain('向上取整');
  });
});

describe('替代料规划 · 三种策略', () => {
  it('整批全量：主料不足且无单一替代料可全额覆盖 → 不做任何分配并全量报缺口', () => {
    const small = makeItem('RM-SUB-1');
    const medium = makeItem('RM-SUB-2');
    stock(fx.itemId, 30);
    stock(small, 50);
    stock(medium, 80);
    relate(fx.itemId, small, { strategy: 'whole_batch' });
    relate(fx.itemId, medium, { strategy: 'whole_batch', priority: 2 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100, strategy: 'whole_batch' });

    expect(result.strategy).toBe('whole_batch');
    expect(result.allocations).toEqual([]);
    expect(result.gapQty).toBe(100);
    expect(result.warnings.join('\n')).toContain('整批全量');
    expectConserved(result);
  });

  it('整批全量：存在能全额覆盖的替代料时整批用它、不再用主料', () => {
    const small = makeItem('RM-SUB-1');
    const big = makeItem('RM-SUB-2');
    stock(fx.itemId, 30);
    stock(small, 50);
    stock(big, 300);
    relate(fx.itemId, small, { strategy: 'whole_batch' });
    relate(fx.itemId, big, { strategy: 'whole_batch', priority: 2 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100, strategy: 'whole_batch' });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: big, quantity: 100, isMain: false })]);
    expect(result.gapQty).toBe(0);
  });

  it('整批全量：主料足够则全用主料', () => {
    const sub = makeItem('RM-SUB-1');
    stock(fx.itemId, 120);
    stock(sub, 300);
    relate(fx.itemId, sub, { strategy: 'whole_batch' });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 100, strategy: 'whole_batch' });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: fx.itemId, quantity: 100, isMain: true })]);
    expect(result.gapQty).toBe(0);
  });

  it('手工指定：按给定顺序分配，未指定者记为 manual_excluded', () => {
    const first = makeItem('RM-SUB-1');
    const second = makeItem('RM-SUB-2');
    stock(first, 100);
    stock(second, 100);
    relate(fx.itemId, first, { priority: 1 });
    relate(fx.itemId, second, { priority: 2 });

    const result = plan({
      mainItemId: fx.itemId,
      requiredQty: 50,
      strategy: 'manual',
      manualItemIds: [second],
    });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: second, quantity: 50 })]);
    expect(result.skipped).toContainEqual({
      itemId: first,
      itemCode: 'RM-SUB-1',
      reason: 'manual_excluded',
    });
  });

  it('手工指定缺少 manualItemIds → 400', () => {
    expect(() => plan({ mainItemId: fx.itemId, requiredQty: 10, strategy: 'manual' })).toThrow(ApiError);
  });

  it('手工指定缺少列表时的报错用对外参数名（不泄漏内部参数名 manualItemIds）', () => {
    let message = '';
    try {
      plan({ mainItemId: fx.itemId, requiredQty: 10, strategy: 'manual' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('manual_item_codes');
    expect(message).not.toContain('manualItemIds');
  });

  it('手工指名主料自己 → 400（以前是静默无效：既不在 allocations 也不在 skipped）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub);

    expect(() =>
      plan({ mainItemId: fx.itemId, requiredQty: 10, strategy: 'manual', manualItemIds: [fx.itemId] }),
    ).toThrow(/不是主料 .* 在场景 .* 下的替代料/);
  });

  it('手工指名一个存在但与该主料无替代关系的物料 → 400', () => {
    const sub = makeItem('RM-SUB-1');
    const unrelated = makeItem('RM-UNRELATED');
    stock(sub, 100);
    stock(unrelated, 100);
    relate(fx.itemId, sub);

    expect(() =>
      plan({ mainItemId: fx.itemId, requiredQty: 10, strategy: 'manual', manualItemIds: [unrelated] }),
    ).toThrow(/RM-UNRELATED 不是主料 RM-001 在场景 sales_out 下的替代料/);
  });

  it('手工指名只配在别的场景的替代料 → 400（场景是硬分区，不是静默回落）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { scene: 'bom_plan' });

    expect(() =>
      plan({
        mainItemId: fx.itemId,
        requiredQty: 10,
        scene: 'sales_out',
        strategy: 'manual',
        manualItemIds: [sub],
      }),
    ).toThrow(/不是主料 .* 在场景 sales_out 下的替代料/);
  });
});

describe('替代料规划 · 客户正向认证', () => {
  it('未认证 → 跳过并给出 customer_not_certified，缺口归因指向认证', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10, customerId: fx.customerId });

    expect(result.allocations).toEqual([]);
    expect(result.gapQty).toBe(10);
    expect(result.skipped).toContainEqual({
      itemId: sub,
      itemCode: 'RM-SUB-1',
      reason: 'customer_not_certified',
    });
    expect(result.warnings.join('\n')).toContain('客户认证');
  });

  it('认证已过期 → customer_cert_expired', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub);
    certify(sub, fx.customerId, '2026-05-31');

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10, customerId: fx.customerId });

    expect(result.skipped).toContainEqual({
      itemId: sub,
      itemCode: 'RM-SUB-1',
      reason: 'customer_cert_expired',
    });
  });

  it('认证有效 → 正常分配', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub);
    certify(sub, fx.customerId, '2026-12-31');

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10, customerId: fx.customerId });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: sub, quantity: 10 })]);
  });

  it('非销售场景不校验客户认证（生产备料/采购建议不受客户限制）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { scene: 'bom_plan' });

    const result = plan({
      mainItemId: fx.itemId,
      requiredQty: 10,
      scene: 'bom_plan',
      customerId: fx.customerId, // 传了客户，但非销售场景应忽略
    });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: sub, quantity: 10 })]);
    expect(result.skipped).toEqual([]);
  });

  it('手工指定被认证拦截的替代料 → 直接 400（强拦截）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub);

    expect(() =>
      plan({
        mainItemId: fx.itemId,
        requiredQty: 10,
        strategy: 'manual',
        manualItemIds: [sub],
        customerId: fx.customerId,
      }),
    ).toThrow(/未对该客户认证/);
  });
});

describe('替代料规划 · 一层不嵌套', () => {
  it('A→B 且 B→C 时，规划 A 只得到 B（不递归到 C）', () => {
    const b = makeItem('RM-SUB-B');
    const c = makeItem('RM-SUB-C');
    stock(b, 100);
    stock(c, 100);
    relate(fx.itemId, b);
    relate(b, c);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });

    expect(result.allocations).toEqual([expect.objectContaining({ itemId: b, quantity: 10 })]);
    expect(result.allocations.some((entry) => entry.itemId === c)).toBe(false);
  });
});

describe('替代料规划 · 配置层跳过原因（全部可达）', () => {
  it('停用 → relation_inactive', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { isActive: 0 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(result.skipped).toContainEqual({ itemId: sub, itemCode: 'RM-SUB-1', reason: 'relation_inactive' });
  });

  it('不在生效期 → out_of_validity（含"当天到期仍有效"与"次日起失效"边界）', () => {
    const expired = makeItem('RM-SUB-1');
    const future = makeItem('RM-SUB-2');
    stock(expired, 100);
    stock(future, 100);
    relate(fx.itemId, expired, { effectiveTo: '2026-05-31' });
    relate(fx.itemId, future, { effectiveFrom: '2026-06-02', priority: 2 });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });

    const reasons = result.skipped.map((entry) => [entry.itemCode, entry.reason]);
    expect(reasons).toContainEqual(['RM-SUB-1', 'out_of_validity']);
    expect(reasons).toContainEqual(['RM-SUB-2', 'out_of_validity']);

    // 当天到期（effectiveTo = today）应仍然有效
    const today = makeItem('RM-SUB-3');
    stock(today, 100);
    relate(fx.itemId, today, { effectiveTo: TODAY, priority: 3 });
    const again = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(again.allocations).toEqual([expect.objectContaining({ itemId: today, quantity: 10 })]);
  });

  it('指定了其它仓库 → wrong_warehouse', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { workspaceId: fx.portWarehouseId });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(result.skipped).toContainEqual({ itemId: sub, itemCode: 'RM-SUB-1', reason: 'wrong_warehouse' });
  });

  it('绑定到其它父件 → wrong_parent（无 BOM 语境时父件专属关系不适用）', () => {
    const sub = makeItem('RM-SUB-1');
    const otherParent = makeItem('FG-OTHER');
    stock(sub, 100);
    relate(fx.itemId, sub, { parentItemId: otherParent });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(result.skipped).toContainEqual({ itemId: sub, itemCode: 'RM-SUB-1', reason: 'wrong_parent' });
  });

  it('无可用库存 → no_stock', () => {
    const sub = makeItem('RM-SUB-1');
    relate(fx.itemId, sub);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(result.skipped).toContainEqual({ itemId: sub, itemCode: 'RM-SUB-1', reason: 'no_stock' });
  });

  it('场景不符的关系不参与（不同 scene 是硬分区）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { scene: 'purchase_hint' });

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10, scene: 'sales_out' });
    expect(result.allocations).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe('替代料规划 · 覆盖回落与排序', () => {
  it('同一替代料既有通用规则又有本仓规则 → 只取更专属的一条（不重复分配）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { ratioNum: 5, ratioDen: 1 });                    // 通用：比例很离谱
    relate(fx.itemId, sub, { workspaceId: fx.warehouseId, ratioNum: 1, ratioDen: 1 }); // 本仓：1:1

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });

    expect(result.allocations).toHaveLength(1);
    // 取到的是本仓那条（1:1 → 分配 10），而不是通用那条（5:1 → 分配 50）
    expect(result.allocations[0]).toMatchObject({ itemId: sub, quantity: 10, ratioNum: 1, ratioDen: 1 });
    expectConserved(result);
  });

  it('本仓规则失效时回落到通用规则', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 100);
    relate(fx.itemId, sub, { ratioNum: 1, ratioDen: 1 });                                  // 通用有效
    relate(fx.itemId, sub, { workspaceId: fx.warehouseId, effectiveTo: '2026-01-01' });    // 本仓已失效

    const result = plan({ mainItemId: fx.itemId, requiredQty: 10 });
    expect(result.allocations).toEqual([expect.objectContaining({ itemId: sub, quantity: 10 })]);
    expect(result.skipped).toEqual([]);
  });

  it('同优先级按编码稳定排序，两次调用结果一致（决定性排序）', () => {
    const b = makeItem('RM-SUB-B');
    const a = makeItem('RM-SUB-A');
    stock(a, 100);
    stock(b, 100);
    relate(fx.itemId, b, { priority: 1 });
    relate(fx.itemId, a, { priority: 1 });

    const first = plan({ mainItemId: fx.itemId, requiredQty: 5 });
    const second = plan({ mainItemId: fx.itemId, requiredQty: 5 });

    expect(first.allocations.map((entry) => entry.itemCode)).toEqual(['RM-SUB-A']);
    expect(second.allocations).toEqual(first.allocations);
  });
});

describe('替代料规划 · 只读与护栏', () => {
  it('规划不写任何数据（流水 / 余额 / 追溯日志行数不变）', () => {
    const sub = makeItem('RM-SUB-1');
    stock(fx.itemId, 5);
    stock(sub, 100);
    relate(fx.itemId, sub);

    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = {
      tx: count('stock_transaction'),
      balance: count('stock_balance'),
      log: count('item_substitute_log'),
    };

    plan({ mainItemId: fx.itemId, requiredQty: 20 });

    expect(count('stock_transaction')).toBe(before.tx);
    expect(count('stock_balance')).toBe(before.balance);
    expect(count('item_substitute_log')).toBe(before.log);
  });

  it('规划不缓存可用量：库存变化后同一请求给出不同结果', () => {
    const sub = makeItem('RM-SUB-1');
    stock(sub, 10);
    relate(fx.itemId, sub);

    expect(plan({ mainItemId: fx.itemId, requiredQty: 30 }).gapQty).toBe(20);

    stock(sub, 20); // 追加库存
    expect(plan({ mainItemId: fx.itemId, requiredQty: 30 }).gapQty).toBe(0);
  });

  it('入参护栏：需求量非正整数 → 400；主料不存在 → 404', () => {
    expect(() => plan({ mainItemId: fx.itemId, requiredQty: 0 })).toThrow(ApiError);
    expect(() => plan({ mainItemId: fx.itemId, requiredQty: -5 })).toThrow(ApiError);
    expect(() => plan({ mainItemId: fx.itemId, requiredQty: 1.5 })).toThrow(ApiError);
    expect(() => plan({ mainItemId: 999999, requiredQty: 1 })).toThrow(/主料不存在/);
  });

  it('主料与替代料都无库存 → 缺口全量返回，且不谎报替代料可用', () => {
    const sub = makeItem('RM-SUB-1');
    relate(fx.itemId, sub);

    const result = plan({ mainItemId: fx.itemId, requiredQty: 42 });

    expect(result.allocations).toEqual([]);
    expect(result.gapQty).toBe(42);
    expect(result.warnings.join('\n')).toContain('42');
    expectConserved(result);
  });
});
