import { z } from 'zod';

export const AUTH_PROVIDERS = ['dingtalk', 'mock'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const mockLoginBodySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .default('本地开发用户'),
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