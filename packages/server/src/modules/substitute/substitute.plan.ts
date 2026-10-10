import type {
  SubstituteScene,
  SubstituteStrategy,
  SubstitutionAllocationDto,
  SubstitutionPlanDto,
  SubstitutionSkipDto,
  SubstitutionSkipReason,
} from '@light-erp/shared';
import { getDb, type Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { businessDateOf, businessToday } from '../../lib/time';
import { readBalanceByStatus } from '../inventory/stock.engine';

/**
 * 替代料规划（P10 的深度模块）。
 *
 * 一个 `planSubstitution` 调用背后是：候选取数（仓库/父件覆盖回落、场景、生效期）、
 * 客户认证过滤、优先级排序、三种策略的数量分配、整数比例换算与取整、缺口与跳过原因
 * 归集、告警生成。它是**纯计算**：只读库、不写任何数据，因此
 *   · 可以安全开放给只读权限角色（"看建议"零副作用）；
 *   · 用内存库直接调用即可覆盖全部边界，无需起 HTTP；
 *   · 执行路径必须在自己的事务内重新调用它，不得跨请求复用规划结果。
 *
 * 已确认的口径（见 .trae/documents/P10-替代料-实施方案.md 第十一节）：
 *   · 比例是**整数分子/分母**：替代料用量 = ceil(缺口 × ratio_num / ratio_den)
 *   · **向上取整**（宁可多备）；回算 = floor(替代用量 × ratio_den / ratio_num)
 *   · **只匹配一层**，不递归查询"替代料的替代料"
 *   · 客户限制为**正向认证**（复用 item_customer_certification），且只作用于替代动作
 *   · **只支持同仓**替代（cross_warehouse 预留但本期不实现）
 */

/** 一条候选替代关系（已按"更专属者优先"去重） */
interface SubstituteCandidate {
  relationId: number;
  subItemId: number;
  subItemCode: string;
  subItemName: string;
  priority: number;
  ratioNum: number;
  ratioDen: number;
  strategy: SubstituteStrategy;
}

export interface SubstitutionRequest {
  mainItemId: number;
  warehouseId: number;
  requiredQty: number;
  scene: SubstituteScene;
  /** 仅 scene='sales_out' 参与客户正向认证校验 */
  customerId?: number | null;
  /** BOM 语境：NULL/缺省 = 只用通用替代关系 */
  parentItemId?: number | null;
  /** 显式策略；缺省取首个候选关系上的策略，再无则 proportion */
  strategy?: SubstituteStrategy;
  /** strategy='manual' 时必填：按给定顺序分配 */
  manualItemIds?: number[];
  /** 业务日（YYYY-MM-DD 或 ISO）：只用于筛选替代关系的生效期 */
  asOf?: string | null;
}

interface ItemRow {
  id: number;
  code: string;
  name: string;
}

const CANDIDATE_SQL = `
  SELECT s.id AS relation_id, s.sub_item_id, i.code AS sub_item_code, i.name AS sub_item_name,
         s.priority, s.ratio_num, s.ratio_den, s.strategy,
         s.is_active, s.effective_from, s.effective_to, s.warehouse_id, s.parent_item_id
    FROM item_substitute s
    JOIN item i ON i.id = s.sub_item_id
   WHERE s.main_item_id = @mainItemId
     AND s.scene = @scene
   ORDER BY s.sub_item_id,
            CASE WHEN s.warehouse_id = @warehouseId THEN 0 ELSE 1 END,   -- 专属仓优先
            CASE WHEN s.parent_item_id = @parentItemId THEN 0 ELSE 1 END, -- 父件专属优先
            s.priority ASC, s.id ASC`;

interface RawRelation {
  relation_id: number;
  sub_item_id: number;
  sub_item_code: string;
  sub_item_name: string;
  priority: number;
  ratio_num: number;
  ratio_den: number;
  strategy: SubstituteStrategy;
  is_active: number;
  effective_from: string | null;
  effective_to: string | null;
  warehouse_id: number | null;
  parent_item_id: number | null;
}

/** 向上取整的整数除法：ceil(a / b)，a >= 0、b > 0 */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** 折算：替代料用量 → 主料口径覆盖量（向下取整，与 ceil 换算配套，保证"至少覆盖缺口"） */
function coveredBy(subQty: number, ratioNum: number, ratioDen: number): number {
  return Math.floor((subQty * ratioDen) / ratioNum);
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError(400, `${label}必须为正整数`);
  }
}

