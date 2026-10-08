import type { FastifyReply } from 'fastify';

/** Excel 中文兼容：UTF-8 BOM */
const BOM = '\uFEFF';

type Row = Record<string, unknown>;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 列名取首行键序（SELECT / 映射顺序即业务列序）；空集只输出 BOM */
export function toCsv(rows: Row[]): string {
  if (rows.length === 0) return BOM;
  const columns = Object.keys(rows[0]);
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCell(row[column])).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * CSV 无法承载信封，故不套信封；告警仅在存在时以 `X-Warnings`（条数）摘要传递，
 * 详细告警请改用 format=json。
 */
export function sendCsv(
  reply: FastifyReply,
  rows: Row[],
  filenameBase: string,
  warnings: string[] = [],
): FastifyReply {
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${filenameBase}-${timestamp()}.csv"`);
  if (warnings.length > 0) reply.header('x-warnings', String(warnings.length));
  return reply.send(toCsv(rows));
}