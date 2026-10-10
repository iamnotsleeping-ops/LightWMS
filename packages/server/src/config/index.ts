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
    /**
     * mock 通道是否允许「自助建号 + 自动授予 sys_admin」，默认开启以保留本地开发便利。
     *
     * 关闭后 mock 登录**只能登录已存在的账号**：不再按姓名建号、也不再补授任何角色。
     * 生产上用 mock 时必须关闭——否则任何人填一个姓名就能拿到 `sys_admin`。
     * 注意：关闭本项并不能救回「账号名可猜」的问题（账号名即口令），
     * 故生产上还必须保证已存在账号的名字足够随机，见 `insecureAuthWarning()`。
     */
    mockAutoAdmin: bool(process.env.MOCK_AUTO_ADMIN, true),
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
  /**
   * 对外只读接口（`/api/v1`）的 API Key（`PUBLIC_API_KEY`）。
   *
   * `/api/v1` 暴露库存、采购单价、供应商提前期、销售订单行、客户认证等**商业数据**，
   * 无鉴权就等于公网裸奔。配了 Key 后所有 `/api/v1` **数据**接口都要求请求头 `X-API-Key`
   * （`/api/v1/openapi.json` 是契约文档、不含数据，保持公开）。
   *
   * 空值只在**非生产**环境放行（本地开发/测试便利）；生产环境为空会在启动自检里被拦下。
   * 轮换 = 改这个值 + 重启。
   */
  publicApiKey: process.env.PUBLIC_API_KEY ?? '',
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
  /** mock 通道是否允许自助建号并自动授予 sys_admin（MOCK_AUTO_ADMIN，默认 true） */
  mockAutoAdmin?: boolean;
  /** 对外只读接口的 API Key（PUBLIC_API_KEY）；空串表示未配置 */
  publicApiKey?: string;
}

/**
 * 启动前自检：把「能跑但危险」的配置组合拦在启动阶段。
 *
 * 背景：`AUTH_PROVIDER` 缺省为 mock，而 mock 通道默认会用**任意姓名**自动建号并授予
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
      'AUTH_PROVIDER 不能为 mock：mock 通道默认允许任意姓名自助登录并自动获得 sys_admin。' +
        '如确需在可信网络内这样部署，请显式设置 ALLOW_INSECURE_AUTH=true 承担该风险' +
        '（并建议同时设置 MOCK_AUTO_ADMIN=false 关闭自助建号与自动授权）',
    );
  }
  if (input.provider === 'mock' && input.allowInsecureAuth && input.mockAutoAdmin !== false) {
    problems.push(
      '生产环境用 mock 通道时 MOCK_AUTO_ADMIN 必须为 false：否则任何能访问本服务的人' +
        '都可以用任意姓名自助登录并获得 sys_admin',
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
  // `/api/v1` 暴露库存、采购单价、供应商提前期、销售订单行、客户认证等商业数据，
  // 生产环境没有 API Key 就等于公网裸奔——fail-fast，不给"忘了配"留后门。
  const publicApiKey = input.publicApiKey ?? '';
  if (publicApiKey === '') {
    problems.push(
      'PUBLIC_API_KEY 未配置：对外只读接口 /api/v1 会在无鉴权下公开库存、采购单价、' +
        '供应商提前期、销售订单行等商业数据。请设置随机长字符串（可用 openssl rand -hex 32 生成）',
    );
  } else if (publicApiKey.length < 24) {
    problems.push('PUBLIC_API_KEY 过短（至少 24 个字符），请用 openssl rand -hex 32 生成随机长串');
  }
  return problems;
}

/**
 * 逃生开关生效时的显著告警文案；未生效返回 null。
 * 由 `server.ts` 在启动时打印，确保「用 mock 跑生产」这件事在日志里留痕。
 */
export function insecureAuthWarning(): string | null {
  if (config.env !== 'production' || config.auth.provider !== 'mock') return null;

  // MOCK_AUTO_ADMIN=false 时不再有"填个名字就当管理员"的洞，但 mock 的凭据就是账号名，
  // 因此仍然必须把既有的管理员账号换成不可猜的名字，否则等于把口令写在门牌上。
  if (config.auth.mockAutoAdmin === false) {
    return (
      '生产环境正在使用 mock 登录通道（ALLOW_INSECURE_AUTH=true），已通过 ' +
      'MOCK_AUTO_ADMIN=false 关闭自助建号与自动授权：仅**已存在**的账号可登录，且不会补授任何角色。' +
      '注意 mock 的凭据就是账号名本身——请确认现有账号名不可猜（建议随机长串），' +
      '否则知道名字的人即可登录为该账号。请尽快切换为 AUTH_PROVIDER=dingtalk。'
    );
  }

  if (!config.allowInsecureAuth) return null;
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
    mockAutoAdmin: config.auth.mockAutoAdmin,
    publicApiKey: config.publicApiKey,
  });
}