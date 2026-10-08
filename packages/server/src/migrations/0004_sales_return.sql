-- ============================================================
-- 0004_sales_return.sql · 销售退货表头 + 表体
-- 退货以「已出库的销售单行」为源，创建即过账（无草稿态）
-- 可退量 = 该销售单行的 shipped_qty − 该行已退货量（后者实时汇总，不落字段）
-- ============================================================

CREATE TABLE sales_return (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no    TEXT NOT NULL UNIQUE,
  order_id     INTEGER NOT NULL REFERENCES sales_order (id),
  customer_id  INTEGER NOT NULL REFERENCES partner (id),
  return_date  TEXT NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  remark       TEXT,
  created_by   INTEGER REFERENCES sys_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_sr_order ON sales_return (order_id);
CREATE INDEX idx_sr_customer ON sales_return (customer_id);
CREATE INDEX idx_sr_date ON sales_return (return_date);

CREATE TABLE sales_return_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id     INTEGER NOT NULL REFERENCES sales_return (id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES sales_order_item (id),
  line_no       INTEGER NOT NULL CHECK (line_no > 0),
  product_id    INTEGER NOT NULL REFERENCES item (id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouse (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost     INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (return_id, line_no)
);
CREATE INDEX idx_sri_return ON sales_return_item (return_id);
CREATE INDEX idx_sri_order_item ON sales_return_item (order_item_id);
CREATE INDEX idx_sri_product ON sales_return_item (product_id);