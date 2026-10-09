import { z } from 'zod';

export const AUTH_PROVIDERS = ['dingtalk', 'mock'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

/**
 * mock 登录入参。
 *
 * 不做默认值：默认值会把「本地开发用户」这个可猜的名字固化进契约，而 mock 的凭据
 * 就是账号名本身——生产上关闭 `MOCK_AUTO_ADMIN` 并清理可猜账号后，任何默认名都只会
 * 产生一次必然失败的登录。名字必须由调用方显式给出。
 */
export const mockLoginBodySchema = z.object({
  name: z.string().trim().min(1, '请填写账号名').max(50),
});
export type MockLoginBody = z.infer<typeof mockLoginBodySchema>;

export interface AuthUser {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  avatarUrl: string | null;
  lastLoginAt: string | null;
  roles: { id: number; code: string; name: string }[];
  permissions: string[];
}