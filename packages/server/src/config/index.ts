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

/** 本地开发用的默认密钥；一旦在生产环境出现即视为配置事故 */
const DEV_JWT_SECRET = 'dev-secret-change-me';

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
    jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
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
  /**
   * 显式接受「生产环境使用 mock 登录通道」这一风险的逃生开关，默认关闭。
   * 仅为「受控网络内的一次性部署」留出通路——打开后启动会有显著安全告警。
   */
  allowInsecureAuth: bool(process.env.ALLOW_INSECURE_AUTH, false),
} as const;

export type AppConfig = typeof config;

/** 启动自检的输入（与 config 结构解耦，便于单测注入） */
export interface StartupConfigInput {
  env: string;
  provider: string;
  jwtSecret: string;
  dingtalk: { appKey: string; appSecret: string; redirectUri: string };
  /** 是否已显式放行 mock 通道（ALLOW_INSECURE_AUTH） */
  allowInsecureAuth?: boolean;
}

/**
 * 启动前自检：把「能跑但危险」的配置组合拦在启动阶段。
 *
 * 背景：`AUTH_PROVIDER` 缺省为 mock，而 mock 通道会用**任意姓名**自动建号并授予
 * `sys_admin`；`JWT_SECRET` 缺省为弱值，泄漏即可伪造任意用户令牌。两者只要有一项
 * 在生产环境被漏配，就等于对外开放了管理员自助入口。因此这里只做「生产必须显式配置」
 * 的 fail-fast，不改变开发期的默认便利。
 *
 * 返回问题清单（空数组表示通过）。纯函数，不做 IO，便于测试。
 */
export function validateStartupConfig(input: StartupConfigInput): string[] {
  if (input.env !== 'production') return [];

  const problems: string[] = [];
  if (input.provider === 'mock' && !input.allowInsecureAuth) {
    problems.push(
      'AUTH_PROVIDER 不能为 mock：mock 通道允许任意姓名自助登录并自动获得 sys_admin。' +
        '如确需在可信网络内这样部署，请显式设置 ALLOW_INSECURE_AUTH=true 承担该风险',
    );
  }
  if (input.jwtSecret === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET 仍为默认值，必须改为随机长字符串（可用 openssl rand -hex 32 生成）');
  }
  if (input.provider === 'dingtalk') {
    if (!input.dingtalk.appKey) problems.push('DINGTALK_APP_KEY 未配置');
    if (!input.dingtalk.appSecret) problems.push('DINGTALK_APP_SECRET 未配置');
    if (!input.dingtalk.redirectUri) problems.push('DINGTALK_REDIRECT_URI 未配置');
  }
  return problems;
}

/**
 * 逃生开关生效时的显著告警文案；未生效返回 null。
 * 由 `server.ts` 在启动时打印，确保「用 mock 跑生产」这件事在日志里留痕。
 */
export function insecureAuthWarning(): string | null {
  if (config.env !== 'production' || config.auth.provider !== 'mock' || !config.allowInsecureAuth) {
    return null;
  }
  return (
    '生产环境正在使用 mock 登录通道，且已通过 ALLOW_INSECURE_AUTH=true 显式放行：' +
    '任何能访问本服务的人都可以用任意姓名自助登录并获得 sys_admin。' +
    '请仅限可信网络（建议配合反向代理的 IP 白名单）使用，并尽快切换为 AUTH_PROVIDER=dingtalk。'
  );
}

/** 以当前进程配置执行自检；仅由 server.ts 在 listen 之前调用 */
export function assertStartupConfig(): string[] {
  return validateStartupConfig({
    env: config.env,
    provider: config.auth.provider,
    jwtSecret: config.auth.jwtSecret,
    dingtalk: config.dingtalk,
    allowInsecureAuth: config.allowInsecureAuth,
  });
}