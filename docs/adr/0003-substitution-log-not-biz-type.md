# 替代语义记入独立日志表，不新增 `stock_transaction.biz_type` 取值

替代出库在库存账本里仍是一笔普通的 `sale_out`（数量、成本、仓库都正确），
「这是一笔替代」的语义另记在 `item_substitute_log`。

原因是 `stock_transaction.biz_type` 是 `CHECK (biz_type IN (...))` 枚举，而
**SQLite 无法用 `ALTER TABLE` 修改 CHECK 约束**（本项目 `0005` 迁移已记录同一结论），
要新增取值只能重建这张表——它是只增不改的核心账本，还带若干索引并被余额推导依赖，
重建的代价与风险都不可接受。

代价：想只查「替代出库流水」需要 join 日志表。换来的是账本口径、`as_of` 历史重算、
「余额 = 流水净额」不变量、以及所有既有报表**零改动**。日志表另带
`(sub_item_id, created_at)` 索引，同时支撑呆滞统计。

## Consequences

- 替代的库存影响与普通出入库在账本上不可区分，追溯必须走 `item_substitute_log`。
- 未来若确实需要账本级的 `biz_type` 区分，需要一次专门的重建表迁移（并同步重建索引与不变量校验）。
