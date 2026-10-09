import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { ApiError } from '../../lib/response';
import { createAuthorizedUser, createTestDb, grantPermissions } from '../../test/db';

/**
 * 授权边界测试。
 *
 * 重点：`plugins/auth.ts` 的授权**以数据库为准**，不再信任 JWT 里的 `permissions` 快照。
 * 因此这里逐条覆盖「令牌有效但身份已变」的场景——停用账号、撤销权限、令牌声明与库中
 * 实际权限不一致——这些在只信令牌的旧实现下全部会漏过。
 *
 * 受保护端点选用 `/api/system/params`（需 `system.param.view`）。
 */

const PARAMS_URL = '/api/system/params';
const PARAM_VIEW = ['system.param.view'];

let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = createTestDb();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

const sign = (sub: number, permissions: string[], extra: Record<string, unknown> = {}) =>
  app.jwt.sign({ sub, name: 'tester', roles: [], permissions, ...extra });

const getParams = (bearer?: string) =>
  app.inject({
    method: 'GET',
    url: PARAMS_URL,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

describe('令牌校验', () => {
  it('缺 Authorization 头 → 401', async () => {
    const response = await getParams();
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe(401);
  });

  it('已过期令牌 → 401', async () => {
    const userId = createAuthorizedUser(db, PARAM_VIEW);
    const expired = sign(userId, PARAM_VIEW, { exp: Math.floor(Date.now() / 1000) - 60 });

    const response = await getParams(expired);
    expect(response.statusCode).toBe(401);
  });

  it('伪造签名的令牌 → 401', async () => {
    const userId = createAuthorizedUser(db, PARAM_VIEW);
    const forged = app.jwt.sign(
      { sub: userId, name: 'tester', roles: [], permissions: PARAM_VIEW },
      { key: 'attacker-secret' },
    );

    const response = await getParams(forged);
    expect(response.statusCode).toBe(401);
  });

  it('令牌指向不存在的用户 → 401（不再因签名有效就放行）', async () => {
    const response = await getParams(sign(999999, PARAM_VIEW));
    expect(response.statusCode).toBe(401);
    expect(response.json().message).toContain('停用');
  });
});

describe('账号停用即时生效', () => {
  it('停用后同一枚有效令牌立即被拒 401（旧实现在 8h 内仍可用）', async () => {
    const userId = createAuthorizedUser(db, PARAM_VIEW);
    const token = sign(userId, PARAM_VIEW);

    expect((await getParams(token)).statusCode).toBe(200);

    db.prepare('UPDATE sys_user SET is_active = 0 WHERE id = ?').run(userId);

    const after = await getParams(token);
    expect(after.statusCode).toBe(401);
    expect(after.json().message).toContain('停用');
  });

  it('/api/auth/me 对已停用用户同样拒绝', async () => {
    const userId = createAuthorizedUser(db, PARAM_VIEW);
    const token = sign(userId, PARAM_VIEW);
    db.prepare('UPDATE sys_user SET is_active = 0 WHERE id = ?').run(userId);

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('权限以数据库为准，而非令牌快照', () => {
  it('令牌声明有权限但库中未授予 → 403（防止靠改载荷提权）', async () => {
    const userId = createAuthorizedUser(db, []);
    const lying = sign(userId, PARAM_VIEW);

    const response = await getParams(lying);
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('无该操作权限');
  });

  it('撤销角色后同一枚有效令牌立即 403', async () => {
    const userId = createAuthorizedUser(db, PARAM_VIEW);
    const token = sign(userId, PARAM_VIEW);
    expect((await getParams(token)).statusCode).toBe(200);

    // 撤销：移除该用户的全部角色关联
    db.prepare('DELETE FROM sys_user_role WHERE user_id = ?').run(userId);

    const after = await getParams(token);
    expect(after.statusCode).toBe(403);
  });

  it('新增授权后无需重新登录即可生效', async () => {
    const userId = createAuthorizedUser(db, []);
    const token = sign(userId, []);
    expect((await getParams(token)).statusCode).toBe(403);

    grantPermissions(db, userId, PARAM_VIEW);

    expect((await getParams(token)).statusCode).toBe(200);
  });
});

describe('mock 登录通道的提权风险（服务层事实记录）', () => {
  it('ensureMockUser 对任意姓名建号并自动授予 sys_admin', async () => {
    const { ensureMockUser } = await import('./auth.service');
    const userId = ensureMockUser('路人甲');

    const roles = db
      .prepare(
        'SELECT r.code FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE ur.user_id = ?',
      )
      .all(userId) as { code: string }[];
    expect(roles.map((row) => row.code)).toEqual(['sys_admin']);

    // 因此该通道在生产环境必须关闭——由 config 自检强制（见 config.test.ts）
  });

  it('MOCK_AUTO_ADMIN=false：不再自助建号（未知姓名直接 401，不留脏数据）', async () => {
    const { ensureMockUser } = await import('./auth.service');

    expect(() => ensureMockUser('路人乙', false)).toThrow(ApiError);
    expect(() => ensureMockUser('路人乙', false)).toThrow(/未开启自助建号/);

    const count = db.prepare('SELECT COUNT(*) AS n FROM sys_user').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('MOCK_AUTO_ADMIN=false：已存在账号可登录，且不会补授任何角色', async () => {
    const { ensureMockUser } = await import('./auth.service');

    // 先造一个「无角色」的既有账号（模拟运维手工建的账号）
    const now = new Date().toISOString();
    const userId = Number(
      db
        .prepare(
          `INSERT INTO sys_user (dingtalk_user_id, name, is_active, created_at, updated_at)
           VALUES ('mock:运维入口-9f3a7c', '运维入口-9f3a7c', 1, ?, ?)`,
        )
        .run(now, now).lastInsertRowid,
    );

    const loginId = ensureMockUser('运维入口-9f3a7c', false);
    expect(loginId).toBe(userId);

    const roles = db
      .prepare('SELECT COUNT(*) AS n FROM sys_user_role WHERE user_id = ?')
      .get(userId) as { n: number };
    expect(roles.n).toBe(0); // 关键：关闭后不再自动补授 sys_admin
  });

  it('MOCK_AUTO_ADMIN=false：停用账号被拒（不会因关闭自助建号而绕过停用检查）', async () => {
    const { ensureMockUser } = await import('./auth.service');

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sys_user (dingtalk_user_id, name, is_active, created_at, updated_at)
       VALUES ('mock:离职员工', '离职员工', 0, ?, ?)`,
    ).run(now, now);

    expect(() => ensureMockUser('离职员工', false)).toThrow(/账号已停用/);
  });
});
