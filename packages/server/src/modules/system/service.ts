import type {
  RoleBody,
  RoleUpdateBody,
  UserCreateBody,
  UserQuery,
  UserUpdateBody,
} from '@light-erp/shared';
import { getDb } from '../../db/connection';
import { ApiError } from '../../lib/response';

export interface UserListItem {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  avatar_url: string | null;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
  roles: { id: number; code: string; name: string }[];
}

interface UserRow extends Omit<UserListItem, 'roles'> {}

export function listUsers(query: UserQuery): { list: UserListItem[]; total: number } {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.keyword) {
    where.push('(u.name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ?)');
    const keyword = `%${query.keyword}%`;
    params.push(keyword, keyword, keyword);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sys_user u ${clause}`)
    .get(...params) as { total: number };

  const list = db
    .prepare(
      `SELECT u.id, u.name, u.mobile, u.email, u.avatar_url, u.is_active, u.last_login_at, u.created_at
       FROM sys_user u ${clause}
       ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as UserRow[];

  const roleMap = new Map<number, { id: number; code: string; name: string }[]>();
  if (list.length > 0) {
    const ids = list.map((row) => row.id);
    const roleRows = db
      .prepare(
        `SELECT ur.user_id AS user_id, r.id AS id, r.code AS code, r.name AS name
         FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id
         WHERE ur.user_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`,
      )
      .all(...ids) as { user_id: number; id: number; code: string; name: string }[];
    for (const row of roleRows) {
      const current = roleMap.get(row.user_id) ?? [];
      current.push({ id: row.id, code: row.code, name: row.name });
      roleMap.set(row.user_id, current);
    }
  }

  return {
    list: list.map((row) => ({ ...row, roles: roleMap.get(row.id) ?? [] })),
    total,
  };
}

