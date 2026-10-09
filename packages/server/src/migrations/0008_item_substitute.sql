-- ============================================================
-- 0008_item_substitute.sql · 替代料能力（P10）
--
-- 设计要点（详见 .trae/documents/P10-替代料-实施方案.md）：
--   1. 替代关系**单向**：A→B 与 B→A 是两条独立记录；匹配只取一层，不递归。
--   2. 比例用**整数分子/分母**，因为本项目全链路数量为 INTEGER
--      （CHECK (quantity > 0)、zod .int()、postMovement 强制整数），
--      附件的小数 decimal(10,3) 无法承载。
--   3. 唯一性用**索引表达式** COALESCE(...,0) 处理可空维度：
--      SQLite 中 NULL 不参与唯一性判断（stock_alert_rule 已踩过该坑），
--      用表达式一次性解决，服务层再叠一道「先查后写」。
--   4. 替代语义**不新增 stock_transaction.biz_type**（该列是 CHECK 枚举，
--      SQLite 无法 ALTER 修改，而 stock_transaction 是不可变核心账本）。
--      替代出库仍写 biz_type='sale_out'，"这是一笔替代"记入 item_substitute_log。
-- ============================================================

CREATE TABLE item_substitute (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  main_item_id    INTEGER NOT NULL REFERENCES item (id),
  sub_item_id     INTEGER NOT NULL REFERENCES item (id),
  -- 父件语境：NULL = 通用替代（不限定 BOM 上级）；非空 = 仅在该父件下可用
  parent_item_id  INTEGER REFERENCES item (id),
  -- 适用仓：NULL = 全仓通用；非空 = 仅该仓
  warehouse_id    INTEGER REFERENCES warehouse (id),
  priority        INTEGER NOT NULL DEFAULT 1 CHECK (priority > 0),
  -- 替代比例：替代料用量 = ceil(主料缺口 × ratio_num / ratio_den)
  ratio_num       INTEGER NOT NULL DEFAULT 1 CHECK (ratio_num > 0),
  ratio_den       INTEGER NOT NULL DEFAULT 1 CHECK (ratio_den > 0),
  scene           TEXT NOT NULL DEFAULT 'sales_out'
                  CHECK (scene IN ('sales_out', 'bom_plan', 'purchase_hint')),
  strategy        TEXT NOT NULL DEFAULT 'proportion'
                  CHECK (strategy IN ('proportion', 'whole_batch', 'manual')),
  -- 预留：本期只支持同仓替代，该列固定 0，跨仓逻辑不实现（见方案决策 12）
  cross_warehouse INTEGER NOT NULL DEFAULT 0 CHECK (cross_warehouse IN (0, 1)),
  effective_from  TEXT,
  effective_to    TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  remark          TEXT,
  created_by      INTEGER REFERENCES sys_user (id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (main_item_id <> sub_item_id),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX uq_item_substitute_scope
  ON item_substitute (
    main_item_id, sub_item_id, scene,
    COALESCE(parent_item_id, 0), COALESCE(warehouse_id, 0)
  );
CREATE INDEX idx_item_sub_main ON item_substitute (main_item_id, is_active);
CREATE INDEX idx_item_sub_sub ON item_substitute (sub_item_id);

-- ------------------------------------------------------------
-- 替代执行追溯日志（只增不改，纪律同 stock_transaction）
-- 同时承担「替代语义唯一落点」与「呆滞判断（最近调用时间）」两个职责
-- ------------------------------------------------------------
CREATE TABLE item_substitute_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type        TEXT NOT NULL CHECK (biz_type IN ('sales_out', 'purchase_in', 'plan')),
  biz_id          INTEGER,
  biz_no          TEXT,
  order_item_id   INTEGER,
  warehouse_id    INTEGER NOT NULL REFERENCES warehouse (id),
  customer_id     INTEGER REFERENCES partner (id),
  main_item_id    INTEGER NOT NULL REFERENCES item (id),
  main_need_qty   INTEGER NOT NULL,
  main_actual_qty INTEGER NOT NULL DEFAULT 0,
  sub_item_id     INTEGER NOT NULL REFERENCES item (id),
  sub_actual_qty  INTEGER NOT NULL DEFAULT 0,
  ratio_num       INTEGER NOT NULL DEFAULT 1,
  ratio_den       INTEGER NOT NULL DEFAULT 1,
  reason          TEXT,
  operator_id     INTEGER REFERENCES sys_user (id),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_item_sub_log_bill ON item_substitute_log (biz_type, biz_id);
CREATE INDEX idx_item_sub_log_mat ON item_substitute_log (sub_item_id, created_at);