export function planSubstitution(request: SubstitutionRequest, db: Db = getDb()): SubstitutionPlanDto {
  assertPositiveInt(request.mainItemId, '主料 id');
  assertPositiveInt(request.warehouseId, '仓库 id');
  assertPositiveInt(request.requiredQty, '需求量');

  const main = db
    .prepare('SELECT id, code, name FROM item WHERE id = ?')
    .get(request.mainItemId) as ItemRow | undefined;
  if (!main) throw new ApiError(404, '主料不存在');

  // asOf 只用于筛选替代关系生效期，故归一为业务日（避免 '2026-10-09' 与 ISO 串比较时"当天到期"被判失效）
  const asOfDate = request.asOf
    ? /^\d{4}-\d{2}-\d{2}$/.test(request.asOf)
      ? request.asOf
      : businessDateOf(request.asOf)
    : businessToday();

  const candidateRows = db.prepare(CANDIDATE_SQL).all({
    mainItemId: request.mainItemId,
    warehouseId: request.warehouseId,
    parentItemId: request.parentItemId ?? null,
    scene: request.scene,
  }) as RawRelation[];

  const warnings: string[] = [];
  const skipped: SubstitutionSkipDto[] = [];

  /**
   * 配置层筛选在 JS 侧完成（而非 SQL），为的是让**每个**跳过原因都可达并回传：
   * 用户最常困惑的正是「我配了替代料，为什么没被用上」。SQL 里预过滤会让
   * `relation_inactive` / `out_of_validity` / `wrong_warehouse` / `wrong_parent`
   * 永远无法上报。规则：同一替代料按「更专属优先」排序，取**第一条通过全部校验**的；
   * 若该替代料全部关系都不过，则上报其中**最专属那条**的原因（即用户本来想用的那条）。
   */
  const invalidReasonOf = (relation: RawRelation): SubstitutionSkipReason | null => {
    if (relation.is_active !== 1) return 'relation_inactive';
    if (relation.effective_from !== null && relation.effective_from > asOfDate) {
      return 'out_of_validity';
    }
    if (relation.effective_to !== null && relation.effective_to < asOfDate) {
      return 'out_of_validity';
    }
    if (relation.warehouse_id !== null && relation.warehouse_id !== request.warehouseId) {
      return 'wrong_warehouse';
    }
    if (relation.parent_item_id !== null && relation.parent_item_id !== (request.parentItemId ?? null)) {
      return 'wrong_parent';
    }
    return null;
  };

  // 按 sub_item_id 归组：取第一条有效关系；全无效则记录最专属那条的原因
  const bySub = new Map<number, RawRelation[]>();
  for (const relation of candidateRows) {
    const list = bySub.get(relation.sub_item_id) ?? [];
    list.push(relation);
    bySub.set(relation.sub_item_id, list);
  }

  const candidates: SubstituteCandidate[] = [];
  for (const [, relations] of bySub) {
    const valid = relations.find((relation) => invalidReasonOf(relation) === null);
    if (valid) {
      candidates.push({
        relationId: valid.relation_id,
        subItemId: valid.sub_item_id,
        subItemCode: valid.sub_item_code,
        subItemName: valid.sub_item_name,
        priority: valid.priority,
        ratioNum: valid.ratio_num,
        ratioDen: valid.ratio_den,
        strategy: valid.strategy,
      });
    } else {
      const first = relations[0];
      skipped.push({
        itemId: first.sub_item_id,
        itemCode: first.sub_item_code,
        reason: invalidReasonOf(first) ?? 'relation_inactive',
      });
    }
  }
  // 决定性排序：优先级升序，同优先级按编码，保证两次调用结果一致
  candidates.sort((a, b) => a.priority - b.priority || (a.subItemCode < b.subItemCode ? -1 : a.subItemCode > b.subItemCode ? 1 : 0));

  // 策略：显式入参优先，否则取首个候选关系上的策略，最后兜底 proportion
  const strategy: SubstituteStrategy = request.strategy ?? candidates[0]?.strategy ?? 'proportion';
  const manualOrder = request.manualItemIds ?? [];

  if (strategy === 'manual') {
    if (manualOrder.length === 0) {
      // 文案用「对外参数名」：这句话最早把内部参数名（manualItemIds）漏给了外部调用方
      throw new ApiError(400, '手工指定策略（manual）必须提供手工替代料列表（对外参数 manual_item_codes）');
    }
    // 手工指定的每一项都必须是该 (主料, 场景) 的候选之一。
    // 候选只来自 item_substitute 中 main_item_id = 主料 的行，所以"指名主料自己"、
    // "指名一个无关物料"、"指名只配在别的场景的替代料"都会落进这里。
    // 这类输入以前是**静默无效**的（既不在 allocations 也不在 skipped），调用方会看到
    // "换了输入、结果没变"——属于最难发现的错，必须显式拒绝。
    const candidateIds = new Set(candidates.map((candidate) => candidate.subItemId));
    for (const itemId of manualOrder) {
      if (candidateIds.has(itemId)) continue;
      const row = db.prepare('SELECT code FROM item WHERE id = ?').get(itemId) as
        | { code: string }
        | undefined;
      throw new ApiError(
        400,
        `替代料 ${row?.code ?? itemId} 不是主料 ${main.code} 在场景 ${request.scene} 下的替代料，不能手工指定（对外参数 manual_item_codes）`,
      );
    }
  }

  // ---------- 主料分配（按策略决定是否先用主料） ----------
  //   proportion：主料优先，缺口再由替代料按优先级补齐（最常用）
  //   manual    ：主料优先，缺口只允许用手工指定的替代料补
  //   whole_batch：**不做混用**——主料能全额覆盖就全用主料，否则找单一替代料整批顶上，
  //                都做不到时不做任何分配并把缺口全量返回（宁可缺料，也不拆批）
  const allocations: SubstitutionAllocationDto[] = [];
  const mainOnHand = readBalanceByStatus(db, main.id, request.warehouseId).available;
  const mainCost = readWarehouseCostOf(db, main.id, request.warehouseId);

  const allocate = (
    itemId: number,
    itemCode: string,
    itemName: string,
    quantity: number,
    isMain: boolean,
    ratioNum: number,
    ratioDen: number,
    onHand: number,
    unitCost: number,
  ): void => {
    allocations.push({
      itemId,
      itemCode,
      itemName,
      quantity,
      coveredQty: isMain ? quantity : coveredBy(quantity, ratioNum, ratioDen),
      isMain,
      onHand,
      unitCost,
      ratioNum,
      ratioDen,
    });
  };

  let gap = request.requiredQty;
  if (strategy === 'whole_batch') {
    if (mainOnHand >= request.requiredQty) {
      allocate(main.id, main.code, main.name, request.requiredQty, true, 1, 1, mainOnHand, mainCost);
      gap = 0;
    }
    // 主料不足时不先占用主料，等下面找能整批覆盖的替代料
  } else {
    const mainQty = Math.min(mainOnHand, request.requiredQty);
    if (mainQty > 0) {
      allocate(main.id, main.code, main.name, mainQty, true, 1, 1, mainOnHand, mainCost);
    }
    gap = request.requiredQty - mainQty;
  }

  // ---------- 替代料筛选（客户认证 + 库存），跳过必须留原因 ----------
  const customerId = request.scene === 'sales_out' ? (request.customerId ?? null) : null;
  const certStmt = db.prepare(
    'SELECT expire_at FROM item_customer_certification WHERE item_id = ? AND customer_id = ?',
  );
  const manualSet = manualOrder.length > 0 ? new Set(manualOrder) : null;

  const usable: {
    candidate: SubstituteCandidate;
    onHand: number;
    unitCost: number;
  }[] = [];

  for (const candidate of candidates) {
    if (candidate.subItemId === main.id) {
      skipped.push({ itemId: candidate.subItemId, itemCode: candidate.subItemCode, reason: 'same_as_main' });
      continue;
    }
    if (manualSet && !manualSet.has(candidate.subItemId)) {
      skipped.push({ itemId: candidate.subItemId, itemCode: candidate.subItemCode, reason: 'manual_excluded' });
      continue;
    }
    if (customerId !== null) {
      const cert = certStmt.get(candidate.subItemId, customerId) as { expire_at: string | null } | undefined;
      if (!cert) {
        skipped.push({
          itemId: candidate.subItemId,
          itemCode: candidate.subItemCode,
          reason: 'customer_not_certified',
        });
        // 手工指定被认证拦截 → 直接拒绝（附件 §5.5「手工指定强拦截」）
        if (strategy === 'manual') throw new ApiError(400, `替代料 ${candidate.subItemCode} 未对该客户认证，不可手工指定`);
        continue;
      }
      if (cert.expire_at && cert.expire_at < asOfDate) {
        skipped.push({
          itemId: candidate.subItemId,
          itemCode: candidate.subItemCode,
          reason: 'customer_cert_expired',
        });
        if (strategy === 'manual') throw new ApiError(400, `替代料 ${candidate.subItemCode} 的客户认证已过期，不可手工指定`);
        continue;
      }
    }

    const onHand = readBalanceByStatus(db, candidate.subItemId, request.warehouseId).available;
    if (onHand <= 0) {
      skipped.push({ itemId: candidate.subItemId, itemCode: candidate.subItemCode, reason: 'no_stock' });
      continue;
    }
    usable.push({
      candidate,
      onHand,
      unitCost: readWarehouseCostOf(db, candidate.subItemId, request.warehouseId),
    });
  }

  // ---------- 按策略分配 ----------
  if (gap > 0) {
    if (strategy === 'whole_batch') {
      // 不混用：找一个能 100% 覆盖**总需求**的替代料整批顶上
      const full = usable.find(
        (entry) => coveredBy(entry.onHand, entry.candidate.ratioNum, entry.candidate.ratioDen) >= request.requiredQty,
      );
      if (full) {
        const need = ceilDiv(request.requiredQty * full.candidate.ratioNum, full.candidate.ratioDen);
        allocate(
          full.candidate.subItemId,
          full.candidate.subItemCode,
          full.candidate.subItemName,
          need,
          false,
          full.candidate.ratioNum,
          full.candidate.ratioDen,
          full.onHand,
          full.unitCost,
        );
        gap = request.requiredQty - coveredBy(need, full.candidate.ratioNum, full.candidate.ratioDen);
      } else {
        warnings.push(
          `整批全量策略要求单一物料覆盖全部需求 ${request.requiredQty}：主料物理可用 ${mainOnHand}，` +
            `且无单一替代料可全额覆盖（按该策略不做混用，故未分配任何物料）`,
        );
      }
    } else {
      // proportion / manual：按给定顺序（manual 为手工顺序，否则为优先级顺序）依次补缺口
      const ordered =
        strategy === 'manual'
          ? manualOrder
              .map((itemId) => usable.find((entry) => entry.candidate.subItemId === itemId))
              .filter((entry): entry is (typeof usable)[number] => entry !== undefined)
          : usable;

      for (const entry of ordered) {
        if (gap <= 0) break;
        const { candidate, onHand, unitCost } = entry;
        const gapBefore = gap;
        const need = ceilDiv(gapBefore * candidate.ratioNum, candidate.ratioDen);
        const take = Math.min(need, onHand);
        if (take <= 0) continue;
        const covered = coveredBy(take, candidate.ratioNum, candidate.ratioDen);
        allocate(
          candidate.subItemId,
          candidate.subItemCode,
          candidate.subItemName,
          take,
          false,
          candidate.ratioNum,
          candidate.ratioDen,
          onHand,
          unitCost,
        );
        if (take < need) {
          warnings.push(
            `替代料 ${candidate.subItemCode} 物理可用量 ${onHand} 不足以补满缺口（需 ${need}），已按可用量分配`,
          );
        }
        // 仅当"缺口 × 分子 / 分母"不能整除时才算发生取整，此时才提示，避免噪音
        if (take === need && (gapBefore * candidate.ratioNum) % candidate.ratioDen !== 0) {
          warnings.push(
            `替代料 ${candidate.subItemCode} 按比例 ${candidate.ratioNum}/${candidate.ratioDen} 换算：缺口 ${gapBefore} → 分配 ${take}（向上取整，折算覆盖 ${covered}）`,
          );
        }
        gap = Math.max(0, gap - covered);
      }
    }
  }

  const filledQty = allocations.reduce((sum, entry) => sum + entry.coveredQty, 0);

  // 缺口归因：区分"没库存"与"被客户认证拦掉"，避免只报库存不足（附件 §5.5）
  if (gap > 0) {
    const blockedByCustomer = skipped.some(
      (entry) =>
        entry.reason === 'customer_not_certified' || entry.reason === 'customer_cert_expired',
    );
    warnings.push(
      blockedByCustomer
        ? `仍有 ${gap} 未覆盖：存在可用替代料但均因客户认证限制被排除，需特批或紧急补货`
        : `仍有 ${gap} 未覆盖：主料与全部有效替代料的可用量合计不足`,
    );
  }

  return {
    mainItemId: main.id,
    mainItemCode: main.code,
    warehouseId: request.warehouseId,
    scene: request.scene,
    requiredQty: request.requiredQty,
    strategy,
    allocations,
    filledQty,
    gapQty: gap,
    skipped,
    warnings,
  };
}

/** 该物料在该仓库的均价（分）——与库存成本口径一致 */
function readWarehouseCostOf(db: Db, productId: number, warehouseId: number): number {
  const row = db
    .prepare(
      'SELECT MAX(avg_cost) AS avg_cost FROM stock_balance WHERE product_id = ? AND warehouse_id = ?',
    )
    .get(productId, warehouseId) as { avg_cost: number | null };
  return row.avg_cost ?? 0;
}
