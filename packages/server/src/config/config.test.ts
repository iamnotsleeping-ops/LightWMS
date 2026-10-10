import { describe, expect, it } from 'vitest';
import { validateStartupConfig, type StartupConfigInput } from './index';

/** 一份「生产环境正确配置」的基线 */
function production(overrides: Partial<StartupConfigInput> = {}): StartupConfigInput {
  return {
    env: 'production',
    provider: 'dingtalk',
    jwtSecret: 'a'.repeat(64),
    dingtalk: {
      appKey: 'key',
      appSecret: 'secret',
      redirectUri: 'https://erp.example.com/api/auth/dingtalk/callback',
    },
    publicApiKey: 'f'.repeat(64),
    ...overrides,
  };
}

describe('生产启动配置自检', () => {
  it('开发环境不做任何限制（保持本地便利）', () => {
    expect(
      validateStartupConfig(
        production({ env: 'development', provider: 'mock', jwtSecret: 'dev-secret-change-me' }),
      ),
    ).toEqual([]);
    expect(validateStartupConfig(production({ env: 'test' }))).toEqual([]);
  });

  it('配置齐备的生产环境通过', () => {
    expect(validateStartupConfig(production())).toEqual([]);
  });

  it('生产环境用 mock 登录通道被拒（任意姓名可自助获得 sys_admin）', () => {
    const problems = validateStartupConfig(production({ provider: 'mock' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('AUTH_PROVIDER 不能为 mock');
    expect(problems[0]).toContain('ALLOW_INSECURE_AUTH=true');
  });

  it('显式放行（ALLOW_INSECURE_AUTH=true）且关闭自助建号后 mock 不再阻断启动', () => {
    // 生产用 mock 的**唯一**合格组合：显式放行 + 关闭自助建号/自动授权
    expect(
      validateStartupConfig(
        production({ provider: 'mock', allowInsecureAuth: true, mockAutoAdmin: false }),
      ),
    ).toEqual([]);

    // 放行 mock 不能顺带放过默认 JWT 密钥
    const problems = validateStartupConfig(
      production({
        provider: 'mock',
        allowInsecureAuth: true,
        mockAutoAdmin: false,
        jwtSecret: 'dev-secret-change-me',
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('JWT_SECRET 仍为默认值');
  });

  it('只放行 mock 但仍开着自助建号 → 仍被拒（否则任意姓名即可获得 sys_admin）', () => {
    const problems = validateStartupConfig(
      production({ provider: 'mock', allowInsecureAuth: true }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('MOCK_AUTO_ADMIN');
  });

  it('逃生开关不影响非生产环境', () => {
    expect(
      validateStartupConfig(production({ env: 'development', provider: 'mock' })),
    ).toEqual([]);
  });

  it('生产环境沿用默认 JWT 密钥被拒（否则令牌可伪造）', () => {
    const problems = validateStartupConfig(production({ jwtSecret: 'dev-secret-change-me' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('JWT_SECRET 仍为默认值');
  });

  it('钉钉通道缺少必填项逐项报出', () => {
    const problems = validateStartupConfig(
      production({ dingtalk: { appKey: '', appSecret: '', redirectUri: '' } }),
    );
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('DINGTALK_APP_KEY');
    expect(problems.join('\n')).toContain('DINGTALK_APP_SECRET');
    expect(problems.join('\n')).toContain('DINGTALK_REDIRECT_URI');
  });

  it('生产环境未配置 PUBLIC_API_KEY 被拒（否则 /api/v1 商业数据公网裸奔）', () => {
    const problems = validateStartupConfig(production({ publicApiKey: '' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PUBLIC_API_KEY 未配置');
    expect(problems[0]).toContain('/api/v1');

    // 空串与「没传」等价
    expect(validateStartupConfig(production({ publicApiKey: undefined }))).toHaveLength(1);
  });

  it('生产环境 PUBLIC_API_KEY 过短被拒（拒绝弱 Key）', () => {
    const problems = validateStartupConfig(production({ publicApiKey: 'short-key' }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('PUBLIC_API_KEY 过短');
  });

  it('非生产环境不要求 PUBLIC_API_KEY（本地开发/测试放行）', () => {
    expect(validateStartupConfig(production({ env: 'development', publicApiKey: '' }))).toEqual([]);
    expect(validateStartupConfig(production({ env: 'test', publicApiKey: '' }))).toEqual([]);
  });

  it('mock 与默认密钥同时踩中时问题全部列出，不早退', () => {
    const problems = validateStartupConfig(
      production({ provider: 'mock', jwtSecret: 'dev-secret-change-me' }),
    );
    // mock 未放行 + 默认密钥 = 2 条
    expect(problems).toHaveLength(2);

    // 放行后：mock 自助建号未关 + 默认密钥 = 仍是 2 条
    const passed = validateStartupConfig(
      production({ provider: 'mock', allowInsecureAuth: true, jwtSecret: 'dev-secret-change-me' }),
    );
    expect(passed).toHaveLength(2);
    expect(passed.join('\n')).toContain('MOCK_AUTO_ADMIN');
    expect(passed.join('\n')).toContain('JWT_SECRET 仍为默认值');
  });
});
