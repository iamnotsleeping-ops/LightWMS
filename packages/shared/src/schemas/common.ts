import { z } from 'zod';

/** 路由参数中的主键 */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
export type IdParam = z.infer<typeof idParamSchema>;

/** 分页查询：page 从 1 开始 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** 业务日期统一 YYYY-MM-DD */
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

/** SQLite 以 0/1 存布尔，入参兼容 true/false 与 0/1 */
export const boolIntSchema = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => (value === true || value === 1 ? 1 : 0));

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** 选填文本：空字符串视为未填写，便于前端表单直接提交 */
export const optionalText = (max: number): z.ZodType<string | undefined> =>
  z.preprocess(emptyToUndefined, z.string().trim().max(max).optional()) as z.ZodType<
    string | undefined
  >;

/** 出入库 / 退货明细行：只允许提交已存在的订单行与正整数数量 */
export const orderItemLineSchema = z.object({
  orderItemId: z.number().int().positive(),
  quantity: z.number().int().positive(),
});
export type OrderItemLine = z.infer<typeof orderItemLineSchema>;

/**
 * 明细行 `orderItemId` 唯一性。
 *
 * 服务端的「在途量 / 未出库量 / 可退量」校验都基于**库中当前快照**，同一请求内重复出现同一
 * 订单行时每一行都会独立通过校验，而累加发生在过账循环里，最终造成超收入库、超量出库或超量
 * 退货（退货还会凭空增加库存）。因此在入参层直接拒绝重复行，服务层再做请求内累计校验兜底。
 */
export const distinctOrderItemIds = (lines: readonly OrderItemLine[]): boolean =>
  new Set(lines.map((line) => line.orderItemId)).size === lines.length;

/** 明细行数组：至少一行且同一订单行不重复 */
export const orderItemLinesSchema = (minMessage: string) =>
  z
    .array(orderItemLineSchema)
    .min(1, minMessage)
    .refine(distinctOrderItemIds, { message: '同一订单行不能重复提交，请合并数量后重试' });