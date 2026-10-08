import { randomUUID } from 'node:crypto';
import type { AuthUser, MockLoginBody } from '@light-erp/shared';
import { mockLoginBodySchema } from '@light-erp/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config/index';
import { ApiError, ok } from '../../lib/response';
import { ensureMockUser, loadUserAuthInfo, upsertDingtalkUser } from './auth.service';
import { buildAuthorizeUrl, exchangeUserToken, fetchProfile } from './dingtalk.client';

/** 一次性 state 防重放，10 分钟有效 */
const issuedStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState(): string {
  const now = Date.now();
  for (const [key, issuedAt] of issuedStates) {
    if (now - issuedAt > STATE_TTL_MS) issuedStates.delete(key);
  }
  const state = randomUUID();
  issuedStates.set(state, now);
  return state;
}

function consumeState(state: string | undefined): boolean {
  if (!state) return false;
  const issuedAt = issuedStates.get(state);
  if (issuedAt === undefined) return false;
  issuedStates.delete(state);
  return Date.now() - issuedAt <= STATE_TTL_MS;
}

function signToken(app: FastifyInstance, user: AuthUser): string {
  return app.jwt.sign({
    sub: user.id,
    name: user.name,
    roles: user.roles.map((role) => role.code),
    permissions: user.permissions,
  });
}

function failRedirect(reply: FastifyReply, message: string): FastifyReply {
  return reply.redirect(
    `${config.webOrigin}/auth/callback?error=${encodeURIComponent(message)}`,
  );
}

async function handleCallback(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const query = request.query as { authCode?: string; code?: string; state?: string };

  if (!consumeState(query.state)) {
    return failRedirect(reply, '登录请求已失效，请重新发起');
  }

  const authCode = query.authCode ?? query.code;
  if (!authCode) {
    return failRedirect(reply, '缺少授权码');
  }

  try {
    const profile = await fetchProfile(await exchangeUserToken(authCode));
    const user = loadUserAuthInfo(upsertDingtalkUser(profile));
    if (!user) throw new ApiError(403, '账号已停用，请联系管理员');
    if (user.roles.length === 0) throw new ApiError(403, '未授权，请联系管理员分配角色');
    return reply.redirect(
      `${config.webOrigin}/auth/callback?token=${encodeURIComponent(signToken(app, user))}`,
    );
  } catch (error) {
    app.log.warn({ err: error }, '钉钉登录失败');
    return failRedirect(reply, error instanceof Error ? error.message : '登录失败');
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/config', async () => ok({ provider: config.auth.provider }));

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (request) => {
    const user = loadUserAuthInfo(request.user.sub);
    if (!user) throw new ApiError(401, '账号不存在或已停用');
    return ok(user);
  });

  app.post('/api/auth/logout', async () => ok({ loggedOut: true }));

  if (config.auth.provider === 'dingtalk') {
    app.get('/api/auth/dingtalk/url', async () =>
      ok({ url: buildAuthorizeUrl(issueState()) }),
    );
    app.get('/api/auth/dingtalk/callback', async (request, reply) =>
      handleCallback(app, request, reply),
    );
    return;
  }

  app.post('/api/auth/mock-login', async (request) => {
    const body = mockLoginBodySchema.parse(request.body ?? {}) as MockLoginBody;
    const user = loadUserAuthInfo(ensureMockUser(body.name));
    if (!user) throw new ApiError(403, '账号不可用');
    return ok({ token: signToken(app, user), user });
  });
}