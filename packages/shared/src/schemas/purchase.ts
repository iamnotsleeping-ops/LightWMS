import { z } from 'zod';
import { PURCHASE_ORDER_STATUSES } from '../constants';
import { dateSchema, optionalText, paginationQuerySchema } from './common';

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  dateSchema.optional(),
);

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

// ---------- 采购单表体行 ----------
/**
 * 单行入参。line_no 缺省时按数组顺序重排；amount 由服务端按 quantity × unit_price 计算，
 * 前端不提交计算列。
 */
export const purchaseOrderItemBodySchema = z.object({
  line_no: z.number().int().positive().optional(),
  product_id: z.number().int().positive(),
  warehouse_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  unit_price: z.number().int().min(0),
  promised_date: dateSchema,
});
export type PurchaseOrderItemBody = z.infer<typeof purchaseOrderItemBodySchema>;

// ---------- 采购单表头 ----------
export const purchaseOrderBodySchema = z.object({
  supplier_id: z.number().int().positive(),
  order_date: dateSchema,
  remark: optionalText(500),
  items: z.array(purchaseOrderItemBodySchema).min(1, '至少需要一行采购明细'),
});
export type PurchaseOrderBody = z.infer<typeof purchaseOrderBodySchema>;

export const purchaseOrderUpdateBodySchema = purchaseOrderBodySchema.partial();
export type PurchaseOrderUpdateBody = z.infer<typeof purchaseOrderUpdateBodySchema>;

export const purchaseOrderQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  supplierId: optionalId,
  /** 支持逗号分隔多值，如 draft,confirmed */
  status: optionalText(100),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;

/** 合法状态值集合，供服务端拆分逗号分隔的 status 时过滤非法值 */
export const PURCHASE_ORDER_STATUS_SET: ReadonlySet<string> = new Set(PURCHASE_ORDER_STATUSES);

// ---------- 采购入库 ----------
export const purchaseInboundBodySchema = z.object({
  orderId: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        orderItemId: z.number().int().positive(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1, '至少需要一行入库明细'),
  occurredAt: z.string().optional(),
});
export type PurchaseInboundBody = z.infer<typeof purchaseInboundBodySchema>;

// ---------- 采购退货 ----------
export const purchaseReturnBodySchema = z.object({
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
export type PurchaseReturnBody = z.infer<typeof purchaseReturnBodySchema>;

export const purchaseReturnQuerySchema = paginationQuerySchema.extend({
  orderId: optionalId,
  keyword: z.string().trim().max(100).optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type PurchaseReturnQuery = z.infer<typeof purchaseReturnQuerySchema>;