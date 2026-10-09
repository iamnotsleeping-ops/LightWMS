-- ============================================================
-- 0006_stock_invariants.sql · 单据执行量的数据库层兜底
--
-- 背景：SQLite 无法用 ALTER TABLE 追加 CHECK 约束；而 purchase_order_item /
-- sales_order_item 还被 purchase_return_item / sales_return_item 的
-- order_item_id 外键引用，重建表的代价与风险都高。因此用触发器实现同等约束，
-- 作为「应用层已预检」之外的最后一道防线。
--
-- 约束（均为单调不变量，无合法例外）：
--   received_qty + cancelled_qty <= quantity         采购行已执行量不得超过订单量
--   shipped_qty  + cancelled_qty <= quantity         销售行已执行量不得超过订单量
--   transfer_order_item.shipped_qty <= quantity      调拨发货量不得超过订单量
--   transfer_order_item.received_qty <= shipped_qty  调拨收货量不得超过已发量
--
-- 为什么这里**没有** stock_balance.quantity >= 0：
--   余额是按「写入顺序」累加的运行值，而库存时点口径（as_of）一律按 occurred_at 从
--   stock_transaction 重算，二者刻意解耦——系统明确支持补录早于既有流水的历史单据
--   （见 stock.query.test.ts「as_of 历史时点 › 故意乱序写入：先出库后入库」）。
--   此时当前余额可以合法地为负，因此它是「业务时点的派生结果」而非数据库不变量；
--   非负性由各单据入口按业务意图预检，不能下沉为表级约束（否则要禁掉倒挂补录）。
-- ============================================================

CREATE TRIGGER trg_purchase_item_exec_qty_insert
BEFORE INSERT ON purchase_order_item
WHEN NEW.received_qty < 0
  OR NEW.cancelled_qty < 0
  OR NEW.received_qty + NEW.cancelled_qty > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, '采购订单行已执行量不得超过订单量');
END;

CREATE TRIGGER trg_purchase_item_exec_qty_update
BEFORE UPDATE ON purchase_order_item
WHEN NEW.received_qty < 0
  OR NEW.cancelled_qty < 0
  OR NEW.received_qty + NEW.cancelled_qty > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, '采购订单行已执行量不得超过订单量');
END;

CREATE TRIGGER trg_sales_item_exec_qty_insert
BEFORE INSERT ON sales_order_item
WHEN NEW.shipped_qty < 0
  OR NEW.cancelled_qty < 0
  OR NEW.shipped_qty + NEW.cancelled_qty > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, '销售订单行已执行量不得超过订单量');
END;

CREATE TRIGGER trg_sales_item_exec_qty_update
BEFORE UPDATE ON sales_order_item
WHEN NEW.shipped_qty < 0
  OR NEW.cancelled_qty < 0
  OR NEW.shipped_qty + NEW.cancelled_qty > NEW.quantity
BEGIN
  SELECT RAISE(ABORT, '销售订单行已执行量不得超过订单量');
END;

CREATE TRIGGER trg_transfer_item_exec_qty_insert
BEFORE INSERT ON transfer_order_item
WHEN NEW.shipped_qty < 0
  OR NEW.received_qty < 0
  OR NEW.shipped_qty > NEW.quantity
  OR NEW.received_qty > NEW.shipped_qty
BEGIN
  SELECT RAISE(ABORT, '调拨订单行执行量不合法（需满足 received_qty <= shipped_qty <= quantity）');
END;

CREATE TRIGGER trg_transfer_item_exec_qty_update
BEFORE UPDATE ON transfer_order_item
WHEN NEW.shipped_qty < 0
  OR NEW.received_qty < 0
  OR NEW.shipped_qty > NEW.quantity
  OR NEW.received_qty > NEW.shipped_qty
BEGIN
  SELECT RAISE(ABORT, '调拨订单行执行量不合法（需满足 received_qty <= shipped_qty <= quantity）');
END;
