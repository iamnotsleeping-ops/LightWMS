# 轻量级进销存系统

支撑中小商家 / 工厂的采购、销售、库存日常作业，同时对外提供 7 个标准只读数据接口，供下游供应链计划与推演引擎消费。单机或局域网部署，单租户。

## 环境要求

- Node.js >= 20
- pnpm >= 10（仓库使用 `packageManager: pnpm`）

## 启动

```bash
pnpm install
pnpm dev            # 并行启动后端(3100) 与前端(5173)
```

首次启动会自动建库并执行迁移（`packages/server/data/erp.db`），无需手工建表。

其他常用命令：

```bash
pnpm migrate        # 单独执行数据库迁移
pnpm seed           # 灌入演示数据（已存在则跳过）
pnpm seed --reset   # 清空业务数据并重建演示数据（保留 sys_*）
pnpm test           # 运行单元/集成测试
pnpm typecheck      # 全仓类型检查
```

前端访问 <http://localhost:5173>，`/api` 与 `/health` 已代理到后端。

## 登录与权限

认证通道由 `.env` 的 `AUTH_PROVIDER` 决定：

| 取值 | 场景 | 行为 |
| --- | --- | --- |
| `mock` | 本地开发 | 登录页显示姓名输入框，后端按 `mock:<姓名>` 自动建号并授予 `sys_admin` |
| `dingtalk` | 服务器联调 / 生产 | 登录页显示「钉钉扫码登录」，走钉钉 OAuth2 扫码 → 回调换 token → 拉取用户信息 |

> 本地开发建议在 `.env` 中设 `AUTH_PROVIDER=mock`；若 `.env` 已是 `dingtalk`，可临时用 `AUTH_PROVIDER=mock pnpm dev` 覆盖（dotenv 不覆盖已存在的环境变量）。

钉钉扫码登录流程（`AUTH_PROVIDER=dingtalk`）：

```text
前端 GET /api/auth/dingtalk/url  →  返回钉钉授权页 URL（内含一次性 state，10 分钟有效）
     →  用户在钉钉授权页扫码
     →  钉钉回调 DINGTALK_REDIRECT_URI?authCode=&state=
     →  后端 /api/auth/dingtalk/callback 校验 state、换取 userAccessToken、拉取用户信息
     →  建号/更新用户，签发 JWT，302 回跳 ${WEB_ORIGIN}/auth/callback?token=...
```

- JWT 有效期 8h，走 `Authorization: Bearer`，前端存 `localStorage`；不做 refresh token 与登出黑名单。
- **无角色用户登录后被拒绝进入**，提示「未授权，请联系管理员分配角色」。
- 权限码格式 `模块.资源.动作`（如 `masterdata.item.create`），内置 5 个角色：`sys_admin` / `purchaser` / `salesperson` / `warehouse_keeper` / `viewer`。
- 对外 7 个只读接口（`/api/v1/*`）**不加鉴权**。

## 目录结构

```text
light-erp/
├─ packages/shared/        # 前后端共用：枚举常量、Zod schema、类型
│  └─ src/constants.ts
├─ packages/server/        # Fastify + better-sqlite3
│  └─ src/
│     ├─ config/           # 环境变量
│     ├─ db/               # 连接、迁移框架
│     ├─ migrations/       # SQL 迁移（不依赖 ORM 自动建表）
│     ├─ plugins/          # 错误处理、鉴权等 Fastify 插件
│     └─ modules/          # 业务模块：auth / system / masterdata / inventory / purchase / sales（后续阶段继续扩充）
└─ packages/web/           # Vue 3 + Vite + Element Plus
   └─ src/
      ├─ api/              # 统一请求封装（Bearer + 信封解包）
      ├─ layouts/          # 左侧导航 + 页面框架
      ├─ router/           # 路由与登录守卫
      ├─ stores/           # Pinia（auth）
      └─ views/            # 独立页面，按模块分目录
```

## 核心表关系

```text
基础资料层            业务单据层                    库存层
item_category         purchase_order          ┌  stock_transaction  流水（只增不改）
item           ──┬─→   ├ purchase_order_item  │      ↑ 写入
partner          │     sales_order           └  stock_balance      余额（汇总快照）
warehouse        │      └ sales_order_item
bom              │     transfer_order / _item
item_customer_   │     stocktake_order / _item
certification    └→    引用，不被业务改写
```