export function createUser(body: UserCreateBody): number {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO sys_user (name, mobile, email, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(body.name, body.mobile ?? null, body.email ?? null, body.is_active ? 1 : 0, now, now);
  return Number(info.lastInsertRowid);
}

export function updateUser(id: number, body: UserUpdateBody): void {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM sys_user WHERE id = ?').get(id);
  if (!exists) throw new ApiError(404, '用户不存在');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    params.push(body.name);
  }
  if (body.mobile !== undefined) {
    sets.push('mobile = ?');
    params.push(body.mobile || null);
  }
  if (body.email !== undefined) {
    sets.push('email = ?');
    params.push(body.email || null);
  }
  if (body.is_active !== undefined) {
    sets.push('is_active = ?');
    params.push(body.is_active ? 1 : 0);
  }
  if (sets.length === 0) return;

  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), id);
  db.prepare(`UPDATE sys_user SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * 重置某用户的角色集合。
 *
 * 两道防越权 / 防自锁护栏（原实现无任何校验，持 `system.user.manage` 者可直接给自己
 * 授予 `sys_admin`，或把最后一名管理员降级导致系统再无人可管理）：
 *   1. 不允许修改**自己**的角色 —— 提权与自锁都必须经他人之手；
 *   2. 不允许移除**最后一名**系统管理员。
 */
export function setUserRoles(
  userId: number,
  roleIds: number[],
  actorUserId: number | null = null,
): void {
  const db = getDb();
  const run = db.transaction(() => {
    const exists = db.prepare('SELECT id FROM sys_user WHERE id = ?').get(userId);
    if (!exists) throw new ApiError(404, '用户不存在');

    if (actorUserId !== null && actorUserId === userId) {
      throw new ApiError(409, '不能修改自己的角色，请由其他管理员操作');
    }

    const roleCheck = db.prepare('SELECT id FROM sys_role WHERE id = ?');
    for (const roleId of roleIds) {
      if (!roleCheck.get(roleId)) throw new ApiError(400, `角色不存在（id=${roleId}）`);
    }

    const adminRole = db
      .prepare("SELECT id FROM sys_role WHERE code = 'sys_admin'")
      .get() as { id: number } | undefined;
    if (adminRole) {
      const holdsAdmin = db
        .prepare('SELECT 1 AS ok FROM sys_user_role WHERE user_id = ? AND role_id = ?')
        .get(userId, adminRole.id);
      if (holdsAdmin && !roleIds.includes(adminRole.id)) {
        const others = db
          .prepare('SELECT COUNT(*) AS c FROM sys_user_role WHERE role_id = ? AND user_id <> ?')
          .get(adminRole.id, userId) as { c: number };
        if (others.c === 0) {
          throw new ApiError(409, '系统必须保留至少一名系统管理员，不能移除最后一名');
        }
      }
    }

    db.prepare('DELETE FROM sys_user_role WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)');
    for (const roleId of roleIds) insert.run(userId, roleId);
  });
  run();
}

export interface RoleListItem {
  id: number;
  code: string;
  name: string;
  description: string | null;
  user_count: number;
  permissionIds: number[];
}

export function listRoles(): RoleListItem[] {
  const db = getDb();
  const roles = db
    .prepare(
      `SELECT r.id, r.code, r.name, r.description,
              (SELECT COUNT(*) FROM sys_user_role ur WHERE ur.role_id = r.id) AS user_count
       FROM sys_role r ORDER BY r.id`,
    )
    .all() as Omit<RoleListItem, 'permissionIds'>[];

  const pairs = db
    .prepare('SELECT role_id, permission_id FROM sys_role_permission')
    .all() as { role_id: number; permission_id: number }[];
  const map = new Map<number, number[]>();
  for (const pair of pairs) {
    const current = map.get(pair.role_id) ?? [];
    current.push(pair.permission_id);
    map.set(pair.role_id, current);
  }

  return roles.map((role) => ({ ...role, permissionIds: map.get(role.id) ?? [] }));
}

export function createRole(body: RoleBody): number {
  const db = getDb();
  const info = db
    .prepare('INSERT INTO sys_role (code, name, description) VALUES (?, ?, ?)')
    .run(body.code, body.name, body.description ?? null);
  return Number(info.lastInsertRowid);
}

export function updateRole(id: number, body: RoleUpdateBody): void {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM sys_role WHERE id = ?').get(id);
  if (!exists) throw new ApiError(404, '角色不存在');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name !== undefined) {
    sets.push('name = ?');
    params.push(body.name);
  }
  if (body.description !== undefined) {
    sets.push('description = ?');
    params.push(body.description || null);
  }
  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE sys_role SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteRole(id: number): void {
  const db = getDb();
  const role = db.prepare('SELECT code FROM sys_role WHERE id = ?').get(id) as
    | { code: string }
    | undefined;
  if (!role) throw new ApiError(404, '角色不存在');
  if (role.code === 'sys_admin') throw new ApiError(409, '内置系统管理员角色不可删除');

  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM sys_user_role WHERE role_id = ?')
    .get(id) as { count: number };
  if (count > 0) throw new ApiError(409, `该角色已分配给 ${count} 个用户，请先解除分配`);

  db.prepare('DELETE FROM sys_role WHERE id = ?').run(id);
}

/**
 * 重置某角色的权限集合。
 *
 * `sys_admin` 的权限集**不可修改**：它被定义为「拥有全部权限」，允许改写会让持
 * `system.role.manage` 者把全部权限授予任意低权角色（提权），或清空内置管理员权限
 * 导致系统再无人可管理（自锁）。与 `deleteRole` 拒绝删除 `sys_admin` 保持一致。
 * 后续若新增权限码，应由迁移显式补授给 `sys_admin`，而不是走本接口。
 */
export function setRolePermissions(roleId: number, permissionIds: number[]): void {
  const db = getDb();
  const run = db.transaction(() => {
    const role = db.prepare('SELECT id, code FROM sys_role WHERE id = ?').get(roleId) as
      | { id: number; code: string }
      | undefined;
    if (!role) throw new ApiError(404, '角色不存在');
    if (role.code === 'sys_admin') {
      throw new ApiError(409, '内置系统管理员的权限不可修改（默认拥有全部权限）');
    }
    db.prepare('DELETE FROM sys_role_permission WHERE role_id = ?').run(roleId);
    const insert = db.prepare(
      'INSERT INTO sys_role_permission (role_id, permission_id) VALUES (?, ?)',
    );
    for (const permissionId of permissionIds) insert.run(roleId, permissionId);
  });
  run();
}

export function listPermissions(): { id: number; code: string; name: string; module: string }[] {
  return getDb()
    .prepare('SELECT id, code, name, module FROM sys_permission ORDER BY module, code')
    .all() as { id: number; code: string; name: string; module: string }[];
}

export interface ParamListItem {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

/** 系统参数只读清单 */
export function listParams(): ParamListItem[] {
  return getDb()
    .prepare('SELECT key, value, description, updated_at FROM sys_param ORDER BY key')
    .all() as ParamListItem[];
}