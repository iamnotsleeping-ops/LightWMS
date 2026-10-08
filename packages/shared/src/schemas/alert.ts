import { z } from 'zod';
import { ALERT_TYPES } from '../constants';
import { paginationQuerySchema } from './common';

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

/** 仓库可空：为空表示全局规则（该物料跨仓汇总口径） */
const optionalNullableId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().nullable().optional(),
);

/** 查询串里的布尔值兼容 true/false 与 0/1，统一转 0/1 */
const optionalBool = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true' || value === '1' || value === 1) return 1;
  if (value === false || value === 'false' || value === '0' || value === 0) return 0;
  return undefined;
}, z.union([z.literal(0), z.literal(1)]).optional());

// ---------- 预警规则 ----------
const alertRuleBaseSchema = z.object({
  item_id: z.number().int().positive(),
  warehouse_id: optionalNullableId,
  min_qty: z.number().int().min(0).default(0),
  max_qty: z.number().int().min(0).nullable().optional(),
  is_active: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});

export const alertRuleBodySchema = alertRuleBaseSchema.refine(
  (value) =>
    value.max_qty === null || value.max_qty === undefined || value.max_qty >= value.min_qty,
  { message: '上限不能小于下限', path: ['max_qty'] },
);
export type AlertRuleBody = z.infer<typeof alertRuleBodySchema>;

/** 更新：各字段可选；服务层与库中现值合并后再校验上下限关系 */
export const alertRuleUpdateBodySchema = alertRuleBaseSchema.partial();
export type AlertRuleUpdateBody = z.infer<typeof alertRuleUpdateBodySchema>;

export const alertRuleQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  warehouseId: optionalId,
  onlyActive: optionalBool,
});
export type AlertRuleQuery = z.infer<typeof alertRuleQuerySchema>;

// ---------- 当前预警清单（不分页） ----------
export const alertQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  warehouseId: optionalId,
  alertType: z.enum(ALERT_TYPES).optional(),
});
export type AlertQuery = z.infer<typeof alertQuerySchema>;