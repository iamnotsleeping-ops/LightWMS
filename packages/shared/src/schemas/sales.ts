import { z } from 'zod';
import { SALES_ORDER_STATUSES } from '../constants';
import { dateSchema, optionalText, paginationQuerySchema } from './common';

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
export const salesOutboundBodySchema = z.object({
  orderId: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        orderItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1, '至少需要一行出库明细'),
  occurredAt: z.string().optional(),
});
export type SalesOutboundBody = z.infer<typeof salesOutboundBodySchema>;

// ---------- 销售退货 ----------
export const salesReturnBodySchema = z.object({
  orderId: z.number().int().positive(),
  returnDate: dateSchema,
  remark: optionalText(500),
  lines: z
    .array(
      z.object({
        orderItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1, '至少需要一行退货明细'),
});
export type SalesReturnBody = z.infer<typeof salesReturnBodySchema>;

export const salesReturnQuerySchema = paginationQuerySchema.extend({
  orderId: optionalId,
  keyword: z.string().trim().max(100).optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type SalesReturnQuery = z.infer<typeof salesReturnQuerySchema>;