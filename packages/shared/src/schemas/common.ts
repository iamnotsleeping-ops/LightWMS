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