/** 统一响应信封：成功 code=0，失败 code 取 HTTP 状态码 */
export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
}

export function ok<T>(data: T) {
  return { code: 0, message: 'ok', data, _warnings: [] };
}

export function okPage<T>(list: T[], info: PageInfo, warnings: string[] = []) {
  return { code: 0, message: 'ok', data: list, page: info, _warnings: warnings };
}

/** 抛出后由 error-handler 统一转换为信封响应 */
export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}