关键约束：

- 单据一律「表头 + 表体」分离，`(order_id, line_no)` 为表体业务唯一键，`line_no` 从 1 开始且保存后不可变。
- `stock_transaction` 不可变账本；`stock_balance` 是它的汇总，禁止绕过流水直接改余额。
- 任何库存变动在同一事务内按序完成：写流水 → 更新余额（含成本重算）→ 累加表体已执行量 → 推进单据状态。
- 在途是派生量，不落字段：采购在途 = 表体 `quantity − received_qty − cancelled_qty`（状态 `confirmed`/`partial`）；调拨在途 = `shipped_qty − received_qty`。
- 可用量只统计 `available` 状态；`frozen` 与 `qc` 一律不计入。
- 历史时点（`as_of`）一律从 `stock_transaction` 按 `occurred_at <= as_of` 重算，不用当前余额近似。

数量口径：

```text
on_hand    = Σ(available 的 stock_balance.quantity)
frozen     = Σ(frozen + qc 的数量)
reserved   = 已确认未出库的销售订单数量
in_transit = 采购在途 + 调拨在途
available  = on_hand - reserved                  -- 可承诺量 ATP
projected  = on_hand + in_transit - reserved     -- 预计可用（补货/缺货预警用）
```

## 对外数据接口

路径前缀 `/api/v1`，全部只读 GET，支持 `format=json|csv`，统一信封 `{ code, message, data, page?, _warnings }`。

| 编号 | 路径 | 说明 |
| --- | --- | --- |
| IF-1 | `GET /api/v1/items` | 物料主数据 |
| IF-2 | `GET /api/v1/boms?as_of=` | BOM（多版本按 `as_of` 取生效版） |
| IF-2b | `GET /api/v1/boms/{itemCode}/explode` | 多层展开（含循环检测） |
| IF-3 | `GET /api/v1/inventory?as_of=` | 库存（含历史快照） |
| IF-4 | `GET /api/v1/in-transit?as_of=` | 在途 / 采购订单 |
| IF-5 | `GET /api/v1/purchase-history` | 历史采购订单（提前期） |
| IF-5b | `GET /api/v1/suppliers/{code}/lead-time-stats` | 供应商提前期聚合 |
| IF-6 | `GET /api/v1/sales-orders` | 销售订单 |
| IF-7 | `GET /api/v1/warehouses` | 工厂 / 仓库主数据 |

### 约定

- **只读公开**：全部 GET，不挂鉴权钩子，供下游计划 / 推演引擎直接消费。
- **统一信封**：`{ code, message, data, page?, _warnings }`，`code=0` 成功；`_warnings` 为字符串数组，列举本次结果的口径近似与截断提示。
- **参数命名**：对外接口查询参数一律「蛇形命名」（`snake_case`），与内部业务接口的驼峰命名刻意区分。
- **分页**：`page` 默认 1，`page_size` 默认 100，上限 1000；分页接口在信封中带 `page`（`page/pageSize/total`）。`/boms`、`/boms/{itemCode}/explode`、`/warehouses` 不分页。
- **历史时点 `as_of`**：接受 `YYYY-MM-DD`（等价当日 00:00:00）或 ISO 8601 时间戳，缺省取服务端当日。库存一律从 `stock_transaction` 按 `occurred_at <= as_of` 重算。
- **`format=json|csv`**：缺省 `json`。`csv` 不套信封，带 UTF-8 BOM、列名取首行键序、`null` → 空串、布尔 → `true/false`、含 `,`/`"`/换行的单元格加引号；存在告警时经响应头 `X-Warnings` 返回告警条数。

### 调用示例

