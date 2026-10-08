import { DOC_TYPE_PREFIX, type DocType } from '@light-erp/shared';
import type { Db } from '../db/connection';

/**
 * 单号序列：按「单据类型 + 业务日期」原子自增，格式 `${前缀}-YYYYMMDD-NNNN`。
 * 依赖 doc_sequence(doc_type, biz_date, next_no) 主键做冲突合并，同日并发不会重号。
 */
export function nextDocNo(db: Db, docType: DocType, bizDate: string): string {
  const row = db
    .prepare(
      `INSERT INTO doc_sequence (doc_type, biz_date, next_no) VALUES (?, ?, 1)
       ON CONFLICT (doc_type, biz_date) DO UPDATE SET next_no = next_no + 1
       RETURNING next_no`,
    )
    .get(docType, bizDate) as { next_no: number };

  const day = bizDate.replace(/-/g, '');
  const seq = String(row.next_no).padStart(4, '0');
  return `${DOC_TYPE_PREFIX[docType]}-${day}-${seq}`;
}