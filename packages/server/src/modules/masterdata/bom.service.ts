import type { BomExplodeQuery, BomQuery } from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { todayIso } from '../../lib/sqlite';

/** 展开最大深度熔断：防止病态深链拖垮请求 */
export const BOM_EXPLODE_MAX_DEPTH = 32;

/** 生效期开区间的边界哨兵（null 表示自始 / 无限期） */
const OPEN_START = '0000-01-01';
const OPEN_END = '9999-12-31';

// ---------- 行结构 ----------

export interface BomRow {
  id: number;
  parent_item_id: number;
  child_item_id: number;
  qty_per: number;
  scrap_rate: number;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
  parent_code: string;
  parent_name: string;
  parent_unit: string;
  child_code: string;
  child_name: string;
  child_unit: string;
}

export interface EffectiveLine {
  id: number;
  parent_item_id: number;
  child_item_id: number;
  qty_per: number;
  scrap_rate: number;
  effective_from: string | null;
  effective_to: string | null;
  child_code: string;
  child_name: string;
  child_unit: string;
  child_qty_precision: number;
}

export interface BomExplodeNode {
  level: number;
  itemId: number;
  itemCode: string;
  itemName: string;
  baseUnit: string;
  qtyPrecision: number;
  qtyPer: number;
  scrapRate: number;
  requiredQty: number;
  /** 该物料在 as_of 无生效 BOM 行（外购件 / 原材料） */
  isLeaf: boolean;
  /** 命中循环引用，该分支未继续下钻 */
  cyclic: boolean;
}

export interface BomExplodeResult {
  asOf: string;
  root: {
    itemId: number;
    itemCode: string;
    itemName: string;
    baseUnit: string;
    qtyPrecision: number;
    requiredQty: number;
  };
  lines: BomExplodeNode[];
  cycles: string[][];
  warnings: string[];
}

interface ItemRef {
  id: number;
  code: string;
}

const SELECT_LIST = `
  SELECT b.id, b.parent_item_id, b.child_item_id, b.qty_per, b.scrap_rate,
         b.effective_from, b.effective_to, b.created_at, b.updated_at,
         pi.code AS parent_code, pi.name AS parent_name, pi.base_unit AS parent_unit,
         ci.code AS child_code, ci.name AS child_name, ci.base_unit AS child_unit
  FROM bom b
  JOIN item pi ON pi.id = b.parent_item_id
  JOIN item ci ON ci.id = b.child_item_id`;

/** as_of 归一为 YYYY-MM-DD；缺省取服务端当日 */
export function normalizeBomAsOf(value?: string | null): string {
  return value && value.length > 0 ? value : todayIso();
}

/** BOM 列表：可选 asOf 只返回该日期生效的版本，否则返回全部版本 */
export function listBoms(query: BomQuery): BomRow[] {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.parentItemId) {
    where.push('b.parent_item_id = ?');
    params.push(query.parentItemId);
  }
  if (query.childItemId) {
    where.push('b.child_item_id = ?');
    params.push(query.childItemId);
  }
  if (query.keyword) {
    where.push('(pi.code LIKE ? OR pi.name LIKE ? OR ci.code LIKE ? OR ci.name LIKE ?)');
    const keyword = `%${query.keyword}%`;
    params.push(keyword, keyword, keyword, keyword);
  }
  if (query.asOf) {
    where.push('(b.effective_from IS NULL OR b.effective_from <= ?)');
    params.push(query.asOf);
    where.push('(b.effective_to IS NULL OR b.effective_to >= ?)');
    params.push(query.asOf);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `${SELECT_LIST} ${clause}
       ORDER BY pi.code, ci.code, COALESCE(b.effective_from, '${OPEN_START}')`,
    )
    .all(...params) as BomRow[];
}

/** 解析某父件在 asOf 生效的 BOM 行（子件维度，按子件编码排序） */
export function resolveEffectiveLines(
  parentItemId: number,
  asOf: string,
  db: Db = getDb(),
): EffectiveLine[] {
  return db
    .prepare(
      `SELECT b.id, b.parent_item_id, b.child_item_id, b.qty_per, b.scrap_rate,
              b.effective_from, b.effective_to,
              ci.code AS child_code, ci.name AS child_name,
              ci.base_unit AS child_unit, ci.qty_precision AS child_qty_precision
         FROM bom b JOIN item ci ON ci.id = b.child_item_id
        WHERE b.parent_item_id = ?
          AND (b.effective_from IS NULL OR b.effective_from <= ?)
          AND (b.effective_to   IS NULL OR b.effective_to   >= ?)
        ORDER BY ci.code`,
    )
    .all(parentItemId, asOf, asOf) as EffectiveLine[];
}

