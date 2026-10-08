/**
 * 展示层格式化。数量按最小单位整数存储、金额按「分」整数存储，
 * 除法只在此处发生，业务层与接口层不做换算。
 */
function group(value: number, precision: number): string {
  return (value / 10 ** precision).toLocaleString('zh-CN', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

/** 数量：按物料的小数位还原，千分位分组；缺省显示 — */
export function formatQty(value: number | null | undefined, precision: number): string {
  if (value === null || value === undefined) return '—';
  return group(value, precision);
}

/** 金额：分 → 元，固定两位小数 */
export function formatAmount(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return group(cents, 2);
}