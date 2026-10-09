import { z } from 'zod';
import { SALES_ORDER_STATUSES } from '../constants';
import { dateSchema, distinctOrderItemIds, optionalText, orderItemLinesSchema, paginationQuerySchema } from './common';

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  dateSchema.optional(),
);

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

// ---------- 销售单表体行 ----------
/**
 * 单行入参。line_no 缺省时按数组顺序重排；amount 由服务端按 quantity × unit_price 计算，
 * 前端不提交计算列。
 */
export const salesOrderItemBodySchema = z.object({
  line_no: z.number().int().positive().optional(),
  product_id: z.number().int().positive(),
  warehouse_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_price: z.number().int().min(0),
  due_date: dateSchema,
});
export type SalesOrderItemBody = z.infer<typeof salesOrderItemBodySchema>;

// ---------- 销售单表头 ----------
export const salesOrderBodySchema = z.object({
  customer_id: z.number().int().positive(),
  order_date: dateSchema,
  remark: optionalText(500),
  items: z.array(salesOrderItemBodySchema).min(1, '至少需要一行销售明细'),
});
export type SalesOrderBody = z.infer<typeof salesOrderBodySchema>;

export const salesOrderUpdateBodySchema = salesOrderBodySchema.partial();
export type SalesOrderUpdateBody = z.infer<typeof salesOrderUpdateBodySchema>;

export const salesOrderQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  customerId: optionalId,
  /** 支持逗号分隔多值，如 draft,confirmed */
  status: optionalText(100),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type SalesOrderQuery = z.infer<typeof salesOrderQuerySchema>;

/** 合法状态值集合，供服务端拆分逗号分隔的 status 时过滤非法值 */
export const SALES_ORDER_STATUS_SET: ReadonlySet<string> = new Set(SALES_ORDER_STATUSES);

// ---------- 销售出库 ----------
/**
 * 出库明细行。在通用「订单行 + 数量」之上增加替代料能力（P10）：
 *   · `allowSubstitute`：允许按替代规则自动补齐本行缺口（主料优先，缺口由替代料按优先级兜底）
 *   · `substituteItemId`：缺口只允许用该替代料补（主料仍然优先使用）
 * 两者互斥；不带这两个字段时行为与过去完全一致（仅主料，不足即 409）。
 * 实际使用替代料出库需要 `sales.outbound.substitute` 权限（路由层校验）。
 */
export const salesOutboundLineSchema = z.object({
  orderItemId: z.number().int().positive(),
  quantity: z.number().int().positive(),
  allowSubstitute: z.boolean().optional(),
  substituteItemId: z.number().int().positive().optional(),
});

export const salesOutboundBodySchema = z.object({
  orderId: z.number().int().positive(),
  lines: z
    .array(salesOutboundLineSchema)
    .min(1, '至少需要一行出库明细')
    .refine(distinctOrderItemIds, { message: '同一订单行不能重复提交，请合并数量后重试' })
    .refine(
      (lines) => lines.every((line) => !(line.allowSubstitute && line.substituteItemId !== undefined)),
      { message: '同一行不能同时指定 allowSubstitute 与 substituteItemId' },
    ),
  occurredAt: z.string().optional(),
});
export type SalesOutboundBody = z.infer<typeof salesOutboundBodySchema>;
export type SalesOutboundLine = z.infer<typeof salesOutboundLineSchema>;

/** 请求是否用到了替代料能力（路由层据此决定是否校验 sales.outbound.substitute） */
export function usesSubstitution(lines: readonly SalesOutboundLine[]): boolean {
  return lines.some((line) => line.allowSubstitute === true || line.substituteItemId !== undefined);
}

// ---------- 销售退货 ----------
export const salesReturnBodySchema = z.object({
  orderId: z.number().int().positive(),
  returnDate: dateSchema,
  remark: optionalText(500),
  lines: orderItemLinesSchema('至少需要一行退货明细'),
});
export type SalesReturnBody = z.infer<typeof salesReturnBodySchema>;

export const salesReturnQuerySchema = paginationQuerySchema.extend({
  orderId: optionalId,
  keyword: z.string().trim().max(100).optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type SalesReturnQuery = z.infer<typeof salesReturnQuerySchema>;