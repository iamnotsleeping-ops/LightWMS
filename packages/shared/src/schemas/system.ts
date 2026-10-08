import { z } from 'zod';
import { paginationQuerySchema } from './common';

export const userQuerySchema = paginationQuerySchema.extend({
  keyword: z.string().trim().max(50).optional(),
});
export type UserQuery = z.infer<typeof userQuerySchema>;

export const userCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(50),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(100).optional(),
  is_active: z.boolean().default(true),
});
export type UserCreateBody = z.infer<typeof userCreateBodySchema>;

export const userUpdateBodySchema = userCreateBodySchema.partial();
export type UserUpdateBody = z.infer<typeof userUpdateBodySchema>;

export const userRoleBodySchema = z.object({
  roleIds: z.array(z.number().int().positive()),
});
export type UserRoleBody = z.infer<typeof userRoleBodySchema>;

/** 角色编码限定小写字母/数字/下划线，作为权限判断的稳定标识 */
export const roleBodySchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, '角色编码仅支持小写字母、数字与下划线，且以字母开头'),
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(200).optional(),
});
export type RoleBody = z.infer<typeof roleBodySchema>;

export const roleUpdateBodySchema = roleBodySchema.omit({ code: true }).partial();
export type RoleUpdateBody = z.infer<typeof roleUpdateBodySchema>;

export const rolePermissionBodySchema = z.object({
  permissionIds: z.array(z.number().int().positive()),
});
export type RolePermissionBody = z.infer<typeof rolePermissionBodySchema>;