```bash
# 物料主数据（分页）
curl "http://localhost:3100/api/v1/items?page=1&page_size=5"

# 指定日期生效的多版本 BOM
curl "http://localhost:3100/api/v1/boms?as_of=2026-03-15"

# FG-001 按需展开 10 台（多层 + 循环检测）
curl "http://localhost:3100/api/v1/boms/FG-001/explode?qty=10"

# 历史时点库存（reserved / in_transit / available / projected 历史不可还原，返回 null 并告警）
curl "http://localhost:3100/api/v1/inventory?as_of=2026-03-15"

# 采购在途 / 历史采购（提前期）/ 供应商提前期聚合
curl "http://localhost:3100/api/v1/in-transit?status=confirmed,partial"
curl "http://localhost:3100/api/v1/purchase-history?supplier_code=SU-01"
curl "http://localhost:3100/api/v1/suppliers/SU-01/lead-time-stats"

# 销售订单 / 仓库主数据
curl "http://localhost:3100/api/v1/sales-orders?status=confirmed,partial"
curl "http://localhost:3100/api/v1/warehouses?type=warehouse"

# CSV 导出（不套信封，带 BOM；有告警看响应头 X-Warnings）
curl "http://localhost:3100/api/v1/inventory?as_of=2026-03-15&format=csv" -o inventory.csv

# OpenAPI 3.1 文档
curl "http://localhost:3100/api/v1/openapi.json"
```

系统设置 → 数据接口页面（`/system/api-docs`）内置接口清单、逐条 `curl` 示例与 OpenAPI 链接。

### 三条口径（重要）

1. **历史时点派生量**：`reserved` / `in_transit` / `available` / `projected` 由销售单、采购/调拨单派生，冷却后无法从流水还原。指定 `as_of` 时这些字段返回 `null`，并在 `_warnings` 说明；`on_hand` / `frozen` 仍按流水精确重算。
2. **在途 `as_of` 近似**：IF-4 在途按 `order_date <= as_of` 过滤（单据无「当日在途」快照），结果可能包含早于 `as_of` 已入库的行，`_warnings` 会提示。
3. **提前期为整单口径**：库存流水不含 `line_no`，实际到货时刻只能还原到整单（`biz_type='purchase_in'` 的 `MIN/MAX occurred_at`），故 `lead_time_days` 为整单提前期，行级提前期不在本阶段范围。

## 业务接口（内部，需登录 + 权限）

统一信封 `{ code, message, data, page? }`，`code=0` 为成功；分页参数 `page` / `pageSize`。

| 模块 | 方法与路径 |
| --- | --- |
| 认证 | `GET /api/auth/config`、`GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/auth/mock-login`（mock）、`GET /api/auth/dingtalk/url`、`GET /api/auth/dingtalk/callback`（dingtalk） |
| 用户 | `GET/POST /api/system/users`、`PATCH /api/system/users/:id`、`PUT /api/system/users/:id/roles` |
| 角色权限 | `GET /api/system/permissions`、`GET/POST /api/system/roles`、`PATCH/DELETE /api/system/roles/:id`、`PUT /api/system/roles/:id/permissions` |
| 物料分类 | `GET/POST /api/masterdata/categories`、`PATCH/DELETE /api/masterdata/categories/:id` |
| 物料 | `GET/POST /api/masterdata/items`、`GET/PATCH/DELETE /api/masterdata/items/:id`、`PUT /api/masterdata/items/:id/certifications` |
| 往来单位 | `GET/POST /api/masterdata/partners`、`PATCH/DELETE /api/masterdata/partners/:id` |
| 仓库 | `GET/POST /api/masterdata/warehouses`、`PATCH/DELETE /api/masterdata/warehouses/:id` |
| BOM | `GET/POST /api/masterdata/boms`（列表可带 `asOf` 只取该日生效版）、`GET /api/masterdata/boms/explode`（多层展开）、`PATCH/DELETE /api/masterdata/boms/:id` |
| 库存 | `GET /api/inventory/stocks`（六项口径 / `asOf` 历史时点 / `keyword` `productId` `warehouseId` 筛选）、`GET /api/inventory/balances`（物料×仓库三状态明细）、`GET /api/inventory/transactions`（流水，支持状态/业务类型/日期筛选）、`POST /api/inventory/status-change`（冻结/解冻/送检/质检放行） |
| 采购 | `GET/POST /api/purchase/orders`、`GET/PATCH/DELETE /api/purchase/orders/:id`、`POST /api/purchase/orders/:id/confirm`（确认）、`POST /api/purchase/orders/:id/cancel`（取消）、`POST /api/purchase/inbound`（行级入库过账）、`GET/POST /api/purchase/returns`（采购退货） |
| 销售 | `GET/POST /api/sales/orders`、`GET/PATCH/DELETE /api/sales/orders/:id`、`POST /api/sales/orders/:id/confirm`（确认）、`POST /api/sales/orders/:id/cancel`（取消）、`POST /api/sales/outbound`（行级出库过账）、`GET/POST /api/sales/returns`（销售退货） |
| 库存调拨 | `GET/POST /api/inventory/transfers`、`GET/PATCH/DELETE /api/inventory/transfers/:id`、`POST /api/inventory/transfers/:id/confirm`（确认）、`/cancel`（取消）、`/ship`（整单发货）、`/receive`（整单收货） |
| 库存盘点 | `GET/POST /api/inventory/stocktakes`、`GET/PATCH/DELETE /api/inventory/stocktakes/:id`、`POST /api/inventory/stocktakes/:id/post`（过账）、`/cancel`（取消） |
| 库存预警 | `GET/POST /api/inventory/alert-rules`、`PATCH/DELETE /api/inventory/alert-rules/:id`、`GET /api/inventory/alerts`（当前预警清单，不分页） |
| 报表 | `GET /api/reports/inventory-ledger`（进销存明细账）、`GET /api/reports/stock-snapshot`（库存现状表）、`GET /api/reports/item-movement`（商品收发明细）、`GET /api/reports/supplier-lead-time`（供应商提前期分析）；均需 `report.view`，支持 `format=csv` 同步下载 |
| 看板 | `GET /api/dashboard/overview`（登录即可，无权限码；一次返回 kpi / trend / alerts / todos 四板块） |

