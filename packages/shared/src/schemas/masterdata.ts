import { z } from 'zod';
import { WAREHOUSE_TYPES, PARTNER_TYPES } from '../constants';
import { boolIntSchema, dateSchema, optionalText, paginationQuerySchema } from './common';

const refId = z.number().int().positive().nullable().optional();

// ---------- 物料分类 ----------
export const categoryBodySchema = z.object({
  code: optionalText(50),
  name: z.string().trim().min(1).max(100),
  capacity_group: optionalText(50),
  parent_id: refId,
  is_active: boolIntSchema.optional(),
});
export type CategoryBody = z.infer<typeof categoryBodySchema>;

export const categoryUpdateBodySchema = categoryBodySchema.partial();
export type CategoryUpdateBody = z.infer<typeof categoryUpdateBodySchema>;

// ---------- 物料 ----------
export const itemBodySchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(200),
  base_unit: z.string().trim().min(1).max(20),
  category_id: refId,
  is_active: boolIntSchema.optional(),
  qty_precision: z.number().int().min(0).max(6).optional(),
  inspection_required: boolIntSchema.optional(),
  batch_managed: boolIntSchema.optional(),
  serial_managed: boolIntSchema.optional(),
});
export type ItemBody = z.infer<typeof itemBodySchema>;

export const itemUpdateBodySchema = itemBodySchema.partial();
export type ItemUpdateBody = z.infer<typeof itemUpdateBodySchema>;

export const itemQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  isActive: z.enum(['0', '1']).optional(),
});
export type ItemQuery = z.infer<typeof itemQuerySchema>;

/** 需客户认证的客户清单（替代逗号拼接字符串） */
export const itemCertificationBodySchema = z.object({
  customerIds: z.array(z.number().int().positive()),
});
export type ItemCertificationBody = z.infer<typeof itemCertificationBodySchema>;

// ---------- 往来单位 ----------
export const partnerBodySchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  type: z.enum(PARTNER_TYPES),
  contact: optionalText(50),
  phone: optionalText(30),
  address: optionalText(200),
  is_active: boolIntSchema.optional(),
});
export type PartnerBody = z.infer<typeof partnerBodySchema>;

export const partnerUpdateBodySchema = partnerBodySchema.partial();
export type PartnerUpdateBody = z.infer<typeof partnerUpdateBodySchema>;

export const partnerQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(100).optional(),
  type: z.enum(PARTNER_TYPES).optional(),
  isActive: z.enum(['0', '1']).optional(),
});
export type PartnerQuery = z.infer<typeof partnerQuerySchema>;

// ---------- 仓库 / 工厂 / 港口 ----------
export const warehouseBodySchema = z.object({
  code: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  type: z.enum(WAREHOUSE_TYPES).default('warehouse'),
  parent_id: refId,
  is_active: boolIntSchema.optional(),
});
export type WarehouseBody = z.infer<typeof warehouseBodySchema>;

export const warehouseUpdateBodySchema = warehouseBodySchema.partial();
export type WarehouseUpdateBody = z.infer<typeof warehouseUpdateBodySchema>;

// ---------- BOM ----------
export const bomBodySchema = z.object({
  parent_item_id: z.number().int().positive(),
  child_item_id: z.number().int().positive(),
  qty_per: z.number().int().positive(),
  scrap_rate: z.number().min(0).max(1).optional(),
  effective_from: dateSchema.nullable().optional(),
  effective_to: dateSchema.nullable().optional(),
});
export type BomBody = z.infer<typeof bomBodySchema>;

export const bomUpdateBodySchema = bomBodySchema
  .omit({ parent_item_id: true, child_item_id: true })
  .partial();
export type BomUpdateBody = z.infer<typeof bomUpdateBodySchema>;

export const bomQuerySchema = z.object({
  parentItemId: z.coerce.number().int().positive().optional(),
  childItemId: z.coerce.number().int().positive().optional(),
  keyword: z.string().trim().max(100).optional(),
  /** 传入时只返回该日期生效的版本（YYYY-MM-DD）；缺省返回全部版本 */
  asOf: dateSchema.optional(),
});
export type BomQuery = z.infer<typeof bomQuerySchema>;

/** 多层展开：itemId 与 itemCode 至少提供一个；qty 为上层需求数量 */
export const bomExplodeQuerySchema = z
  .object({
    itemId: z.coerce.number().int().positive().optional(),
    itemCode: z.string().trim().min(1).max(50).optional(),
    asOf: dateSchema.optional(),
    qty: z.coerce.number().positive().default(1),
  })
  .refine((value) => value.itemId !== undefined || value.itemCode !== undefined, {
    message: '必须提供 itemId 或 itemCode',
    path: ['itemId'],
  });
export type BomExplodeQuery = z.infer<typeof bomExplodeQuerySchema>;