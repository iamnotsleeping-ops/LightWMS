import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index';
import { getDb } from '../db/connection';

/**
 * JWT 载荷。
 *
 * `permissions` 是**签发时的快照**，仅供前端渲染菜单 / 按钮，以及 `/api/auth/me` 回显；
 * 后端授权一律以数据库为准（见 `loadAuthState`），不信任该字段。
 */
export interface JwtPayload {
  /** sys_user.id */
  sub: number;
  name: string;
  roles: string[];
  permissions: string[];
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      code: string,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function reject(reply: FastifyReply, statusCode: number, message: string): void {
  void reply.status(statusCode).send({ code: statusCode, message, data: null, _warnings: [] });
}

/**
 * 授权前回查数据库。
 *
 * 令牌有效期默认 8h，若授权只看令牌里的 `permissions` 快照，则**停用账号或撤销角色后，
 * 旧令牌仍能继续操作满 8 小时**。这里改为每次请求以数据库为准：
 *   - `active`：账号是否仍然启用（`is_active = 1`）
 *   - `allowed`：该用户经角色当前是否真的拥有该权限码
 * 代价是每个受保护请求多一次主键 / 唯一索引查询，对单机 SQLite 部署可以接受。
 */
export interface AuthState {
  active: boolean;
  allowed: boolean;
}

export function loadAuthState(userId: number, permissionCode: string): AuthState | null {
  const db = getDb();
  const row = db.prepare('SELECT is_active FROM sys_user WHERE id = ?').get(userId) as
    | { is_active: number }
    | undefined;
  if (!row) return null;
  if (row.is_active !== 1) return { active: false, allowed: false };

  const granted = db
    .prepare(
      `SELECT 1 AS ok
         FROM sys_user_role ur
         JOIN sys_role_permission rp ON rp.role_id = ur.role_id
         JOIN sys_permission p ON p.id = rp.permission_id
        WHERE ur.user_id = ? AND p.code = ?
        LIMIT 1`,
    )
    .get(userId, permissionCode);

  return { active: true, allowed: granted !== undefined };
}

export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.jwtExpiresIn },
  });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reject(reply, 401, '未登录或登录已过期');
      return;
    }
    // 令牌本身有效也要确认账号仍然启用，否则停用用户可继续使用旧令牌
    const state = loadAuthState(request.user.sub, '');
    if (!state || !state.active) {
      reject(reply, 401, '账号不存在或已停用');
    }
  });

  app.decorate('requirePermission', (code: string) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await request.jwtVerify();
      } catch {
        reject(reply, 401, '未登录或登录已过期');
        return;
      }

      const state = loadAuthState(request.user.sub, code);
      if (!state) {
        reject(reply, 401, '账号不存在或已停用');
        return;
      }
      if (!state.active) {
        reject(reply, 401, '账号不存在或已停用');
        return;
      }
      if (!state.allowed) {
        reject(reply, 403, '无该操作权限');
      }
    };
  });
}