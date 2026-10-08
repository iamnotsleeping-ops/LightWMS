-- ============================================================
-- 0001_init.sql · 轻量级进销存系统 初始 Schema
-- 约定：
--   金额 = 分（整数）
--   数量 = 最小单位（整数）
--   日期 = TEXT 'YYYY-MM-DD'
--   时点 = TEXT ISO 8601
-- 注：schema_migration 由迁移框架自行维护，不在此文件内
-- ============================================================

-- ------------------------------------------------------------
-- A. 系统 / 权限
-- ------------------------------------------------------------
CREATE TABLE sys_user (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  dingtalk_user_id  TEXT UNIQUE,
  dingtalk_union_id TEXT UNIQUE,
  name              TEXT NOT NULL,
  mobile            TEXT,
  email             TEXT,
  avatar_url        TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_login_at     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE sys_role (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE sys_permission (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  module TEXT NOT NULL
);

CREATE TABLE sys_user_role (
  user_id INTEGER NOT NULL REFERENCES sys_user (id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES sys_role (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sys_role_permission (
  role_id       INTEGER NOT NULL REFERENCES sys_role (id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES sys_permission (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE sys_param (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE sys_holiday (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT NOT NULL UNIQUE,
  name         TEXT,
  kind         TEXT NOT NULL DEFAULT 'holiday' CHECK (kind IN ('holiday', 'workday'))
);

-- ------------------------------------------------------------
-- B. 基础资料层（只被引用，不被业务改写）
-- ------------------------------------------------------------
CREATE TABLE item_category (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE,
  name           TEXT NOT NULL,
  capacity_group TEXT,
  parent_id      INTEGER REFERENCES item_category (id),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_item_category_parent ON item_category (parent_id);

CREATE TABLE item (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  base_unit           TEXT NOT NULL,
  category_id         INTEGER REFERENCES item_category (id),
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  qty_precision       INTEGER NOT NULL DEFAULT 0,
  inspection_required INTEGER NOT NULL DEFAULT 0 CHECK (inspection_required IN (0, 1)),
  batch_managed       INTEGER NOT NULL DEFAULT 0 CHECK (batch_managed IN (0, 1)),
  serial_managed      INTEGER NOT NULL DEFAULT 0 CHECK (serial_managed IN (0, 1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_item_category ON item (category_id);
CREATE INDEX idx_item_active ON item (is_active);

CREATE TABLE partner (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('customer', 'supplier', 'both')),
  contact    TEXT,
  phone      TEXT,
  address    TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_partner_type ON partner (type);

-- 「需客户认证的客户」一对多关联，禁止在 item 上用逗号拼接
CREATE TABLE item_customer_certification (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES item (id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES partner (id),
  certified_at TEXT NOT NULL,
  expire_at    TEXT,
  UNIQUE (item_id, customer_id)
);
CREATE INDEX idx_icc_customer ON item_customer_certification (customer_id);

CREATE TABLE warehouse (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'warehouse' CHECK (type IN ('plant', 'warehouse', 'port')),
  parent_id  INTEGER REFERENCES warehouse (id),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_warehouse_type ON warehouse (type);
CREATE INDEX idx_warehouse_parent ON warehouse (parent_id);

CREATE TABLE bom (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_item_id INTEGER NOT NULL REFERENCES item (id),
  child_item_id  INTEGER NOT NULL REFERENCES item (id),
  qty_per        INTEGER NOT NULL CHECK (qty_per > 0),
  scrap_rate     REAL NOT NULL DEFAULT 0,
  effective_from TEXT,
  effective_to   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);
-- SQLite 的 UNIQUE 视 NULL 互不相等，用表达式索引保证「空生效日」同样唯一
CREATE UNIQUE INDEX uq_bom_version
  ON bom (parent_item_id, child_item_id, COALESCE(effective_from, '0000-01-01'));
CREATE INDEX idx_bom_parent ON bom (parent_item_id, effective_from, effective_to);
CREATE INDEX idx_bom_child ON bom (child_item_id);

-- ------------------------------------------------------------
-- C. 单号序列：按「单据类型 + 日期」原子自增
-- ------------------------------------------------------------
CREATE TABLE doc_sequence (
  doc_type TEXT NOT NULL,
  biz_date TEXT NOT NULL,
  next_no  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_type, biz_date)
);

-- ------------------------------------------------------------
-- D. 业务单据层（表头 + 表体）
-- ------------------------------------------------------------
CREATE TABLE purchase_order (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT NOT NULL UNIQUE,
  supplier_id  INTEGER NOT NULL REFERENCES partner (id),
  order_date   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'confirmed', 'partial', 'received', 'cancelled')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  remark       TEXT,
  created_by   INTEGER REFERENCES sys_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_po_status ON purchase_order (status);
CREATE INDEX idx_po_supplier ON purchase_order (supplier_id);
CREATE INDEX idx_po_date ON purchase_order (order_date);

CREATE TABLE purchase_order_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES purchase_order (id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL CHECK (line_no > 0),
  product_id    INTEGER NOT NULL REFERENCES item (id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouse (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  received_qty  INTEGER NOT NULL DEFAULT 0,
  cancelled_qty INTEGER NOT NULL DEFAULT 0,
  promised_date TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (order_id, line_no)
);
CREATE INDEX idx_poi_product ON purchase_order_item (product_id);
CREATE INDEX idx_poi_warehouse ON purchase_order_item (warehouse_id);
CREATE INDEX idx_poi_promised ON purchase_order_item (promised_date);

CREATE TABLE sales_order (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES partner (id),
  order_date   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'confirmed', 'partial', 'shipped', 'cancelled')),
  total_amount INTEGER NOT NULL DEFAULT 0,
  remark       TEXT,
  created_by   INTEGER REFERENCES sys_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_so_status ON sales_order (status);
CREATE INDEX idx_so_customer ON sales_order (customer_id);
CREATE INDEX idx_so_date ON sales_order (order_date);

CREATE TABLE sales_order_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES sales_order (id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL CHECK (line_no > 0),
  product_id    INTEGER NOT NULL REFERENCES item (id),
  warehouse_id  INTEGER NOT NULL REFERENCES warehouse (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  unit_price    INTEGER NOT NULL DEFAULT 0,
  amount        INTEGER NOT NULL DEFAULT 0,
  shipped_qty   INTEGER NOT NULL DEFAULT 0,
  cancelled_qty INTEGER NOT NULL DEFAULT 0,
  due_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (order_id, line_no)
);
CREATE INDEX idx_soi_product ON sales_order_item (product_id);
CREATE INDEX idx_soi_warehouse ON sales_order_item (warehouse_id);
CREATE INDEX idx_soi_due ON sales_order_item (due_date);

CREATE TABLE transfer_order (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no          TEXT NOT NULL UNIQUE,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouse (id),
  to_warehouse_id   INTEGER NOT NULL REFERENCES warehouse (id),
  order_date        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'confirmed', 'shipped', 'received', 'cancelled')),
  remark            TEXT,
  created_by        INTEGER REFERENCES sys_user (id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (from_warehouse_id <> to_warehouse_id)
);
CREATE INDEX idx_tr_status ON transfer_order (status);
CREATE INDEX idx_tr_from ON transfer_order (from_warehouse_id);
CREATE INDEX idx_tr_to ON transfer_order (to_warehouse_id);

CREATE TABLE transfer_order_item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES transfer_order (id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL CHECK (line_no > 0),
  product_id    INTEGER NOT NULL REFERENCES item (id),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  shipped_qty   INTEGER NOT NULL DEFAULT 0,
  received_qty  INTEGER NOT NULL DEFAULT 0,
  cancelled_qty INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (order_id, line_no)
);
CREATE INDEX idx_tri_product ON transfer_order_item (product_id);

CREATE TABLE stocktake_order (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT NOT NULL UNIQUE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouse (id),
  order_date   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  posted_at    TEXT,
  created_by   INTEGER REFERENCES sys_user (id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_cko_status ON stocktake_order (status);

CREATE TABLE stocktake_order_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES stocktake_order (id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL CHECK (line_no > 0),
  product_id   INTEGER NOT NULL REFERENCES item (id),
  stock_status TEXT NOT NULL CHECK (stock_status IN ('available', 'frozen', 'qc')),
  book_qty     INTEGER NOT NULL DEFAULT 0,
  counted_qty  INTEGER NOT NULL DEFAULT 0,
  diff_qty     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (order_id, line_no)
);

-- ------------------------------------------------------------
-- E. 库存层：流水（只增不改） + 余额（汇总快照）
-- ------------------------------------------------------------
CREATE TABLE stock_transaction (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES item (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouse (id),
  stock_status TEXT NOT NULL CHECK (stock_status IN ('available', 'frozen', 'qc')),
  biz_type     TEXT NOT NULL CHECK (biz_type IN (
                 'purchase_in', 'sale_out', 'purchase_return', 'sale_return',
                 'transfer_out', 'transfer_in', 'adjust', 'status_change')),
  biz_id       INTEGER,
  biz_no       TEXT,
  direction    INTEGER NOT NULL CHECK (direction IN (1, -1)),
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost    INTEGER NOT NULL DEFAULT 0,
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_st_dim ON stock_transaction (product_id, warehouse_id, stock_status, occurred_at);
CREATE INDEX idx_st_biz ON stock_transaction (biz_type, biz_id);
CREATE INDEX idx_st_biz_no ON stock_transaction (biz_no);
CREATE INDEX idx_st_occurred ON stock_transaction (occurred_at);

CREATE TABLE stock_balance (
  product_id   INTEGER NOT NULL REFERENCES item (id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouse (id),
  stock_status TEXT NOT NULL CHECK (stock_status IN ('available', 'frozen', 'qc')),
  quantity     INTEGER NOT NULL DEFAULT 0,
  avg_cost     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (product_id, warehouse_id, stock_status)
);

CREATE TABLE stock_alert_rule (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL REFERENCES item (id),
  warehouse_id INTEGER REFERENCES warehouse (id),
  min_qty      INTEGER NOT NULL DEFAULT 0,
  max_qty      INTEGER,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (item_id, warehouse_id)
);

-- ------------------------------------------------------------
-- F. 支撑
-- ------------------------------------------------------------
CREATE TABLE export_task (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type   TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'done', 'failed')),
  file_path   TEXT,
  error       TEXT,
  created_by  INTEGER REFERENCES sys_user (id),
  created_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_export_status ON export_task (status);