/**
 * 采购提前期「整单口径」公用工具。
 *
 * 两种口径并存：
 *   · **整单口径**（receipts / order_agg）：按 biz_id（单据）取 MIN/MAX occurred_at —— 存量数据的唯一选择。
 *   · **行级口径**（line_receipts，迁移 0010 起）：按 biz_line_id（单据行）聚合 —— 仅采购入库写入，
 *     存量行与其它业务类型为 NULL，故对外行级字段可空。
 * P7（对外接口）与 P8（报表）共用本模块。
 */

/** 实际到货时刻（按采购单 biz_id 汇总）+ 该单最晚承诺日期 */
export const RECEIPT_CTE = `
  WITH receipts AS (
    SELECT biz_id AS order_id, MIN(occurred_at) AS first_received_at, MAX(occurred_at) AS last_received_at
      FROM stock_transaction
     WHERE biz_type = 'purchase_in' AND biz_id IS NOT NULL
     GROUP BY biz_id
  ),
  order_agg AS (
    SELECT order_id, MAX(promised_date) AS max_promised_date
      FROM purchase_order_item GROUP BY order_id
  ),
  line_receipts AS (
    SELECT biz_line_id,
           MIN(occurred_at) AS line_first_received_at,
           MAX(occurred_at) AS line_last_received_at
      FROM stock_transaction
     WHERE biz_type = 'purchase_in' AND biz_line_id IS NOT NULL
     GROUP BY biz_line_id
  )`;

/** 取 YYYY-MM-DD / ISO 的日期部分，转 UTC 毫秒 */
export function parseDay(value: string): number {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** 两个日期（YYYY-MM-DD 或 ISO）之间的整天数 */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / 86_400_000);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 2);
}