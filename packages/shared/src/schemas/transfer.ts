import { z } from 'zod';
import { TRANSFER_ORDER_STATUSES } from '../constants';
import { dateSchema, optionalText, paginationQuerySchema } from './common';

const optionalDate = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  dateSchema.optional(),
);

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

// ---------- 调拨单表体行 ----------
/**
 * 单行入参。line_no 缺省时按数组顺序重排；仓库在表头两端，表体不重复携带 warehouse_id。
 */
export const transferOrderItemBodySchema = z.object({
  line_no: z.number().int().positive().optional(),
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
});
export type TransferOrderItemBody = z.infer<typeof transferOrderItemBodySchema>;

// ---------- 调拨单表头 ----------
const transferOrderBaseSchema = z.object({
  from_warehouse_id: z.number().int().positive(),
  to_warehouse_id: z.number().int().positive(),
  order_date: dateSchema,
  remark: optionalText(500),
  items: z.array(transferOrderItemBodySchema).min(1, '至少需要一行调拨明细'),
});

export const transferOrderBodySchema = transferOrderBaseSchema.refine(
  (value) => value.from_warehouse_id !== value.to_warehouse_id,
  { message: '调出与调入仓库不能相同', path: ['to_warehouse_id'] },
);
export type TransferOrderBody = z.infer<typeof transferOrderBodySchema>;

/** 更新：各字段可选；服务层会与库中现值合并后再校验两端仓库不相同 */
export const transferOrderUpdateBodySchema = transferOrderBaseSchema.partial();
export type TransferOrderUpdateBody = z.infer<typeof transferOrderUpdateBodySchema>;

export const transferOrderQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  fromWarehouseId: optionalId,
  toWarehouseId: optionalId,
  /** 支持逗号分隔多值，如 draft,confirmed */
  status: optionalText(100),
  dateFrom: optionalDate,
  dateTo: optionalDate,
});
export type TransferOrderQuery = z.infer<typeof transferOrderQuerySchema>;

/** 合法状态值集合，供服务端拆分逗号分隔的 status 时过滤非法值 */
export const TRANSFER_ORDER_STATUS_SET: ReadonlySet<string> = new Set(TRANSFER_ORDER_STATUSES);