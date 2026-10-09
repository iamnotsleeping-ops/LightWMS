import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app';
import type { Db } from '../../db/connection';
import { createAuthorizedUser, createTestDb, grantPermissions } from '../../test/db';

/** 系统参数只读接口：/api/system/params */
let db: Db;
let app: FastifyInstance;

beforeEach(async () => {
  db = createTestDb();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

/** 授权以数据库为准，故这里落真实用户 + 真实权限关联，而不是伪造 JWT 载荷 */
const tokenWith = (permissions: string[]) =>
  app.jwt.sign({
    sub: createAuthorizedUser(db, permissions),
    name: 'tester',
    roles: [],
    permissions,
  });

describe('系统参数（只读）', () => {
  it('有 system.param.view 权限时返回参数清单', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith(['system.param.view'])}` },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.code).toBe(0);
    const keys = (payload.data as { key: string }[]).map((row) => row.key);
    expect(keys).toContain('port_stock_as_inventory');
  });

  it('缺少权限时返回 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith([])}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe(403);
  });

  it('未登录时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/params' });
    expect(response.statusCode).toBe(401);
  });

  it('接口只读：调用不改变 sys_param 内容', async () => {
    const before = db.prepare('SELECT key, value FROM sys_param ORDER BY key').all();
    await app.inject({
      method: 'GET',
      url: '/api/system/params',
      headers: { authorization: `Bearer ${tokenWith(['system.param.view'])}` },
    });
    const after = db.prepare('SELECT key, value FROM sys_param ORDER BY key').all();
    expect(after).toEqual(before);
  });
});

// ---------- RBAC 护栏 ----------

const tokenFor = (sub: number, permissions: string[]) => {
  grantPermissions(db, sub, permissions);
  return app.jwt.sign({ sub, name: `user-${sub}`, roles: [], permissions });
};

function insertUser(name: string): number {
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO sys_user (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)')
    .run(name, now, now);
  return Number(info.lastInsertRowid);
}

function roleIdOf(code: string): number {
  return (db.prepare('SELECT id FROM sys_role WHERE code = ?').get(code) as { id: number }).id;
}

function grantRole(userId: number, roleId: number): void {
  db.prepare('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)').run(userId, roleId);
}

function roleCodesOf(userId: number): string[] {
  return (
    db
      .prepare(
        'SELECT r.code FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.code',
      )
      .all(userId) as { code: string }[]
  ).map((row) => row.code);
}

function permissionIdsOf(roleId: number): number[] {
  return (
    db
      .prepare('SELECT permission_id FROM sys_role_permission WHERE role_id = ? ORDER BY permission_id')
      .all(roleId) as { permission_id: number }[]
  ).map((row) => row.permission_id);
}

describe('RBAC：内置管理员权限集不可修改', () => {
  it('改写 sys_admin 的权限被拒 409，且权限集原样不变', async () => {
    const adminRoleId = roleIdOf('sys_admin');
    const before = permissionIdsOf(adminRoleId);
    expect(before.length).toBeGreaterThan(30);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/roles/${adminRoleId}/permissions`,
      headers: { authorization: `Bearer ${tokenWith(['system.role.manage'])}` },
      payload: { permissionIds: [] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('内置系统管理员的权限不可修改');
    expect(permissionIdsOf(adminRoleId)).toEqual(before);
  });

  it('普通角色的权限仍可正常改写（未被误伤）', async () => {
    const viewerRoleId = roleIdOf('viewer');
    const somePermissions = permissionIdsOf(roleIdOf('sys_admin')).slice(0, 3);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/roles/${viewerRoleId}/permissions`,
      headers: { authorization: `Bearer ${tokenWith(['system.role.manage'])}` },
      payload: { permissionIds: somePermissions },
    });

    expect(response.statusCode).toBe(200);
    expect(permissionIdsOf(viewerRoleId)).toEqual([...somePermissions].sort((a, b) => a - b));
  });
});

describe('RBAC：角色分配护栏', () => {
  it('不能修改自己的角色（阻断自我提权与自我降级）', async () => {
    const managerId = insertUser('自我操作者');
    const adminRoleId = roleIdOf('sys_admin');
    grantRole(managerId, roleIdOf('viewer'));

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${managerId}/roles`,
      headers: { authorization: `Bearer ${tokenFor(managerId, ['system.user.manage'])}` },
      payload: { roleIds: [adminRoleId] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('不能修改自己的角色');
    // 角色集合未被改动：仍是 viewer，且没有拿到 sys_admin
    expect(roleCodesOf(managerId)).toContain('viewer');
    expect(roleCodesOf(managerId)).not.toContain('sys_admin');
  });

  it('不能移除最后一名系统管理员', async () => {
    const onlyAdmin = insertUser('唯一管理员');
    grantRole(onlyAdmin, roleIdOf('sys_admin'));
    const actor = insertUser('操作者');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${onlyAdmin}/roles`,
      headers: { authorization: `Bearer ${tokenFor(actor, ['system.user.manage'])}` },
      payload: { roleIds: [] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('至少一名系统管理员');
    expect(roleCodesOf(onlyAdmin)).toEqual(['sys_admin']);
  });

  it('存在第二名管理员时可以正常降级其中一名', async () => {
    const first = insertUser('管理员甲');
    const second = insertUser('管理员乙');
    const adminRoleId = roleIdOf('sys_admin');
    grantRole(first, adminRoleId);
    grantRole(second, adminRoleId);
    const actor = insertUser('操作者');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${second}/roles`,
      headers: { authorization: `Bearer ${tokenFor(actor, ['system.user.manage'])}` },
      payload: { roleIds: [roleIdOf('viewer')] },
    });

    expect(response.statusCode).toBe(200);
    expect(roleCodesOf(second)).toEqual(['viewer']);
  });

  it('分配不存在的角色返回 400 而非外键 500', async () => {
    const target = insertUser('目标用户');
    const actor = insertUser('操作者');

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target}/roles`,
      headers: { authorization: `Bearer ${tokenFor(actor, ['system.user.manage'])}` },
      payload: { roleIds: [999999] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('角色不存在');
  });
});
