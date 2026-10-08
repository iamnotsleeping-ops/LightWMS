import { config } from '../../config/index';

const USER_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const CONTACT_ME_URL = 'https://api.dingtalk.com/v1.0/contact/users/me';

export interface DingtalkProfile {
  unionId: string;
  openId: string;
  nick: string;
  avatarUrl: string | null;
  mobile: string | null;
  email: string | null;
}

/** 扫码登录：redirect_uri 必须与开发者后台登记的回调域名完全一致 */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    redirect_uri: config.dingtalk.redirectUri,
    response_type: 'code',
    client_id: config.dingtalk.appKey,
    scope: 'openid',
    state,
    prompt: 'consent',
  });
  return `https://login.dingtalk.com/oauth2/auth?${params.toString()}`;
}

export async function exchangeUserToken(authCode: string): Promise<string> {
  const res = await fetch(USER_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: config.dingtalk.appKey,
      clientSecret: config.dingtalk.appSecret,
      code: authCode,
      grantType: 'authorization_code',
    }),
  });
  const body = (await res.json()) as { accessToken?: string; message?: string };
  if (!res.ok || !body.accessToken) {
    throw new Error(`钉钉换取用户凭证失败：${body.message ?? `HTTP ${res.status}`}`);
  }
  return body.accessToken;
}

export async function fetchProfile(userAccessToken: string): Promise<DingtalkProfile> {
  const res = await fetch(CONTACT_ME_URL, {
    headers: { 'x-acs-dingtalk-access-token': userAccessToken },
  });
  const body = (await res.json()) as Partial<DingtalkProfile> & { message?: string };
  if (!res.ok || !body.unionId) {
    throw new Error(`钉钉获取用户信息失败：${body.message ?? `HTTP ${res.status}`}`);
  }
  return {
    unionId: body.unionId,
    openId: body.openId ?? '',
    nick: body.nick ?? '钉钉用户',
    avatarUrl: body.avatarUrl ?? null,
    mobile: body.mobile ?? null,
    email: body.email ?? null,
  };
}