采购单状态机与在途口径：

```text
draft 草稿 ──确认──→ confirmed 已确认 ──入库──→ partial 部分入库 ──全部入库──→ received 已入库
   │                     │
   └──────取消───────────┴──→ cancelled 已取消
```

- 状态流转：`draft → confirmed → partial → received`；仅 `draft` / `confirmed` 可取消，无「直接改状态」接口。
- **在途是派生量，不落字段**：单行在途 = `quantity − received_qty − cancelled_qty`；整单在途仅当 `status ∈ (confirmed, partial)` 时计入。
- 采购入库为**行级直接入库**（不设独立收货单）：同一事务内校验在途量 → 写 `purchase_in` 流水 → 累加 `received_qty` → 推进单据状态；需质检的物料按 `qc` 状态入库（不计入可用量）。
- **采购退货**（migration `0003`）创建即过账，落 `purchase_return` / `purchase_return_item`；可退量 = `received_qty − 该行历史退货量`（历史退货量实时汇总，不落字段），退货不改单据状态。
- 单号由 `doc_sequence(doc_type, biz_date, next_no)` 原子自增，格式 `${prefix}-YYYYMMDD-NNNN`（采购单 `PO`、采购退货 `PR`）。

销售单状态机与预占口径：

```text
draft 草稿 ──确认──→ confirmed 已确认 ──出库──→ partial 部分出库 ──全部出库──→ shipped 已出库
   │                     │
   └──────取消───────────┴──→ cancelled 已取消
```

- 状态流转：`draft → confirmed → partial → shipped`；仅 `draft` / `confirmed` 可取消，无「直接改状态」接口。
- **预占 `reserved` 是派生量，不落字段**：单行预占 = `quantity − shipped_qty − cancelled_qty`；整单预占仅当 `status ∈ (confirmed, partial)` 时计入。出库累加 `shipped_qty` 即自动释放对应预占，库存侧无需额外动作。
- 销售出库为**行级直接出库**（不设独立发货单）：同一事务内校验未出库量 → 校验物理可用量（按 `product:warehouse` 合并请求量后比对 `available` 桶，而非净可用量 `on_hand − reserved`）→ 写 `sale_out`（`direction = -1`）流水 → 累加 `shipped_qty` → 推进单据状态。
- 出库按**当前移动加权平均成本**结转（不传 `unitCost`，由引擎按现均价计算），因此出库不改变物料均价。
- **销售退货**（migration `0004`）创建即过账，落 `sales_return` / `sales_return_item`；可退量 = `shipped_qty − 该行历史退货量`（历史退货量实时汇总，不落字段）；退货按**当前均价**入库到源仓库可用库存、不改变均价，且**不改单据状态**。
- 单号由 `doc_sequence(doc_type, biz_date, next_no)` 原子自增，格式 `${prefix}-YYYYMMDD-NNNN`（销售单 `SO`、销售退货 `SR`）。

