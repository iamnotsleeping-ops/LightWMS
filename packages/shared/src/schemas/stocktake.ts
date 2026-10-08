import { z } from 'zod';
import { STOCK_STATUSES, STOCKTAKE_ORDER_STATUSES } from '../constants';
import { dateSchema, optionalText, paginationQuerySchema } from './common';

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  dateSchema.optional(),
);

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

// ---------- 盘点单表体行 ----------
/**
 * 单行入参：行维度 = 物料 × 库存状态，仓库在表头。
 * book_qty / diff_qty 由服务端计算，前端不提交计算列。
 */
export const stocktakeOrderItemBodySchema = z.object({
  line_no: z.number().int().positive().optional(),
  product_id: z.number().int().positive(),
  stock_status: z.enum(STOCK_STATUSES),
  counted_qty: z.number().int().min(0),
});
export type StocktakeOrderItemBody = z.infer<typeof stocktakeOrderItemBodySchema>;

// ---------- 盘点单表头（stocktake_order 无 remark 列） ----------
const stocktakeOrderBaseSchema = z.object({
  warehouse_id: z.number().int().positive(),
  order_date: dateSchema,
  items: z.array(stocktakeOrderItemBodySchema).min(1, '至少需要一行盘点明细'),
});

export const stocktakeOrderBodySchema = stocktakeOrderBaseSchema;
export type StocktakeOrderBody = z.infer<typeof stocktakeOrderBodySchema>;

export const stocktakeOrderUpdateBodySchema = stocktakeOrderBaseSchema.partial();
export type StocktakeOrderUpdateBody = z.infer<typeof stocktakeOrderUpdateBodySchema>;

export const stocktakeOrderQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  warehouseId: optionalId,
  /** 支持逗号分隔多值，如 draft,posted */
  status: optionalText(100),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type StocktakeOrderQuery = z.infer<typeof stocktakeOrderQuerySchema>;

export const STOCKTAKE_ORDER_STATUS_SET: ReadonlySet<string> = new Set(STOCKTAKE_ORDER_STATUSES);