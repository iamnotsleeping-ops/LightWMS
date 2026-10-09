import { z } from 'zod';
import { WAREHOUSE_TYPES } from '../constants';
import { dateSchema, optionalText } from './common';
import { asOfSchema } from './inventory';

/**
 * 对外只读接口（/api/v1）查询参数。
 * 约定：参数一律 snake_case（与 README 的 as_of 一致）；分页 page 默认 1、page_size 默认 100、上限 1000。
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** 0/1 布尔筛选（对外用数值，避免 true/false 歧义） */
const boolQuery = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().min(0).max(1).optional(),
);

const optionalDate = z.preprocess(emptyToUndefined, dateSchema.optional());

export const PUBLIC_FORMATS = ['json', 'csv'] as const;
export type PublicFormat = (typeof PUBLIC_FORMATS)[number];

/** 缺省 json；空串按缺省处理 */
export const publicFormatSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? 'json' : value),
  z.enum(PUBLIC_FORMATS),
);

export const publicPaginationSchema = z.object({
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1)),
  page_size: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(1000).default(100)),
});
export type PublicPagination = z.infer<typeof publicPaginationSchema>;

// ---------- IF-1 物料主数据 ----------
export const publicItemsQuerySchema = publicPaginationSchema.extend({
  keyword: optionalText(100),
  category_code: optionalText(50),
  is_active: boolQuery,
  format: publicFormatSchema,
});
export type PublicItemsQuery = z.infer<typeof publicItemsQuerySchema>;

// ---------- IF-2 BOM ----------
export const publicBomsQuerySchema = z.object({
  as_of: asOfSchema,
  parent_item_code: optionalText(50),
  child_item_code: optionalText(50),
  keyword: optionalText(100),
  format: publicFormatSchema,
});
export type PublicBomsQuery = z.infer<typeof publicBomsQuerySchema>;

// ---------- IF-2b BOM 展开（itemCode 在路径中） ----------
export const publicBomExplodeQuerySchema = z.object({
  as_of: asOfSchema,
  qty: z.preprocess(emptyToUndefined, z.coerce.number().positive().default(1)),
  format: publicFormatSchema,
});
export type PublicBomExplodeQuery = z.infer<typeof publicBomExplodeQuerySchema>;

export const publicBomExplodeParamSchema = z.object({
  itemCode: z.string().trim().min(1).max(50),
});

// ---------- IF-3 库存 ----------
export const publicInventoryQuerySchema = publicPaginationSchema.extend({
  as_of: asOfSchema,
  keyword: optionalText(100),
  item_code: optionalText(50),
  warehouse_code: optionalText(50),
  format: publicFormatSchema,
});
export type PublicInventoryQuery = z.infer<typeof publicInventoryQuerySchema>;

// ---------- IF-4 在途 ----------
export const publicInTransitQuerySchema = publicPaginationSchema.extend({
  as_of: asOfSchema,
  supplier_code: optionalText(50),
  item_code: optionalText(50),
  /** 逗号分隔多值，缺省为 confirmed,partial */
  status: optionalText(100),
  format: publicFormatSchema,
});
export type PublicInTransitQuery = z.infer<typeof publicInTransitQuerySchema>;

// ---------- IF-5 历史采购订单（提前期） ----------
export const publicPurchaseHistoryQuerySchema = publicPaginationSchema.extend({
  supplier_code: optionalText(50),
  item_code: optionalText(50),
  date_from: optionalDate,
  date_to: optionalDate,
  format: publicFormatSchema,
});
export type PublicPurchaseHistoryQuery = z.infer<typeof publicPurchaseHistoryQuerySchema>;

// ---------- IF-5b 供应商提前期聚合 ----------
export const publicLeadTimeStatsQuerySchema = z.object({
  item_code: optionalText(50),
  date_from: optionalDate,
  date_to: optionalDate,
  format: publicFormatSchema,
});
export type PublicLeadTimeStatsQuery = z.infer<typeof publicLeadTimeStatsQuerySchema>;

export const publicSupplierParamSchema = z.object({
  code: z.string().trim().min(1).max(50),
});

// ---------- IF-6 销售订单行 ----------
/**
 * 返回行级明细；`customer_name` 按客户名称精确过滤（返回仍只给客户编码），
 * `order_date` 按订单日期精确匹配，`date_from` / `date_to` 按「要求交期」（due_date）过滤。
 *
 * `status` 缺省时服务端只返回未结需求（`confirmed` / `partial`），与内部 `reserved` 口径
 * 一致；如需包含 `draft` / `cancelled` 必须显式传入。
 */
export const publicSalesOrdersQuerySchema = publicPaginationSchema.extend({
  keyword: optionalText(100),
  order_no: optionalText(50),
  customer_code: optionalText(50),
  customer_name: optionalText(100),
  item_code: optionalText(50),
  warehouse_code: optionalText(50),
  status: optionalText(100),
  order_date: optionalDate,
  date_from: optionalDate,
  date_to: optionalDate,
  format: publicFormatSchema,
});
export type PublicSalesOrdersQuery = z.infer<typeof publicSalesOrdersQuerySchema>;

// ---------- IF-7 工厂 / 仓库 ----------
export const publicWarehousesQuerySchema = z.object({
  type: z.preprocess(emptyToUndefined, z.enum(WAREHOUSE_TYPES).optional()),
  is_active: boolQuery,
  format: publicFormatSchema,
});
export type PublicWarehousesQuery = z.infer<typeof publicWarehousesQuerySchema>;