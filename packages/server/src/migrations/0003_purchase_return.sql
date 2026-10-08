-- ============================================================
-- 0003_purchase_return.sql · 采购退货表头 + 表体
-- 退货以「已入库的采购单行」为源，创建即过账（无草稿态）
-- 可退量 = 该采购单行的 received_qty − 该行已退货量（后者实时汇总，不落字段）
-- ============================================================

CREATE TABLE purchase_return (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no    TEXT NOT NULL UNIQUE,
  order_id     INTEGER NOT NULL REFERENCES purchase_order (id),
  supplier_id  INTEGER NOT NULL REFERENCES partner (id),
  return_date  TEXT NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  remark       TEXT,
  created_by   INTEGER REFERENCES sys_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_pr_order ON purchase_return (order_id);
CREATE INDEX idx_pr_supplier ON purchase_return (supplier_id);
CREATE INDEX idx_pr_date ON purchase_return (return_date);

CREATE TABLE purchase_return_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES purchase_return (id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES purchase_order_item (id),
  line_no       INTEGER NOT NULL CHECK (line_no > 0),
  product_id    INTEGER NOT NULL REFERENCES item (id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouse (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (return_id, line_no)
);
CREATE INDEX idx_pri_return ON purchase_return_item (return_id);
CREATE INDEX idx_pri_order_item ON purchase_return_item (order_item_id);
CREATE INDEX idx_pri_product ON purchase_return_item (product_id);