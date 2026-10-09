import { z } from 'zod';
import { BIZ_TYPES, STOCK_STATUSES } from '../constants';
import { optionalText, paginationQuerySchema } from './common';
import { asOfSchema } from './inventory';

/**
 * 内部管理报表（/api/reports/*）查询参数。
 * 与对外 /api/v1 不同，内部接口沿用驼峰命名（dateFrom / warehouseId / ...）。
 */

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalId = z.preprocess(
  emptyToUndefined,
  z.coerce.number().int().positive().optional(),
);

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(emptyToUndefined, z.enum(values).optional());

/** 查询串里的布尔值兼容 true/false 与 0/1，统一转 0/1（与子表 / 预警的同类筛选一致） */
const optionalBoolInt = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true' || value === '1' || value === 1) return 1;
  if (value === false || value === 'false' || value === '0' || value === 0) return 0;
  return undefined;
}, z.union([z.literal(0), z.literal(1)]).optional());

const REPORT_FORMATS = ['json', 'csv'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** 缺省 json；空串按缺省处理（与对外接口一致） */
export const reportFormatSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? 'json' : value),
  z.enum(REPORT_FORMATS),
);

// ---------- IF-R1 进销存明细账 ----------
export const ledgerQuerySchema = paginationQuerySchema.extend({
  dateFrom: asOfSchema,
  dateTo: asOfSchema,
  keyword: optionalText(100),
  warehouseId: optionalId,
  format: reportFormatSchema,
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

// ---------- IF-R2 库存现状表 ----------
export const stockSnapshotQuerySchema = paginationQuerySchema.extend({
  keyword: optionalText(100),
  warehouseId: optionalId,
  asOf: asOfSchema,
  format: reportFormatSchema,
});
export type StockSnapshotQuery = z.infer<typeof stockSnapshotQuerySchema>;

// ---------- IF-R3 商品收发明细 ----------
export const itemMovementQuerySchema = paginationQuerySchema.extend({
  productId: optionalId,
  warehouseId: optionalId,
  stockStatus: optionalEnum(STOCK_STATUSES),
  bizType: optionalEnum(BIZ_TYPES),
  dateFrom: asOfSchema,
  dateTo: asOfSchema,
  format: reportFormatSchema,
});
export type ItemMovementQuery = z.infer<typeof itemMovementQuerySchema>;

// ---------- IF-R4 供应商提前期分析 ----------
export const supplierLeadTimeQuerySchema = paginationQuerySchema.extend({
  keyword: optionalText(100),
  dateFrom: asOfSchema,
  dateTo: asOfSchema,
  format: reportFormatSchema,
});
export type SupplierLeadTimeQuery = z.infer<typeof supplierLeadTimeQuerySchema>;

// ---------- IF-R5 替代料使用 / 呆滞 ----------
/**
 * `onlyIdle` 为真时只返回 `is_idle` 行（从未使用，或距最后一次替代使用 ≥ 阈值天数）。
 * `dateFrom` / `dateTo` 过滤替代日志 `created_at`（按业务日 UTC+8 边界归一）。
 */
export const substituteUsageQuerySchema = paginationQuerySchema.extend({
  keyword: optionalText(100),
  dateFrom: asOfSchema,
  dateTo: asOfSchema,
  onlyIdle: optionalBoolInt,
  format: reportFormatSchema,
});
export type SubstituteUsageQuery = z.infer<typeof substituteUsageQuerySchema>;