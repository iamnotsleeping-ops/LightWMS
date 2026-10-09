import { ElMessage } from 'element-plus';

const TOKEN_KEY = 'light-erp-token';

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}

export interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  page?: PageInfo;
  _warnings: unknown[];
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * 会话失效回调。
 *
 * `setToken(null)` 只清 localStorage，而 Pinia store 自己持有一份 token/用户快照，
 * 路由守卫读的是 store —— 只清 localStorage 会造成「僵尸会话」：界面仍是登录态、
 * 菜单照常显示，但所有请求持续 401。
 *
 * 这里以回调注入的方式解耦：client 不 import store（避免 client ↔ store 循环依赖），
 * 由 main.ts 在 Pinia 与 router 就绪后注册「清 store + 跳登录页」。
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function handleUnauthorized(): void {
  setToken(null);
  unauthorizedHandler?.();
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  silent?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', body, query, silent } = options;
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.code !== 0) {
    const message = payload?.message ?? `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) handleUnauthorized();
    if (!silent) ElMessage.error(message);
    throw new Error(message);
  }
  return payload;
}

export const http = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** 从 content-disposition 解析文件名：attachment; filename="xxx.csv" */
function filenameFrom(header: string | null, fallback: string): string {
  const match = header?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? fallback;
}

/**
 * 同步导出：CSV 接口需鉴权，无法用 window.open 直链，
 * 改用带 Authorization 的 fetch → blob → 触发浏览器下载。
 */
export async function download(path: string, query?: Record<string, unknown>): Promise<void> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    // 服务端同样返回统一信封，优先取其中的可读 message，而不是只报 HTTP 码
    let message = `导出失败（HTTP ${response.status}）`;
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload?.message) message = payload.message;
    } catch {
      /* 非 JSON 响应（如网关错误页）保留兜底文案 */
    }
    ElMessage.error(message);
    throw new Error(message);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filenameFrom(response.headers.get('content-disposition'), 'export.csv');
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}