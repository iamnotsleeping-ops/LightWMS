import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { todayIso } from '../../lib/sqlite';
import { createTestDb, seedFixtures, type Fixtures } from '../../test/db';
import {
  assertBomNoOverlap,
  BOM_EXPLODE_MAX_DEPTH,
  explodeBom,
  listBoms,
  resolveEffectiveLines,
} from './bom.service';

let db: Db;
let fx: Fixtures;

beforeEach(() => {
  db = createTestDb();
  fx = seedFixtures(db);
});

function insertItem(code: string, name = code): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO item (code, name, base_unit, is_active, qty_precision, inspection_required, created_at, updated_at)
         VALUES (?, ?, '件', 1, 0, 0, ?, ?)`,
      )
      .run(code, name, now, now).lastInsertRowid,
  );
}

function insertBom(
  parent: number,
  child: number,
  qtyPer: number,
  opts: { scrap?: number; from?: string | null; to?: string | null } = {},
): number {
  const now = new Date().toISOString();
  return Number(
    db
      .prepare(
        `INSERT INTO bom (parent_item_id, child_item_id, qty_per, scrap_rate, effective_from, effective_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(parent, child, qtyPer, opts.scrap ?? 0, opts.from ?? null, opts.to ?? null, now, now)
      .lastInsertRowid,
  );
}

describe('生效版解析', () => {
  it('同一父子件多版本按 as_of 各取其一，区间外为空', () => {
    insertBom(fx.portItemId, fx.itemId, 2, { from: '2026-01-01', to: '2026-06-30' });
    insertBom(fx.portItemId, fx.itemId, 3, { from: '2026-07-01', to: '2026-12-31' });

    const v1 = resolveEffectiveLines(fx.portItemId, '2026-03-15', db);
    expect(v1).toHaveLength(1);
    expect(v1[0].qty_per).toBe(2);

    const v2 = resolveEffectiveLines(fx.portItemId, '2026-07-15', db);
    expect(v2).toHaveLength(1);
    expect(v2[0].qty_per).toBe(3);

    expect(resolveEffectiveLines(fx.portItemId, '2025-12-31', db)).toHaveLength(0);
    expect(resolveEffectiveLines(fx.portItemId, '2027-01-01', db)).toHaveLength(0);
  });

  it('开区间语义：空生效起始 = 自始，空失效 = 无限期', () => {
    insertBom(fx.portItemId, fx.itemId, 5, { from: null, to: null });
    expect(resolveEffectiveLines(fx.portItemId, '1999-01-01', db)).toHaveLength(1);
    expect(resolveEffectiveLines(fx.portItemId, '2999-12-31', db)).toHaveLength(1);
  });

  it('列表 asOf 过滤：传入时只返回该日期生效版本', () => {
    insertBom(fx.portItemId, fx.itemId, 2, { from: '2026-01-01', to: '2026-06-30' });
    insertBom(fx.portItemId, fx.itemId, 3, { from: '2026-07-01', to: null });

    expect(listBoms({ asOf: '2026-03-15' })).toHaveLength(1);
    expect(listBoms({ asOf: '2026-03-15' })[0].qty_per).toBe(2);
    expect(listBoms({ asOf: '2026-07-15' })[0].qty_per).toBe(3);
    expect(listBoms({})).toHaveLength(2);
  });
});

describe('生效期重叠校验', () => {
  it('与既有版本重叠 → 409；留出间隙允许', () => {
    insertBom(fx.portItemId, fx.itemId, 2, { from: '2026-01-01', to: '2026-06-30' });

    // 同日边界视为重叠（该日将解析出两条版本）
    expect(() =>
      assertBomNoOverlap(fx.portItemId, fx.itemId, '2026-06-30', null, undefined, db),
    ).toThrow(ApiError);
    // 留出间隙 → 允许
    expect(() =>
      assertBomNoOverlap(fx.portItemId, fx.itemId, '2026-07-01', null, undefined, db),
    ).not.toThrow();
  });

  it('排除自身：修改本条不误判；改到重叠区间 → 409', () => {
    const first = insertBom(fx.portItemId, fx.itemId, 2, {
      from: '2026-01-01',
      to: '2026-06-30',
    });
    insertBom(fx.portItemId, fx.itemId, 3, { from: '2026-07-01', to: null });

    // 仅改用量，保持原生效期 → 不冲突
    expect(() =>
      assertBomNoOverlap(fx.portItemId, fx.itemId, '2026-01-01', '2026-06-30', first, db),
    ).not.toThrow();
    // 把失效日推到第二条区间 → 冲突
    expect(() =>
      assertBomNoOverlap(fx.portItemId, fx.itemId, '2026-01-01', '2026-08-31', first, db),
    ).toThrow(ApiError);
  });
});

