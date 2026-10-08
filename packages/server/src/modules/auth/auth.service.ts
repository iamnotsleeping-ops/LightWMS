import type { AuthUser } from '@light-erp/shared';
import { getDb } from '../../db/connection';
import type { DingtalkProfile } from './dingtalk.client';

interface UserRow {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  avatar_url: string | null;
  is_active: number;
  last_login_at: string | null;
}

export function loadUserAuthInfo(userId: number): AuthUser | null {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT id, name, mobile, email, avatar_url, is_active, last_login_at FROM sys_user WHERE id = ?',
    )
    .get(userId) as UserRow | undefined;
  if (!row || row.is_active !== 1) return null;

  const roles = db
    .prepare(
      `SELECT r.id, r.code, r.name
       FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id
       WHERE ur.user_id = ? ORDER BY r.id`,
    )
    .all(userId) as AuthUser['roles'];

  const permissionRows = db
    .prepare(
      `SELECT DISTINCT p.code
       FROM sys_user_role ur
       JOIN sys_role_permission rp ON rp.role_id = ur.role_id
       JOIN sys_permission p ON p.id = rp.permission_id
       WHERE ur.user_id = ? ORDER BY p.code`,
    )
    .all(userId) as { code: string }[];

  return {
    id: row.id,
    name: row.name,
    mobile: row.mobile,
    email: row.email,
    avatarUrl: row.avatar_url,
    lastLoginAt: row.last_login_at,
    roles,
    permissions: permissionRows.map((item) => item.code),
  };
}

/** 钉钉扫码登录：按 unionId 建号，已存在的沿用原记录与角色 */
export function upsertDingtalkUser(profile: DingtalkProfile): number {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM sys_user WHERE dingtalk_union_id = ?')
    .get(profile.unionId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE sys_user
       SET name = ?, mobile = COALESCE(?, mobile), email = COALESCE(?, email),
           avatar_url = COALESCE(?, avatar_url), last_login_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(profile.nick, profile.mobile, profile.email, profile.avatarUrl, now, now, existing.id);
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO sys_user
         (dingtalk_union_id, dingtalk_user_id, name, mobile, email, avatar_url, is_active, last_login_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      profile.unionId,
      profile.openId || null,
      profile.nick,
      profile.mobile,
      profile.email,
      profile.avatarUrl,
      now,
      now,
      now,
    );
  return Number(info.lastInsertRowid);
}

/** 本地开发通道：仅 AUTH_PROVIDER=mock 时可用，首次登录自动授予系统管理员 */
export function ensureMockUser(name: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const mockId = `mock:${name}`;

  const run = db.transaction((): number => {
    const existing = db
      .prepare('SELECT id FROM sys_user WHERE dingtalk_user_id = ?')
      .get(mockId) as { id: number } | undefined;

    let userId: number;
    if (existing) {
      db.prepare('UPDATE sys_user SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        existing.id,
      );
      userId = existing.id;
    } else {
      const info = db
        .prepare(
          `INSERT INTO sys_user (dingtalk_user_id, name, is_active, last_login_at, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(mockId, name, now, now, now);
      userId = Number(info.lastInsertRowid);
    }

    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM sys_user_role WHERE user_id = ?')
      .get(userId) as { count: number };
    if (count === 0) {
      db.prepare(
        'INSERT INTO sys_user_role (user_id, role_id) SELECT ?, id FROM sys_role WHERE code = ?',
      ).run(userId, 'sys_admin');
    }
    return userId;
  });

  return run();
}