调拨单状态机与在途口径：

```text
draft 草稿 ──确认──→ confirmed 已确认 ──发货──→ shipped 在途 ──收货──→ received 已收货
   │                     │
   └──────取消───────────┴──→ cancelled 已取消
```

- 状态流转：`draft → confirmed → shipped → received`；仅 `draft` / `confirmed` 可取消，无「直接改状态」接口。
- **整单一次性发货 / 收货**（不做部分调拨，避免与既有「调拨在途 = `shipped_qty − received_qty`」派生口径冲突）。
- 发货：同一事务内按 `product` 合并整单请求量、预检**调出仓库物理可用量**（`available` 桶）→ 逐行写 `transfer_out`（`direction = -1`，不传 `unitCost`，按调出仓当前均价结转）→ 累加 `shipped_qty` → 状态置 `shipped`。源仓均价不变。
- 收货：逐行取**调出仓当前均价**作为结转成本，写 `transfer_in`（`direction = +1`）入**调入仓**可用库存 → 累加 `received_qty` → 状态置 `received`。入库显式传均价，避免引擎 fallback 0 稀释目标仓均价。
- 单号前缀 `TR`。

盘点单状态机与过账口径：

```text
draft 草稿 ──过账──→ posted 已过账
   │
   └──取消──→ cancelled 已取消
```

- 表体行维度 = **物料 × 库存状态**（`available` / `frozen` / `qc`），仓库在表头。
- 录入时快照账面量 `book_qty` 并算 `diff_qty = counted_qty − book_qty`；仅草稿可修改/删除/过账/取消。
- **过账以实盘量对齐账面**：过账时**重读当前余额**、重算差异（消除「录入 → 过账」之间的库存漂移），盘盈写 `adjust`（`direction = +1`，显式传当前均价使均价零漂移）、盘亏写 `adjust`（`direction = -1`，按现均价结转），差异为 0 的行不产生流水；随后回写 `book_qty` / `diff_qty` 并把状态置 `posted`、记录 `posted_at`。盘亏超过账面余额直接拒绝。
- 单号前缀 `CK`。

库存预警口径：

- 规则维度 = **物料 × 范围**；`warehouse_id` 为空表示**全局规则**（按该物料所有仓库 `available` 汇总判断），非空表示仓库级规则。
- 唯一性：同物料 + 同范围仅一条规则；全局规则因 SQLite `UNIQUE` 不约束 `NULL`，由服务层「先查后写」保证。
- 判定：当前可用量 `< min_qty` → `below_min`；`max_qty` 非空且当前 `> max_qty` → `above_max`；停用（`is_active = 0`）规则不参与。
- P5 **零迁移**：所有表（`transfer_order(_item)` / `stocktake_order(_item)` / `stock_alert_rule`）与 `biz_type`（`transfer_out` / `transfer_in` / `adjust`）在 `0001` / `0002` 已就位，无新增迁移。

库存口径说明：

- `GET /api/inventory/stocks` 一次返回全部六项口径（`on_hand` / `frozen` / `reserved` / `in_transit` / `available` / `projected`），四口径切换由前端完成，避免死参数。
- 传 `asOf`（`YYYY-MM-DD` 或 ISO 8601）时从 `stock_transaction` 重算实物量，此时 `reserved` / `in_transit` / `available` / `projected` 返回 `null`（依赖单据当时状态，不可还原），响应 `_warnings` 会回显该口径说明。
- 系统参数 `port_stock_as_inventory`（默认 `false`）在 P2 生效：为 `false` 时港口仓行不出现在库存清单中，其当前取值在响应 `_warnings` 回显。

BOM 多版本与展开口径：

