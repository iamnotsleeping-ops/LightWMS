import { z } from 'zod';
import { SUBSTITUTE_SCENES, SUBSTITUTE_STRATEGIES } from '../constants';
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
