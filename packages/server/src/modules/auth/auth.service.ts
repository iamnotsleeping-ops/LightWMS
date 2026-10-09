import type { AuthUser } from '@light-erp/shared';
import { config } from '../../config';
import { getDb } from '../../db/connection';
import { ApiError } from '../../lib/response';
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

/**
 * 本地开发通道：仅 `AUTH_PROVIDER=mock` 时可用。
 *
 * 行为由 `MOCK_AUTO_ADMIN`（默认 true）决定：
 *  - 开启（本地开发）：首次登录按姓名建号，并自动授予 `sys_admin`。
 *  - 关闭（生产上用 mock 时必须关闭）：**只允许登录已存在的账号**，
 *    既不建号也不补授任何角色。未知名一律 401。
 *
 * 为什么关闭时连"建号"也要一起关：mock 的凭据就是**账号名本身**。
 * 若只关掉自动授权而保留建号，陌生人仍会得到一个无角色账号（无害但会脏数据）；
 * 更关键的是，只要库里还存在可猜名字的管理员账号（如「验收员」），
 * 他直接填那个名字就能登录成管理员。因此生产上除关闭本开关外，
 * **还必须把既有管理员账号换成不可猜的名字**，见 `config.allowInsecureAuth` 的启动告警。
 */
export function ensureMockUser(name: string, autoAdminOverride?: boolean): number {
  const db = getDb();
  const now = new Date().toISOString();
  const mockId = `mock:${name}`;
  const autoAdmin = autoAdminOverride ?? config.auth.mockAutoAdmin;

  const run = db.transaction((): number => {
    const existing = db
      .prepare('SELECT id, is_active FROM sys_user WHERE dingtalk_user_id = ?')
      .get(mockId) as { id: number; is_active: number } | undefined;

    if (!existing) {
      if (!autoAdmin) {
        throw new ApiError(401, 'mock 通道未开启自助建号，请使用已存在的账号名登录');
      }
      const info = db
        .prepare(
          `INSERT INTO sys_user (dingtalk_user_id, name, is_active, last_login_at, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(mockId, name, now, now, now);
      const created = Number(info.lastInsertRowid);
      db.prepare(
        'INSERT INTO sys_user_role (user_id, role_id) SELECT ?, id FROM sys_role WHERE code = ?',
      ).run(created, 'sys_admin');
      return created;
    }

    if (existing.is_active !== 1) throw new ApiError(403, '账号已停用');

    db.prepare('UPDATE sys_user SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
      now,
      now,
      existing.id,
    );

    if (autoAdmin) {
      const { count } = db
        .prepare('SELECT COUNT(*) AS count FROM sys_user_role WHERE user_id = ?')
        .get(existing.id) as { count: number };
      if (count === 0) {
        db.prepare(
          'INSERT INTO sys_user_role (user_id, role_id) SELECT ?, id FROM sys_role WHERE code = ?',
        ).run(existing.id, 'sys_admin');
      }
    }

    return existing.id;
  });

  return run();
}