/**
 * 校验同 (父件, 子件) 的生效期不与既有版本重叠。
 * 任一日期最多解析出一条版本，否则 409。
 */
export function assertBomNoOverlap(
  parentItemId: number,
  childItemId: number,
  from: string | null | undefined,
  to: string | null | undefined,
  excludeId?: number,
  db: Db = getDb(),
): void {
  const rows = db
    .prepare(
      `SELECT id, effective_from, effective_to FROM bom
        WHERE parent_item_id = ? AND child_item_id = ?${excludeId ? ' AND id <> ?' : ''}`,
    )
    .all(...(excludeId ? [parentItemId, childItemId, excludeId] : [parentItemId, childItemId])) as {
    id: number;
    effective_from: string | null;
    effective_to: string | null;
  }[];

  const newFrom = from ?? OPEN_START;
  const newTo = to ?? OPEN_END;
  for (const row of rows) {
    const existingFrom = row.effective_from ?? OPEN_START;
    const existingTo = row.effective_to ?? OPEN_END;
    if (newFrom <= existingTo && existingFrom <= newTo) {
      throw new ApiError(409, '同一父件、子件在该生效期内已存在其他版本');
    }
  }
}

interface RootItem {
  id: number;
  code: string;
  name: string;
  base_unit: string;
  qty_precision: number;
}

/** 多层展开：DFS 解析每个父件在 as_of 的生效子件，含循环检测与深度熔断 */
export function explodeBom(query: BomExplodeQuery, db: Db = getDb()): BomExplodeResult {
  const asOf = normalizeBomAsOf(query.asOf);
  const root = (
    query.itemCode
      ? db
          .prepare(
            'SELECT id, code, name, base_unit, qty_precision FROM item WHERE code = ?',
          )
          .get(query.itemCode)
      : db
          .prepare('SELECT id, code, name, base_unit, qty_precision FROM item WHERE id = ?')
          .get(query.itemId)
  ) as RootItem | undefined;
  if (!root) throw new ApiError(404, '物料不存在');

  const rootQty = query.qty;
  const lines: BomExplodeNode[] = [];
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();
  const warnings: string[] = [];
  let depthWarned = false;

  const walk = (
    parentItemId: number,
    parentRequired: number,
    level: number,
    path: ItemRef[],
  ): void => {
    const children = resolveEffectiveLines(parentItemId, asOf, db);
    if (children.length === 0) return;
    if (level > BOM_EXPLODE_MAX_DEPTH) {
      if (!depthWarned) {
        depthWarned = true;
        warnings.push(`BOM 展开深度已达上限 ${BOM_EXPLODE_MAX_DEPTH}，更深层级未展开`);
      }
      return;
    }

    for (const child of children) {
      const requiredQty = parentRequired * child.qty_per * (1 + child.scrap_rate);
      const cyclic = path.some((ref) => ref.id === child.child_item_id);
      const node: BomExplodeNode = {
        level,
        itemId: child.child_item_id,
        itemCode: child.child_code,
        itemName: child.child_name,
        baseUnit: child.child_unit,
        qtyPrecision: child.child_qty_precision,
        qtyPer: child.qty_per,
        scrapRate: child.scrap_rate,
        requiredQty,
        isLeaf: false,
        cyclic,
      };

      if (cyclic) {
        node.isLeaf = true;
        const cycleCodes = [...path.map((ref) => ref.code), child.child_code];
        const key = cycleCodes.join('>');
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          cycles.push(cycleCodes);
          warnings.push(`检测到循环引用：${cycleCodes.join(' → ')}`);
        }
        lines.push(node);
        continue;
      }

      node.isLeaf = resolveEffectiveLines(child.child_item_id, asOf, db).length === 0;
      lines.push(node);
      if (!node.isLeaf) {
        walk(child.child_item_id, requiredQty, level + 1, [
          ...path,
          { id: child.child_item_id, code: child.child_code },
        ]);
      }
    }
  };

  walk(root.id, rootQty, 1, [{ id: root.id, code: root.code }]);

  return {
    asOf,
    root: {
      itemId: root.id,
      itemCode: root.code,
      itemName: root.name,
      baseUnit: root.base_unit,
      qtyPrecision: root.qty_precision,
      requiredQty: rootQty,
    },
    lines,
    cycles,
    warnings,
  };
}