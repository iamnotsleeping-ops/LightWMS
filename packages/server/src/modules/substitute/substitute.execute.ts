import type { Db } from '../../db/connection';

/**
 * 替代执行追溯（P10）。
 *
 * 为什么需要独立的日志表而不是扩展 `stock_transaction`：
 *   `stock_transaction.biz_type` 是 CHECK 枚举，SQLite 无法 ALTER 修改该约束，
 *   而该表是不可变核心账本、重建成本与风险都不可接受。因此替代出库在账本里
 *   仍是一笔普通的 `sale_out`（数量/成本/仓都正确），
 *   「这是一笔替代」的语义记入本表，既保证账本口径零改动，又保留完整可追溯链路。
 *
 * 只增不改：与 `stock_transaction` 同等纪律。
 */
export interface SubstitutionLogInput {
  bizType: 'sales_out' | 'purchase_in' | 'plan';
  bizId?: number | null;
  bizNo?: string | null;
  /** 销售订单行 id（可空） */
  orderItemId?: number | null;
  warehouseId: number;
  /** 销售场景记录客户，支撑客户维度追溯 */
  customerId?: number | null;
  mainItemId: number;
  mainNeedQty: number;
  mainActualQty: number;
  subItemId: number;
  subActualQty: number;
  ratioNum: number;
  ratioDen: number;
  reason?: string | null;
  operatorId?: number | null;
  createdAt: string;
}

export function writeSubstitutionLog(db: Db, input: SubstitutionLogInput): number {
  const info = db
    .prepare(
      `INSERT INTO item_substitute_log
         (biz_type, biz_id, biz_no, order_item_id, warehouse_id, customer_id,
          main_item_id, main_need_qty, main_actual_qty,
          sub_item_id, sub_actual_qty, ratio_num, ratio_den,
          reason, operator_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.bizType,
      input.bizId ?? null,
      input.bizNo ?? null,
      input.orderItemId ?? null,
      input.warehouseId,
      input.customerId ?? null,
      input.mainItemId,
      input.mainNeedQty,
      input.mainActualQty,
      input.subItemId,
      input.subActualQty,
      input.ratioNum,
      input.ratioDen,
      input.reason ?? null,
      input.operatorId ?? null,
      input.createdAt,
    );
  return Number(info.lastInsertRowid);
}

export interface SubstitutionLogRow {
  id: number;
  biz_type: string;
  biz_id: number | null;
  biz_no: string | null;
  order_item_id: number | null;
  warehouse_id: number;
  warehouse_name: string;
  customer_id: number | null;
  main_item_code: string;
  main_need_qty: number;
  main_actual_qty: number;
  sub_item_code: string;
  sub_actual_qty: number;
  ratio_num: number;
  ratio_den: number;
  reason: string | null;
  operator_id: number | null;
  created_at: string;
}

/** 追溯查询：按单据或按物料维度查替代记录（内部页面/报表用） */
export function listSubstitutionLogs(
  db: Db,
  filter: { bizType?: string; bizId?: number; subItemId?: number; mainItemId?: number; limit?: number },
): SubstitutionLogRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.bizType) {
    where.push('l.biz_type = ?');
    params.push(filter.bizType);
  }
  if (filter.bizId !== undefined) {
    where.push('l.biz_id = ?');
    params.push(filter.bizId);
  }
  if (filter.mainItemId !== undefined) {
    where.push('l.main_item_id = ?');
    params.push(filter.mainItemId);
  }
  if (filter.subItemId !== undefined) {
    where.push('l.sub_item_id = ?');
    params.push(filter.subItemId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT l.id, l.biz_type, l.biz_id, l.biz_no, l.order_item_id, l.warehouse_id,
              w.name AS warehouse_name, l.customer_id,
              mi.code AS main_item_code, l.main_need_qty, l.main_actual_qty,
              si.code AS sub_item_code, l.sub_actual_qty, l.ratio_num, l.ratio_den,
              l.reason, l.operator_id, l.created_at
         FROM item_substitute_log l
         JOIN item mi ON mi.id = l.main_item_id
         JOIN item si ON si.id = l.sub_item_id
         JOIN warehouse w ON w.id = l.warehouse_id
         ${clause}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ?`,
    )
    .all(...params, filter.limit ?? 200) as SubstitutionLogRow[];
}