- **版本即生效期区间**：「某父件在日期 D 的生效 BOM」= 该父件下所有 `effective_from IS NULL OR <= D` 且 `effective_to IS NULL OR >= D` 的行；`NULL` 表示开区间（自始 / 无限期）。`as_of` 缺省取服务端当日。
- **同父件+子件生效期不得重叠**：新建 / 修改版本时服务端强校验，重叠返回 409（含同日边界，保证任一日期最多解析出一条版本）；如需切换到新版本，先把旧版本 `effective_to` 收口。
- **多层展开**（`GET /api/masterdata/boms/explode`）：DFS 递归解析每个父件在 `as_of` 的生效子件，累计需求 = `上层需求 × qty_per × (1 + scrap_rate)`；无生效 BOM 行的子件为叶子（外购件）。
- **循环检测与深度熔断**：命中循环（含自循环）则该分支不下钻、节点标记 `cyclic`、记录 `cycles` 并写入 `_warnings`；展开深度上限 32，触顶停止下钻并告警。展开为只读操作，不写任何库存 / 主数据。
- P6 **零迁移**：`bom` 表（含生效期字段、`uq_bom_version` 唯一索引与 CHECK）与权限码 `masterdata.bom.view/manage` 在 `0001` / `0002` 已就位，无新增迁移。
- 对外只读接口 `GET /api/v1/boms?as_of=` 与 `GET /api/v1/boms/{itemCode}/explode`（含 csv / OpenAPI）已在 P7 包装本阶段 service 交付。

报表与看板口径：

- **进销存明细账**（`report.view`）：按「物料 × 仓库」统计区间收发。期初 = 区间前`direction × quantity`累加，入库/出库 = 区间内 `direction = ±1` 累加，期末 = 期初 + 入库 − 出库；金额列同理用流水 `unit_cost` 结转。**必须排除 `biz_type = 'status_change'`**——状态转移在同一事务内成对写「出 + 入」，计入会让入库、出库两栏同时虚增而净额不变。日期边界：`dateFrom` 取当日 `00:00:00`、`dateTo` 归一到当日末刻；缺省区间为本月 1 日 ~ 今日（服务端当日）。
- **库存现状表**（`report.view`）：复用库存清单六项口径，追加金额列 `on_hand_amount = on_hand × avg_cost`（成本取 `stock_balance` 的「物料 × 仓库」维度 `avg_cost`）。指定 `asOf` 时历史成本不可还原，`avg_cost` / `on_hand_amount` 返回 `null` 并写入 `_warnings`（与 P7 历史口径一致）。
- **商品收发明细**（`report.view`）：逐笔流水，字段同库存流水，追加 `amount = quantity × unit_cost`。
- **供应商提前期分析**（`report.view`）：沿用 P7「整单口径」——流水无行号，实际到货时刻取该单 `biz_type='purchase_in'` 流水的 `MAX occurred_at` 还原到整单。`lead_time_days = 实际到货日 − order_date`；`promised_lead_time_days = max(promised_date) − order_date`；`on_time = 实际到货日 ≤ max(promised_date)`；`on_time_rate = 准时单数 / 已到货单数`。仅统计有到货记录的供应商。
- **首页看板**（`GET /api/dashboard/overview`，登录即可）：`kpi`（现存量 / 库存金额 / 启用物料数 / 在途量 / 预警数，遵循 `port_stock_as_inventory` 默认排除港口仓）、`trend`（近 30 个自然日逐日出入库，排除 `status_change`、无流水补 0 保证 30 点）、`alerts`（`below_min` 优先取前 10）、`todos`（采购草稿 / 待入库采购单 / 销售草稿 / 待出库销售单 / 在途调拨单计数）。
- **导出 = 同步 CSV 下载**：4 张报表均支持 `format=csv`，复用 P7 CSV 行为（UTF-8 BOM、不套信封、告警仅在存在时以 `X-Warnings`（条数）摘要传递），前端以带 `Authorization` 的 `fetch → blob` 触发浏览器下载；**不启用 `export_task` 异步任务 / 导出中心**。查询参数用内部驼峰命名（`dateFrom` / `warehouseId` / ...）。

## 实施进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | 脚手架、迁移框架、初始 schema | 已完成 |
| P1 | 基础资料 + 钉钉 SSO + 用户/角色权限 | 已完成 |
| P2 | 库存核心引擎（流水/余额/成本/状态） | 已完成 |
| P3 | 采购（采购单 + 行级入库 + 采购退货） | 已完成 |
| P4 | 销售（销售单 + 行级出库 + 销售退货） | 已完成 |
| P5 | 调拨 + 盘点 + 预警 | 已完成 |
| P6 | BOM 多版本与展开 | 已完成 |
| P7 | 对外只读接口（7 组 / 9 条）+ OpenAPI | 已完成 |
| P8 | 报表 + 看板 | 已完成 |
| P9 | 种子数据 + 验收测试 | 已完成 |

