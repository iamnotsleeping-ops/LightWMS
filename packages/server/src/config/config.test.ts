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

  it('mock 与默认密钥同时踩中时问题全部列出，不早退', () => {
    const problems = validateStartupConfig(
      production({ provider: 'mock', jwtSecret: 'dev-secret-change-me' }),
    );
    expect(problems).toHaveLength(2);
  });
});
