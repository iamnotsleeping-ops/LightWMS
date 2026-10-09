/**
 * 业务时区换算（固定 UTC+8）。
 *
 * 背景：业务日期列（`order_date` / `promised_date` / `due_date`）是**人填的日期**，
 * 而 `occurred_at` / `created_at` 等时间戳以 UTC ISO 落库（`toISOString()`）。
 * 若两者都按 UTC 取「日」，在 UTC+8 部署下会于本地 00:00–08:00 之间整体错位一天：
 * 例如本地 3 月 15 日凌晨 2 点的操作，其 UTC 时间戳落在 3 月 14 日，会被算进前一天；
 * 报表的「本月 1 日 ~ 今日」默认区间与看板 30 天趋势同样会偏移。
 *
 * 本模块是所有「日」换算的唯一入口：
 *   - 取业务日：`businessToday()` / `businessDateOf(instant)`
 *   - 业务日边界 → UTC ISO 时间戳（可直接与库中 `occurred_at` 做字符串比较，
 *     因为产出统一是 `...Z` 形式，避免与 `+08:00` 混排导致字典序失真）
 *   - SQLite 侧换算见 `SQLITE_BUSINESS_DAY`（`date(occurred_at, '+8 hours')`）
 */

export const BUSINESS_TIMEZONE = 'UTC+8';

const OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 可直接嵌入 SQLite 表达式的业务日换算片段（与 OFFSET_MS 保持一致） */
export const SQLITE_BUSINESS_DAY = "date(occurred_at, '+8 hours')";

/** 当前业务日（YYYY-MM-DD，UTC+8） */
export function businessToday(): string {
  return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 10);
}

/** 把 UTC ISO 时间戳换算为它所属的业务日（YYYY-MM-DD，UTC+8） */
export function businessDateOf(instant: string): string {
  return new Date(new Date(instant).getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** 业务日的起点（本地 00:00:00.000）对应的 UTC 时间戳 */
export function businessDayStart(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - OFFSET_MS).toISOString();
}

/** 业务日的终点（本地 23:59:59.999）对应的 UTC 时间戳 */
export function businessDayEnd(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS - OFFSET_MS - 1).toISOString();
}

/** 业务日加减天数（只做纯日期运算，不涉及时区） */
export function addBusinessDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 从某个业务日往前数 count 天的连续日期列表（含 endsWith 当天，升序） */
export function businessDateRange(endsWith: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    addBusinessDays(endsWith, index - (count - 1)),
  );
}