P1 已落地页面：基础资料（物料管理、物料分类、BOM 管理、往来单位、仓库/工厂管理）、系统设置（用户管理、角色权限）。
P2 增补页面：库存查询、库存状态管理、库存流水。
P3 增补页面：采购单列表、新建/编辑采购单、采购单详情（含执行进度与退货记录）、采购入库、采购退货对话框。
P4 增补页面：销售单列表、新建/编辑销售单、销售单详情（含执行进度与退货记录）、销售出库（含物理可用量校验与分批出库）。
P5 增补页面：库存调拨（列表 / 新建 / 编辑 / 详情，含确认、整单发货、整单收货、取消）、库存盘点（列表 / 新建 / 编辑 / 详情，含过账与差异高亮、账面量实时预览）、库存预警设置（当前预警清单 + 阈值规则维护）。
P6 增补页面：BOM 管理增强（生效日期筛选「只看某日生效版本」、版本列、行内「展开」入口）、BOM 展开（选父件 / 生效日期 / 数量，多层缩进树 + 累计需求 + 外购件/自制件/循环引用标记 + 告警）。
P7 增补页面：系统设置 → 数据接口（`/system/api-docs`，对外 9 条只读接口清单 + 逐条 curl 示例 + CSV 导出示例 + OpenAPI 链接，无权限码）。
P7 **零迁移**：对外接口全部包装既有 service / SQL，无新增表、索引或迁移。
P8 增补页面：首页看板（KPI 指标卡 + ECharts 近 30 天出入库双系列趋势 + 库存预警 Top 10 + 单据待办）、报表（进销存明细账、库存现状表、商品收发明细、供应商提前期分析；每页筛选 + 表格 + 分页 + 同步 CSV 导出）。
P8 **零迁移**：4 张报表与看板全部基于既有账本（`stock_transaction` / `stock_balance`）与单据表计算，`report.view` 权限码已在 `0002_rbac_seed.sql` 就位、`export_task` 表虽在 `0001_init.sql` 预留但本阶段不启用，无新增迁移。
P9 交付：独立种子脚本（`pnpm seed`）+ 端到端验收测试（`packages/server/src/test/acceptance.test.ts`，共 12 例），在空库上重建全量演示数据并逐阶段核对主数据 / 库存引擎 / 采购 / 销售 / 调拨盘点预警 / 报表 / 看板 / 对外接口。
P9 **零迁移**：种子数据不写进迁移，业务单据全部复用既有 service 生成，无新增表、索引或迁移。
后续优化：权限码统一收敛至 `packages/shared` 的 `PERMISSIONS` 常量（前端菜单/守卫与后端路由共用）；新增 `v-permission` 按钮级权限指令；写操作路由（新建 / 编辑 / 入库 / 出库）在守卫中按 manage 权限二次校验；补齐系统参数只读页（`/system/params`，权限码 `system.param.view`），菜单分组至此全部激活。

## 种子数据与验收测试

演示场景：一家小型电子产品组装厂。种子模块 [seed.ts](packages/server/src/db/seed.ts) 复用既有业务 service（库存引擎、采购/销售/退货、调拨、盘点、预警）在单事务内灌入：

- 基础资料：4 分类、9 物料、4 仓库（含港口仓）、5 往来单位、10 行 BOM（FG-1001 双版本 + SF-2001 多层）
- 库存：期初库存、`available / frozen / qc` 三桶、状态转移（WH-01 RM-3001 冻结 20、需质检物料入 qc）
- 单据：采购 4 单（全额入库 + 退货 / 部分入库 / 已确认 / 草稿）、销售 4 单（全出库 + 退货 / 部分出库 / 已确认 / 草稿）、调拨 2 单（已收货 / 在途）、盘点 1 单（盘亏 2）、预警规则 4 条

用法与幂等：

```bash
pnpm seed           # 首次灌入；已灌入过（sys_param 种子标记存在）则跳过
pnpm seed --reset   # 清空全部业务表后重建，sys_*（角色/权限/参数）保留
```

验收测试 `acceptance.test.ts` 覆盖：空库基线（业务表为空、RBAC 就位、无种子标记）→ 种子幂等与 `--reset` 重建 → 全链路只读校验（含账本只读性：查询类调用前后 `stock_transaction` / `stock_balance` 行数不变）。