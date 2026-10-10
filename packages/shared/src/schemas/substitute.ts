import { z } from 'zod';
import {
  SUBSTITUTE_SCENES,
  SUBSTITUTE_STRATEGIES,
  type SubstituteScene,
  type SubstituteStrategy,
  type SubstitutionSkipReason,
} from '../constants';
import { dateSchema, optionalText, paginationQuerySchema } from './common';

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

/** 可空 id：空串/未填 → null（表示"通用：不限仓库 / 不限父件"） */
const optionalNullableId = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : value),
  z.coerce.number().int().positive().nullable().optional(),
);

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined || value === null ? undefined : value),
  dateSchema.optional(),
);

const optionalBoolInt = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true' || value === '1' || value === 1) return 1;
  if (value === false || value === 'false' || value === '0' || value === 0) return 0;
  return undefined;
}, z.union([z.literal(0), z.literal(1)]).optional());

// ---------- 替代关系维护 ----------

/**
 * 替代关系入参。
 * 比例用整数分子/分母（本项目全链路数量为整数，无法承载小数比例）；
 * `parentItemId` / `warehouseId` 为 null 表示通用（不限父件 / 不限仓库）。
 */
export const substituteRelationBodySchema = z
  .object({
    mainItemId: z.number().int().positive(),
    subItemId: z.number().int().positive(),
    parentItemId: optionalNullableId,
    warehouseId: optionalNullableId,
    priority: z.number().int().min(1).max(999).default(1),
    ratioNum: z.number().int().positive().max(9999).default(1),
    ratioDen: z.number().int().positive().max(9999).default(1),
    scene: z.enum(SUBSTITUTE_SCENES).default('sales_out'),
    strategy: z.enum(SUBSTITUTE_STRATEGIES).default('proportion'),
    effectiveFrom: optionalDate,
    effectiveTo: optionalDate,
    isActive: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    remark: optionalText(255),
  })
  .refine((value) => value.mainItemId !== value.subItemId, {
    message: '主料与替代料不能相同',
    path: ['subItemId'],
  })
  .refine(
    (value) =>
      value.effectiveFrom === undefined ||
      value.effectiveTo === undefined ||
      value.effectiveTo >= value.effectiveFrom,
    { message: '失效日期不能早于生效日期', path: ['effectiveTo'] },
  );
export type SubstituteRelationBody = z.infer<typeof substituteRelationBodySchema>;

/** 更新：各字段可选，服务层与库中现值合并后再校验 */
export const substituteRelationUpdateBodySchema = z.object({
  parentItemId: optionalNullableId,
  warehouseId: optionalNullableId,
  priority: z.number().int().min(1).max(999).optional(),
  ratioNum: z.number().int().positive().max(9999).optional(),
  ratioDen: z.number().int().positive().max(9999).optional(),
  scene: z.enum(SUBSTITUTE_SCENES).optional(),
  strategy: z.enum(SUBSTITUTE_STRATEGIES).optional(),
  effectiveFrom: optionalDate,
  effectiveTo: optionalDate,
  isActive: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  remark: optionalText(255),
});
export type SubstituteRelationUpdateBody = z.infer<typeof substituteRelationUpdateBodySchema>;

export const substituteRelationQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  mainItemId: optionalId,
  subItemId: optionalId,
  scene: z.enum(SUBSTITUTE_SCENES).optional(),
  isActive: optionalBoolInt,
});
export type SubstituteRelationQuery = z.infer<typeof substituteRelationQuerySchema>;

// ---------- 规划（内部接口，供页面"看建议"用；对外接口 IF-9 另有 snake_case 版本） ----------

export const substitutionPlanQuerySchema = z.object({
  mainItemId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  requiredQty: z.coerce.number().int().positive(),
  scene: z.enum(SUBSTITUTE_SCENES).default('sales_out'),
  customerId: optionalId,
  parentItemId: optionalId,
  strategy: z.enum(SUBSTITUTE_STRATEGIES).optional(),
  /** 逗号分隔的物料 id，仅 strategy=manual 时使用 */
  manualItemIds: optionalText(500),
  asOf: optionalText(40),
});
export type SubstitutionPlanQuery = z.infer<typeof substitutionPlanQuerySchema>;

// ---------- 规划响应（IF-9 / 内部 /plan 的共用类型） ----------
//
// 这些类型是**前后端共用的唯一事实来源**：服务端 `planSubstitution` 的返回值按它约束，
// 前端三个页面（替代关系页的需求试算、销售出库的替代建议、BOM 展开的替代建议）也按它读取。
// 起因：前端原先各自手写了一份同名字段副本，字段改名时 TypeScript 查不出来——曾导致
// `allocations[].available` 改名 `onHand` 后 BOM 页那列静默显示空值。下沉到 shared 后，
// 任何一侧改名都会在 `vue-tsc` / `tsc` 阶段直接报错。
//
// 命名醒目提示：`onHand` 是**物理可用量**（stock_balance 的 available 桶），等于对外接口
// IF-3 的 `on_hand`；**不是** IF-3 的 `available`（可承诺量 ATP = on_hand − reserved）。

/** 规划中的一条物料分配 */
export interface SubstitutionAllocationDto {
  itemId: number;
  itemCode: string;
  itemName: string;
  /** 实际分配数量（整数） */
  quantity: number;
  /** 该数量折算回主料口径的覆盖量（向上取整，可能略大于缺口） */
  coveredQty: number;
  isMain: boolean;
  /** 取数时的物理可用量（available 桶）＝ IF-3 的 on_hand；不是 ATP */
  onHand: number;
  unitCost: number;
  ratioNum: number;
  ratioDen: number;
}

/** 一个无法参与分配的替代料及原因 */
export interface SubstitutionSkipDto {
  itemId: number;
  itemCode: string;
  reason: SubstitutionSkipReason;
}

/** 规划结果（只读试算，不写任何数据） */
export interface SubstitutionPlanDto {
  mainItemId: number;
  mainItemCode: string;
  warehouseId: number;
  scene: SubstituteScene;
  requiredQty: number;
  strategy: SubstituteStrategy;
  allocations: SubstitutionAllocationDto[];
  /**
   * 折算回主料口径的已覆盖量。
   * ⚠ 可能**大于** `requiredQty`：比例向上取整所致（例：比例 2/3、缺口 2 → 覆盖 3），
   * 因此不要假设 `filledQty = requiredQty − gapQty`。
   */
  filledQty: number;
  /** 主料口径的剩余缺口 */
  gapQty: number;
  /**
   * 只列「**无法参与分配**」的替代料（停用 / 失效 / 仓或父件不符 / 无库存 / 未认证 / 被手工清单排除）。
   * **不含**「可参与但没轮到」的候选——缺口被高优先级替代料填满后，后面的候选两边都不出现。
   */
  skipped: SubstitutionSkipDto[];
  warnings: string[];
}
