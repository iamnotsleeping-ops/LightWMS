-- ============================================================
-- 0010_stock_transaction_biz_line_id.sql · 库存流水的**行级**归属
--
-- 背景：stock_transaction 原先只记到**单据级**（biz_id / biz_no），于是采购的
--   「实际到货时刻」只能按整单还原（该单 purchase_in 的 MIN/MAX occurred_at）。
--   下游要用它做「料号级提前期」（(due_date − 提前期) − t）——整单口径会把同一
--   张单里其它行的迟到摊到这个料号上，做不到。
--
-- 设计要点：
--   1. 新增**可空**列 `biz_line_id`：业务**单据行的 id**（采购入库即
--      `purchase_order_item.id`）。存量行一律 NULL —— **不回填、不猜**：
--      历史数据无法可靠还原"哪一行何时到货"。
--   2. **不建外键**：账本是不可变追加表，软引用更契合审计场景；单据行若被
--      清理也不应牵连账本。
--   3. 目前只有**采购入库 / 采购退货**两条写入路径会填此列（下游需要的是采购
--      行级到货）；其它业务类型（销售出库、调拨、盘点）暂为 NULL，按需扩展。
--      对外字段与语义见 IF-5 的 OpenAPI description。
--   4. 索引服务于 IF-5 的「按行聚合到货时刻」（GROUP BY biz_line_id）。
-- ============================================================

ALTER TABLE stock_transaction ADD COLUMN biz_line_id INTEGER;

CREATE INDEX idx_stock_transaction_biz_line ON stock_transaction(biz_line_id);
