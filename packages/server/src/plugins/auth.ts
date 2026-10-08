import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/index';

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
      if (!request.user.permissions.includes(code)) {
        reject(reply, 403, '无该操作权限');
      }
    };
  });
}