describe('多层展开', () => {
  it('单层展开：累计需求 = 上层需求 × 单位用量 × (1 + 损耗率)', () => {
    insertBom(fx.portItemId, fx.itemId, 3, { scrap: 0.2 });
    const result = explodeBom({ itemId: fx.portItemId, qty: 10 }, db);

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].level).toBe(1);
    expect(result.lines[0].requiredQty).toBeCloseTo(36); // 10 × 3 × 1.2
    expect(result.lines[0].isLeaf).toBe(true);
    expect(result.lines[0].cyclic).toBe(false);
  });

  it('多层展开：FG → 半成品 → 零件，层级与累计需求逐级正确', () => {
    const semi = insertItem('SA-001');
    insertBom(fx.portItemId, semi, 2); // FG ← SA
    insertBom(semi, fx.itemId, 5); // SA ← RM

    const result = explodeBom({ itemId: fx.portItemId, qty: 10 }, db);
    expect(result.lines).toHaveLength(2);

    const [sa, rm] = result.lines;
    expect(sa.itemCode).toBe('SA-001');
    expect(sa.level).toBe(1);
    expect(sa.requiredQty).toBe(20);
    expect(sa.isLeaf).toBe(false);

    expect(rm.itemCode).toBe('RM-001');
    expect(rm.level).toBe(2);
    expect(rm.requiredQty).toBe(100); // 20 × 5
    expect(rm.isLeaf).toBe(true);
  });

  it('as_of 选择版本参与展开：不同 asOf 得到不同累计需求', () => {
    insertBom(fx.portItemId, fx.itemId, 2, { from: '2026-01-01', to: '2026-06-30' });
    insertBom(fx.portItemId, fx.itemId, 5, { from: '2026-07-01', to: null });

    expect(explodeBom({ itemId: fx.portItemId, qty: 1, asOf: '2026-03-01' }, db).lines[0].requiredQty).toBe(2);
    expect(explodeBom({ itemId: fx.portItemId, qty: 1, asOf: '2026-08-01' }, db).lines[0].requiredQty).toBe(5);
  });

  it('as_of 缺省 = 今天，仅当前生效版本参与展开', () => {
    insertBom(fx.portItemId, fx.itemId, 3, { from: '2000-01-01', to: '2020-12-31' });
    insertBom(fx.portItemId, fx.itemId, 5, { from: '2021-01-01', to: null });

    const result = explodeBom({ itemId: fx.portItemId, qty: 1 }, db);
    expect(result.asOf).toBe(todayIso());
    expect(result.lines[0].requiredQty).toBe(5);
  });
});

describe('循环检测与深度熔断', () => {
  it('A → B → A 命中循环：标记 cyclic、记录 cycles/warnings，且不无限递归', () => {
    const a = insertItem('A-001');
    const b = insertItem('B-001');
    insertBom(a, b, 1);
    insertBom(b, a, 1);

    const result = explodeBom({ itemId: a, qty: 1 }, db);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].itemCode).toBe('B-001');
    expect(result.lines[0].cyclic).toBe(false);

    const back = result.lines[1];
    expect(back.itemCode).toBe('A-001');
    expect(back.cyclic).toBe(true);
    expect(back.isLeaf).toBe(true);

    expect(result.cycles.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('循环引用'))).toBe(true);
  });

  it('自循环 A → A 命中循环', () => {
    const a = insertItem('LOOP-001');
    insertBom(a, a, 1);

    const result = explodeBom({ itemId: a, qty: 1 }, db);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].cyclic).toBe(true);
    expect(result.cycles).toHaveLength(1);
  });

  it('超过最大深度熔断并产生告警', () => {
    const chain: number[] = [];
    for (let i = 0; i <= BOM_EXPLODE_MAX_DEPTH + 5; i += 1) {
      chain.push(insertItem(`C-${String(i).padStart(3, '0')}`));
    }
    for (let i = 0; i < chain.length - 1; i += 1) {
      insertBom(chain[i], chain[i + 1], 1);
    }

    const result = explodeBom({ itemId: chain[0], qty: 1 }, db);
    expect(result.lines).toHaveLength(BOM_EXPLODE_MAX_DEPTH);
    expect(result.warnings.some((w) => w.includes('深度'))).toBe(true);
  });
});

describe('展开是只读操作', () => {
  it('调用前后 bom / item 无任何写入', () => {
    const semi = insertItem('SA-002');
    insertBom(fx.portItemId, semi, 2);
    insertBom(semi, fx.itemId, 5);

    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

    const bomBefore = count('bom');
    const itemBefore = count('item');
    explodeBom({ itemCode: 'FG-001', qty: 3 }, db);
    expect(count('bom')).toBe(bomBefore);
    expect(count('item')).toBe(itemBefore);
  });
});