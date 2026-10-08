import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

/** packages/server */
export const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** 仓库根目录 */
export const repoRoot = path.resolve(serverRoot, '../..');

loadEnv({ path: path.join(repoRoot, '.env') });

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const redirectUri = process.env.DINGTALK_REDIRECT_URI ?? '';

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3100),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(serverRoot, 'data', 'erp.db'),
  /**
   * 登录成功后前端回跳地址。默认取回调域名同源，
   * 保证「浏览器访问回调地址」与「回跳 Web 站点」是同一个站点。
   */
  webOrigin:
    process.env.WEB_ORIGIN ?? originOf(redirectUri) ?? 'http://localhost:5173',
  auth: {
    provider: (process.env.AUTH_PROVIDER ?? 'mock') as 'dingtalk' | 'mock',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  dingtalk: {
    appKey: process.env.DINGTALK_APP_KEY ?? '',
    appSecret: process.env.DINGTALK_APP_SECRET ?? '',
    corpId: process.env.DINGTALK_CORP_ID ?? '',
    agentId: process.env.DINGTALK_AGENT_ID ?? '',
    redirectUri,
  },
  /** 系统参数默认值，可被 sys_param 表覆盖 */
  defaults: {
    portStockAsInventory: bool(process.env.PORT_STOCK_AS_INVENTORY, false),
  },
} as const;

export type AppConfig = typeof config;