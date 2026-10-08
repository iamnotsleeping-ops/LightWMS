import { z } from 'zod';
import { STOCK_STATUSES } from '../constants';
import { paginationQuerySchema } from './common';

/** 库存查询的展示口径：现有 / 含在途 / 可用量 / 预计可用 */
export const INVENTORY_VIEWS = ['on_hand', 'with_transit', 'available', 'projected'] as const;
export type InventoryView = (typeof INVENTORY_VIEWS)[number];

export const INVENTORY_VIEW_LABELS: Record<InventoryView, string> = {
  on_hand: '现有库存',
  with_transit: '含在途',
  available: '可用量',
  projected: '预计可用',
};

const optionalId = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const optionalText = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

/** 时点：接受 YYYY-MM-DD 或 ISO 8601；YYYY-MM-DD 由查询层归一到当日末刻 */
export const asOfSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}([T ].+)?$/, '时点格式须为 YYYY-MM-DD 或 ISO 8601')
    .optional(),
);

export const inventoryQuerySchema = paginationQuerySchema.extend({
  keyword: optionalText,
  productId: optionalId,
  warehouseId: optionalId,
  asOf: asOfSchema,
});
export type InventoryQuery = z.infer<typeof inventoryQuerySchema>;

export const balanceQuerySchema = z.object({
  keyword: optionalText,
  productId: optionalId,
  warehouseId: optionalId,
});
export type BalanceQuery = z.infer<typeof balanceQuerySchema>;

export const stockTransactionQuerySchema = paginationQuerySchema.extend({
  productId: optionalId,
  warehouseId: optionalId,
  stockStatus: z.enum(STOCK_STATUSES).optional(),
  bizType: optionalText,
  dateFrom: asOfSchema,
  dateTo: asOfSchema,
});
export type StockTransactionQuery = z.infer<typeof stockTransactionQuerySchema>;

/** 允许的库存状态转移：冻结 / 解冻 / 送检 / 质检放行 */
export const ALLOWED_STATUS_TRANSITIONS = [
  { from: 'available', to: 'frozen' },
  { from: 'frozen', to: 'available' },
  { from: 'available', to: 'qc' },
  { from: 'qc', to: 'available' },
] as const;

export const STATUS_TRANSITION_ACTION_LABELS = {
  'available>frozen': '冻结',
  'frozen>available': '解冻',
  'available>qc': '送检',
  'qc>available': '质检放行',
} as const;

export const stockStatusChangeBodySchema = z.object({
  productId: z.coerce.number().int().positive(),
  warehouseId: z.coerce.number().int().positive(),
  fromStatus: z.enum(STOCK_STATUSES),
  toStatus: z.enum(STOCK_STATUSES),
  quantity: z.coerce.number().int().positive(),
});
export type StockStatusChangeBody = z.infer<typeof stockStatusChangeBodySchema>;