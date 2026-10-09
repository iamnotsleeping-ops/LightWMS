# 轻量级进销存系统

支撑中小商家 / 工厂的采购、销售、库存日常作业，同时对外提供 9 组（共 11 条）标准只读数据接口，供下游供应链计划与推演引擎消费。单机或局域网部署，单租户。

## 环境要求

- Node.js >= 22.13
- pnpm 11（仓库用 `packageManager: pnpm@11.24.0` 固定版本，pnpm 11 要求 Node >= 22.13）

> 若本机只有 Node 20/21，`pnpm` 自身无法启动被固定的版本；请先升级 Node 或改用 `corepack` 之外的包管理器手动执行 `vitest` / `tsc`（应用代码本身不依赖 Node 22 特性）。

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
- **授权以数据库为准，不信令牌里的权限快照**：每个受保护请求都会回查 `sys_user.is_active` 与该用户经角色实际持有的权限码。因此**停用账号或撤销角色后立即生效**，无需等令牌过期。（令牌里的 `permissions` 仅用于前端渲染菜单与 `/api/auth/me` 回显。）
- **生产启动自检**：`NODE_ENV=production` 时若 `AUTH_PROVIDER=mock`、或 `JWT_SECRET` 仍为默认值、或钉钉通道缺少 `APP_KEY`/`APP_SECRET`/`REDIRECT_URI`，后端**拒绝启动**并逐条列出问题。
  - 逃生开关：如确需在**可信网络内**以 mock 通道跑生产（例如内网演示），须**同时**设置两项，缺一不可：
    - `ALLOW_INSECURE_AUTH=true` —— 显式认领「用 mock 跑生产」这一风险；只设它仍会被拒启动。
    - `MOCK_AUTO_ADMIN=false` —— 关闭 mock 的**自助建号 + 自动授予 `sys_admin`**。关闭后 mock 登录**只能登录已存在的账号**，未知名一律 401，也不会给任何账号补授角色。
  - ⚠ **关闭自助建号并不等于安全**：mock 的凭据就是**账号名本身**。若库里还留着可猜名字的管理员账号（如「验收员」），陌生人直接填那个名字就能登录成管理员。因此生产上还必须把既有管理员账号改成**不可猜的名字**（建议随机长串，例如 `运维入口-9f3a7c`），并尽快切换为 `dingtalk`。启动日志会打印对应告警。
- **无角色用户登录后被拒绝进入**，提示「未授权，请联系管理员分配角色」。
- 权限码格式为 `模块.资源.动作`，动作为 `view` / `manage` / `confirm`（如 `masterdata.item.manage`；`report.view` 为两段式例外），共 38 个权限码；内置 5 个角色：`sys_admin` / `purchaser` / `salesperson` / `warehouse_keeper` / `viewer`。`sys_admin` 的权限集不可通过接口改写（新增权限码由迁移补种）。
- 角色分配有两道护栏：不允许修改**自己**的角色，不允许移除**最后一名**系统管理员。
- 替代料相关权限单独成码：`masterdata.substitute.view` / `masterdata.substitute.manage` / **`sales.outbound.substitute`**（后者与 `sales.outbound.manage` 分离，便于按角色单独收回「替代出库」能力而不影响正常出库）。
- 对外 11 条只读数据接口（`/api/v1/*`）**不加鉴权**，另有 1 个文档接口 `GET /api/v1/openapi.json`。部署时请注意：这些接口会暴露全部库存、采购单价、供应商提前期、销售订单行与替代关系，建议绑定内网地址或置于反向代理之后。

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
│     └─ modules/          # 业务模块：auth / system / masterdata / inventory / purchase / sales / substitute / report / dashboard / public-api
└─ packages/web/           # Vue 3 + Vite + Element Plus
   └─ src/
      ├─ api/              # 统一请求封装（Bearer + 信封解包）
      ├─ layouts/          # 左侧导航 + 页面框架
      ├─ router/           # 路由与登录守卫
      ├─ stores/           # Pinia（auth）
      ├─ utils/            # 格式化、确认框（confirmAction）
      └─ views/            # 独立页面，按模块分目录
```

## 核心表关系

> **逐表字段字典见 [docs/数据表字典.md](docs/数据表字典.md)**：33 张表的字段、类型、约束、索引、外键、非显然字段说明与跨表不变量，由 `pnpm --filter @light-erp/server schema-doc` 从库结构生成（不手写，故不会随迁移漂移）。本节只给全局关系与口径。

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
- **替代料**（P10）：`item_substitute` 存「主料 → 替代料」的**单向**规则（优先级 / 整数比例 / 适用仓 / 适用父件 / 场景 / 生效期）；`item_substitute_log` 是替代执行的只增追溯，也是「替代」语义在账本之外的唯一落点。
- **业务日统一按 UTC+8 划分**（`lib/time.ts` 是唯一换算入口）：业务日期由人填写、时间戳以 UTC 存储，不能直接按 UTC 取日。

数量口径（实物量三状态独立成列，`total_qty` 为三桶合计）：

```text
on_hand    = Σ(available 的数量)           -- 现有库存（仅可用桶）
frozen     = Σ(frozen 的数量)              -- 冻结（仅冻结桶）
qc         = Σ(qc 的数量)                  -- 待检（仅待检桶）
total_qty  = on_hand + frozen + qc         -- 账面物理量（三桶合计）
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
| IF-6 | `GET /api/v1/sales-orders` | 销售订单行（订单号 / 行号 / 订单日期 / 客户编码 / 物料编码 / 仓库编码 / 数量 / 已出库量 / 未出库量 / 要求交期 / 订单状态）。**未指定 `status` 时缺省只返回未结需求（`confirmed` / `partial`）**，与内部 `reserved` 口径一致；如需 `draft` / `cancelled` 须显式传入 |
| IF-7 | `GET /api/v1/warehouses` | 工厂 / 仓库主数据 |
| IF-8 | `GET /api/v1/substitutes?main_item_code=&warehouse_code=&scene=&as_of=` | 替代关系清单（按优先级，含适用仓 / 父件 / 比例 / 生效期），供下游自行净算 |
| IF-9 | `GET /api/v1/substitution-plan?main_item_code=&warehouse_code=&required_qty=&scene=&customer_code=&strategy=&manual_item_codes=&as_of=` | **给定需求直接返回替代分配建议**（分配明细 / 已覆盖 / 缺口 / 跳过原因 / 告警）。只读无副作用 |

### 约定

- **只读公开**：全部 GET，不挂鉴权钩子，供下游计划 / 推演引擎直接消费。
- **统一信封**：`{ code, message, data, page?, _warnings }`，`code=0` 成功；`_warnings` 为字符串数组，列举本次结果的口径近似与截断提示。
- **参数命名**：对外接口查询参数一律「蛇形命名」（`snake_case`），与内部业务接口的驼峰命名刻意区分。
- **分页**：`page` 默认 1，`page_size` 默认 100，上限 1000；分页接口在信封中带 `page`（`page/pageSize/total`）。`/boms`、`/boms/{itemCode}/explode`、`/warehouses` 不分页。
- **历史时点 `as_of`**：接受 `YYYY-MM-DD`（等价当日 00:00:00）或 ISO 8601 时间戳。`/boms` 缺省取服务端当日（按 UTC 取日）；`/inventory` 缺省则直接读当前余额（不走重算）。指定 `as_of` 时，库存一律从 `stock_transaction` 按 `occurred_at <= as_of` 重算。
- **`format=json|csv`**：缺省 `json`。`csv` 不套信封，带 UTF-8 BOM、列名取首行键序、`null` → 空串、布尔 → `true/false`、含 `,`/`"`/换行的单元格加引号（`"` 翻倍）；存在告警时经响应头 `X-Warnings` 返回告警条数。**对外接口的 `csv` 同样受 `page` / `page_size` 约束**（缺省只导出第 1 页 100 行），需要全量请逐页拉取或调大 `page_size`（上限 1000）。
- **内部报表的 `csv` 不受分页限制**：`/api/reports/*?format=csv` 导出的是当前筛选条件下的**全部**行（分页只作用于 JSON 浏览）。

### 调用示例

```bash
# 物料主数据（分页）
curl "http://localhost:3100/api/v1/items?page=1&page_size=5"

# 指定日期生效的多版本 BOM
curl "http://localhost:3100/api/v1/boms?as_of=2026-03-15"

# FG-1001 按需展开 10 台（多层 + 循环检测）
curl "http://localhost:3100/api/v1/boms/FG-1001/explode?qty=10"

# 历史时点库存（on_hand / frozen / qc / total_qty 按流水重算；reserved / in_transit / available / projected 历史不可还原，返回 null 并告警）
curl "http://localhost:3100/api/v1/inventory?as_of=2026-03-15"

# 采购在途 / 历史采购（提前期）/ 供应商提前期聚合
curl "http://localhost:3100/api/v1/in-transit?status=confirmed,partial"
curl "http://localhost:3100/api/v1/purchase-history?supplier_code=SU-1001"
curl "http://localhost:3100/api/v1/suppliers/SU-1001/lead-time-stats"

# 销售订单行 / 仓库主数据（unshipped = quantity − shipped_qty − cancelled_qty；
#   customer_name 按客户名称精确过滤，order_date 按订单日期精确匹配，
#   date_from、date_to 按「要求交期」过滤）
curl "http://localhost:3100/api/v1/sales-orders?status=confirmed,partial"
curl "http://localhost:3100/api/v1/sales-orders?order_no=SO-20260918-0001&item_code=FG-1001"
curl "http://localhost:3100/api/v1/sales-orders?warehouse_code=WH-02&order_date=2026-09-18"
curl "http://localhost:3100/api/v1/sales-orders?customer_name=华东经销"
curl "http://localhost:3100/api/v1/sales-orders?customer_code=CU-2001&date_from=2026-01-01&date_to=2026-12-31"
curl "http://localhost:3100/api/v1/warehouses?type=warehouse"

# CSV 导出（不套信封，带 BOM；有告警看响应头 X-Warnings）
curl "http://localhost:3100/api/v1/inventory?as_of=2026-03-15&format=csv" -o inventory.csv

# OpenAPI 3.1 文档
curl "http://localhost:3100/api/v1/openapi.json"
```

系统设置 → 数据接口页面（`/system/api-docs`）内置接口清单、逐条 `curl` 示例与 OpenAPI 链接。**该页面的清单直接渲染自 `GET /api/v1/openapi.json`，页内不维护第二份接口表**——接口增删改只需改 `openapi.ts`（各接口的 `summary` 带 `IF-x` 编号与标题、`x-returns` 给出返回说明），页面自动跟随。`public.test.ts` 有两个断言守住这点：每个接口都必须带 `summary`（`IF-x` 前缀）与 `x-returns`，且**参数列表必须与 zod schema 逐字一致**（后者曾真的漏过 `is_active`）。

### 三条口径（重要）

1. **历史时点派生量**：`reserved` / `in_transit` / `available` / `projected` 由销售单、采购/调拨单派生，冷却后无法从流水还原。指定 `as_of` 时这些字段返回 `null`，并在 `_warnings` 说明；`on_hand` / `frozen` / `qc` / `total_qty` 仍按流水精确重算。
2. **在途 `as_of` 近似**：IF-4 在途按 `order_date <= as_of` 过滤（单据无「当日在途」快照），结果可能包含早于 `as_of` 已入库的行，`_warnings` 会提示。
3. **提前期为整单口径**：库存流水不含 `line_no`，实际到货时刻只能还原到整单（`biz_type='purchase_in'` 的 `MIN/MAX occurred_at`），故 `lead_time_days` 为整单提前期，行级提前期不在本阶段范围。

### IF-6 销售订单行 · 字段说明

一行 = 销售单的一行物料，按 `order_no + line_no` 唯一。单据维度的字段（`order_date` / `customer_code` / `status`）在同一张单的每一行重复下发，便于下游按行直接消费，无需回查单据。

**查询参数**（全部可选；除 `keyword` 为模糊匹配外均为精确匹配）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `keyword` | string | 模糊匹配 `order_no` / `customer_code` / `item_code` / `item_name` |
| `order_no` | string | 订单号，精确匹配 |
| `customer_code` | string | 客户编码，精确匹配 |
| `customer_name` | string | 客户名称，精确匹配；**仅作过滤条件**，返回仍只给 `customer_code` |
| `item_code` | string | 物料编码，精确匹配 |
| `warehouse_code` | string | 发货仓库编码，精确匹配 |
| `status` | string | 逗号分隔多值，枚举 `draft / confirmed / partial / shipped / cancelled`（如 `confirmed,partial`） |
| `order_date` | string | 按订单日期精确匹配单日（`YYYY-MM-DD`） |
| `date_from` / `date_to` | string | 按「要求交期」`due_date` 过滤（`YYYY-MM-DD`，双端含边界） |
| `page` / `page_size` / `format` | - | 通用分页与输出格式参数 |

**返回字段**（`data[]` 每行）：

| 字段 | 类型 | 维度 | 说明 |
| --- | --- | --- | --- |
| `order_no` | string | 单据 | 订单号 |
| `line_no` | number | 行 | 行号（单内唯一，从 1 递增） |
| `order_date` | string | 单据 | 订单日期（`YYYY-MM-DD`） |
| `customer_code` | string | 单据 | 客户编码（客户名称已脱敏，恒不返回） |
| `item_code` | string | 行 | 物料编码 |
| `warehouse_code` | string | 行 | 发货仓库编码 |
| `quantity` | number | 行 | 订单数量（下单量，不随出库变化） |
| `shipped_qty` | number | 行 | 已出库量 |
| `unshipped` | number | 行 | 未出库量 = `quantity − shipped_qty − cancelled_qty` |
| `due_date` | string | 行 | 要求交期（`YYYY-MM-DD`） |
| `status` | string | 单据 | 订单状态（同上枚举） |

**口径说明**：

- `order_date` 为单据维度（同单各行同值），同时支持「作为过滤参数（精确匹配单日）」与「作为返回字段」两种用法；下游要按订单日期分组聚合时可直接取该列，无需回查销售单。
- 本接口仅返回 `customer_code`，**不返回客户名称与任何金额**；`customer_name` 只能作为过滤条件。
- 无 `as_of` 参数：`shipped_qty` / `unshipped` / `status` 取**当前值**，历史进度不可还原。
- `data` 带 `page`；`format=csv` 时列序与上表字段顺序一致，表头含 `order_date`。

## 业务接口（内部，需登录 + 权限）

统一信封 `{ code, message, data, page? }`，`code=0` 为成功；分页参数 `page` / `pageSize`。

| 模块 | 方法与路径 |
| --- | --- |
| 认证 | `GET /api/auth/config`、`GET /api/auth/me`、`POST /api/auth/logout`、`POST /api/auth/mock-login`（mock）、`GET /api/auth/dingtalk/url`、`GET /api/auth/dingtalk/callback`（dingtalk） |
| 用户 | `GET/POST /api/system/users`、`PATCH /api/system/users/:id`、`PUT /api/system/users/:id/roles` |
| 角色权限 | `GET /api/system/permissions`、`GET/POST /api/system/roles`、`PATCH/DELETE /api/system/roles/:id`、`PUT /api/system/roles/:id/permissions`（`sys_admin` 的权限集不可改写） |
| 系统参数 | `GET /api/system/params`（只读，需 `system.param.view`） |
| 物料分类 | `GET/POST /api/masterdata/categories`、`PATCH/DELETE /api/masterdata/categories/:id` |
| 物料 | `GET/POST /api/masterdata/items`、`GET/PATCH/DELETE /api/masterdata/items/:id`、`PUT /api/masterdata/items/:id/certifications` |
| 往来单位 | `GET/POST /api/masterdata/partners`、`PATCH/DELETE /api/masterdata/partners/:id` |
| 仓库 | `GET/POST /api/masterdata/warehouses`、`PATCH/DELETE /api/masterdata/warehouses/:id` |
| BOM | `GET/POST /api/masterdata/boms`（列表可带 `asOf` 只取该日生效版）、`GET /api/masterdata/boms/explode`（多层展开）、`PATCH/DELETE /api/masterdata/boms/:id` |
| 替代关系 | `GET/POST /api/masterdata/substitutes`、`PATCH/DELETE /api/masterdata/substitutes/:id`（硬删除；停用改 `isActive`）、**`GET /api/masterdata/substitutes/plan`**（需求试算：给定主料/仓/需求量/场景/客户/策略，返回分配建议、缺口与跳过原因；只读） |
| 库存 | `GET /api/inventory/stocks`（八列口径 / `asOf` 历史时点 / `keyword` `productId` `warehouseId` 筛选）、`GET /api/inventory/balances`（物料×仓库三状态明细）、`GET /api/inventory/transactions`（流水，支持状态/业务类型/日期筛选）、`POST /api/inventory/status-change`（冻结/解冻/送检/质检放行） |
| 采购 | `GET/POST /api/purchase/orders`、`GET/PATCH/DELETE /api/purchase/orders/:id`、`POST /api/purchase/orders/:id/confirm`（确认）、`POST /api/purchase/orders/:id/cancel`（取消）、`POST /api/purchase/inbound`（行级入库过账）、`GET/POST /api/purchase/returns`（采购退货） |
| 销售 | `GET/POST /api/sales/orders`、`GET/PATCH/DELETE /api/sales/orders/:id`、`POST /api/sales/orders/:id/confirm`（确认）、`POST /api/sales/orders/:id/cancel`（取消）、`POST /api/sales/outbound`（行级出库过账，行可带 `allowSubstitute` / `substituteItemId` 使用替代料）、`GET/POST /api/sales/returns`（销售退货） |
| 库存调拨 | `GET/POST /api/inventory/transfers`、`GET/PATCH/DELETE /api/inventory/transfers/:id`、`POST /api/inventory/transfers/:id/confirm`（确认）、`/cancel`（取消）、`/ship`（整单发货）、`/receive`（整单收货） |
| 库存盘点 | `GET/POST /api/inventory/stocktakes`、`GET/PATCH/DELETE /api/inventory/stocktakes/:id`、`POST /api/inventory/stocktakes/:id/post`（过账）、`/cancel`（取消） |
| 库存预警 | `GET/POST /api/inventory/alert-rules`、`PATCH/DELETE /api/inventory/alert-rules/:id`、`GET /api/inventory/alerts`（当前预警清单，不分页） |
| 报表 | `GET /api/reports/inventory-ledger`（进销存明细账）、`GET /api/reports/stock-snapshot`（库存现状表）、`GET /api/reports/item-movement`（商品收发明细）、`GET /api/reports/supplier-lead-time`（供应商提前期分析）、`GET /api/reports/substitute-usage`（替代料调用与呆滞）；均需 `report.view`，支持 `format=csv` 同步下载 |
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

- `GET /api/inventory/stocks` 一次返回全部实物量三桶（`on_hand` / `frozen` / `qc`）与派生量（`total_qty` / `reserved` / `in_transit` / `available` / `projected`），四口径切换由前端完成，避免死参数。
- 传 `asOf`（`YYYY-MM-DD` 或 ISO 8601）时从 `stock_transaction` 重算实物量（`on_hand` / `frozen` / `qc` / `total_qty`），此时 `reserved` / `in_transit` / `available` / `projected` 返回 `null`（依赖单据当时状态，不可还原），响应 `_warnings` 会回显该口径说明。
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
- **库存现状表**（`report.view`）：复用库存清单实物量三桶（`on_hand` / `frozen` / `qc`）与派生量（`total_qty` / `reserved` / `in_transit` / `available` / `projected`），追加金额列 `stock_amount` = **按流水累计**的结存金额（`Σ direction × quantity × unit_cost`，排除 `status_change`，对应 `total_qty` 即三桶合计），与「进销存明细账」的期末金额同口径；`avg_cost`（移动加权均价）仅作参考。指定 `asOf` 时 `reserved` / `in_transit` / `available` / `projected` 与 `avg_cost` 返回 `null` 并写入 `_warnings`（与 P7 历史口径一致），而 `stock_amount` 仍可计算。
- **商品收发明细**（`report.view`）：逐笔流水，字段同库存流水，追加 `amount = quantity × unit_cost`。
- **供应商提前期分析**（`report.view`）：沿用 P7「整单口径」——流水无行号，实际到货时刻取该单 `biz_type='purchase_in'` 流水的 `MAX occurred_at` 还原到整单。`lead_time_days = 实际到货日 − order_date`；`promised_lead_time_days = max(promised_date) − order_date`；`on_time = 实际到货日 ≤ max(promised_date)`；`on_time_rate = 准时单数 / 已到货单数`。仅统计有到货记录的供应商。
- **首页看板**（`GET /api/dashboard/overview`，登录即可）：`kpi`（现存量 / 库存金额 `stock_amount` / 启用物料数 / 在途量 / 预警数，遵循 `port_stock_as_inventory` 默认排除港口仓；库存金额与库存现状表同口径）、`trend`（近 30 个**业务日**逐日出入库，按 UTC+8 分日、排除 `status_change`、无流水补 0 保证 30 点）、`alerts`（`below_min` 优先取前 10）、`todos`（采购草稿 / 待入库采购单 / 销售草稿 / 待出库销售单 / 在途调拨单计数；前端按各目标路由的权限码裁剪卡片）。
- **导出 = 同步 CSV 下载**：4 张报表均支持 `format=csv`，复用 P7 CSV 行为（UTF-8 BOM、不套信封、告警仅在存在时以 `X-Warnings`（条数）摘要传递），前端以带 `Authorization` 的 `fetch → blob` 触发浏览器下载；**不启用 `export_task` 异步任务 / 导出中心**。查询参数用内部驼峰命名（`dateFrom` / `warehouseId` / ...）。

## 替代料（P10）

主料库存不足时，按预配置规则用替代料兜底。完整方案见 [P10-替代料-实施方案.md](.trae/documents/P10-替代料-实施方案.md)，术语见 [CONTEXT.md](CONTEXT.md)。

### 数据与规则

- `item_substitute`：替代关系主表。**单向**（A→B 与 B→A 是两条记录）；`parent_item_id` 为空表示通用替代、非空表示仅在该父件下可用；`warehouse_id` 为空表示全仓、非空表示仅该仓；同一替代料命中多条时**取更专属的一条**（唯一索引用 `COALESCE(...,0)` 表达式，规避 SQLite 中 NULL 不参与唯一性判断的问题）。
- `item_substitute_log`：替代执行追溯（只增不改）。账本里替代出库仍是一笔普通 `sale_out`——`stock_transaction.biz_type` 是 CHECK 枚举且 SQLite 无法 `ALTER`，故「这是替代」的语义记在本表（原因见 [ADR 0003](docs/adr/0003-substitution-log-not-biz-type.md)）。
- **替代比例是整数分子/分母** `ratio_num / ratio_den`：替代料用量 = ⌈缺口 × 分子 ÷ 分母⌉（向上取整，宁可多备），回算覆盖量 = ⌊替代用量 × 分母 ÷ 分子⌋。取整发生在不能整除时会写入 `_warnings`（见 [ADR 0001](docs/adr/0001-integer-substitute-ratio.md)）。
- **三种策略**：`proportion` 按比例混用（主料优先，缺口由替代料按优先级兜底）／`whole_batch` 整批全量（**不做混用**：主料能全额覆盖就全用主料，否则找单一替代料整批顶上，都做不到时不分配并全量报缺口）／`manual` 手工指定（主料优先，缺口只允许用指定替代料）。
- **一层不嵌套**：只匹配主料的直接替代料，绝不递归「替代料的替代料」。
- **只支持同仓**替代（`cross_warehouse` 字段保留但固定 0）。
- 规划接口（`/substitutes/plan`、IF-9）**只读无副作用**：不预占、不加锁；执行时在**同一事务内**按最新库存重新规划，避免"规划结果跨请求漂移"。

### ⚠ 上线前置条件：客户认证

销售出库场景采用**正向认证**（default-deny）：某替代料要顶替主料给某客户，必须先在物料页维护该客户对该替代料的 `item_customer_certification`（未过期）。否则该替代料会被**跳过**，并在建议结果的 `skipped` / `_warnings` 中给出原因（`customer_not_certified` / `customer_cert_expired`）。

- **不配置认证 = 替代出库完全不可用**（不是"默认可用"）。
- 该限制**只作用于「替代」这一动作**：客户直接下单购买该物料时，认证与否不影响正常出库。
- 生产备料（`bom_plan`）与采购建议（`purchase_hint`）场景不传客户，**不受认证限制**。

### 权限

| 权限码 | 作用 |
| --- | --- |
| `masterdata.substitute.view` | 查看替代关系与需求试算建议 |
| `masterdata.substitute.manage` | 维护替代关系（内置角色中仅 `sys_admin`） |
| `sales.outbound.substitute` | **实际用替代料出库**（与 `sales.outbound.manage` 分离，可按角色单独收回；内置角色中 `salesperson` / `warehouse_keeper` 默认具备） |

### 呆滞判定

`GET /api/reports/substitute-usage` 按替代料聚合调用次数、替代数量与最近调用时间；**自最后一次替代使用起 ≥ 90 个自然日未再使用（或从未使用）即为呆滞**，按业务日（UTC+8）计算。`last_used_at` 与呆滞判定**始终按全部历史**，不受报表的日期区间影响；日期区间只影响 `substitution_count` / `total_sub_qty`。

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
| P10 | 替代料（关系主数据 + 只读规划 + 销售出库替代 + IF-8/IF-9 + 呆滞报表） | 已完成 |

P1 已落地页面：基础资料（物料管理、物料分类、BOM 管理、往来单位、仓库/工厂管理）、系统设置（用户管理、角色权限）。
P2 增补页面：库存查询、库存状态管理、库存流水。
P3 增补页面：采购单列表、新建/编辑采购单、采购单详情（含执行进度与退货记录）、采购入库、采购退货对话框。
P4 增补页面：销售单列表、新建/编辑销售单、销售单详情（含执行进度与退货记录）、销售出库（含物理可用量校验与分批出库）。
P5 增补页面：库存调拨（列表 / 新建 / 编辑 / 详情，含确认、整单发货、整单收货、取消）、库存盘点（列表 / 新建 / 编辑 / 详情，含过账与差异高亮、账面量实时预览）、库存预警设置（当前预警清单 + 阈值规则维护）。
P6 增补页面：BOM 管理增强（生效日期筛选「只看某日生效版本」、版本列、行内「展开」入口）、BOM 展开（选父件 / 生效日期 / 数量，多层缩进树 + 累计需求 + 外购件/自制件/循环引用标记 + 告警）。
P7 增补页面：系统设置 → 数据接口（`/system/api-docs`，对外接口清单 + 逐条 curl 示例 + CSV 导出示例 + OpenAPI 链接，无权限码；P10 起清单改为**由 OpenAPI 渲染**，不再在页内硬编码）。
P7 **零迁移**：对外接口全部包装既有 service / SQL，无新增表、索引或迁移。
P8 增补页面：首页看板（KPI 指标卡 + ECharts 近 30 天出入库双系列趋势 + 库存预警 Top 10 + 单据待办）、报表（进销存明细账、库存现状表、商品收发明细、供应商提前期分析；每页筛选 + 表格 + 分页 + 同步 CSV 导出）。
P8 **零迁移**：4 张报表与看板全部基于既有账本（`stock_transaction` / `stock_balance`）与单据表计算，`report.view` 权限码已在 `0002_rbac_seed.sql` 就位、`export_task` 表虽在 `0001_init.sql` 预留但本阶段不启用，无新增迁移。
P9 交付：独立种子脚本（`pnpm seed`）+ 端到端验收测试（`packages/server/src/test/acceptance.test.ts`，共 12 例），在空库上重建全量演示数据并逐阶段核对主数据 / 库存引擎 / 采购 / 销售 / 调拨盘点预警 / 报表 / 看板 / 对外接口。
P9 **零迁移**：种子数据不写进迁移，业务单据全部复用既有 service 生成，无新增表、索引或迁移。

### 后续优化与审核加固（已完成）

- 权限码统一收敛至 `packages/shared` 的 `PERMISSIONS` 常量（前端菜单/守卫与后端路由共用）；新增 `v-permission` 按钮级权限指令；写操作路由（新建 / 编辑 / 入库 / 出库）在守卫中按 manage 权限二次校验；补齐系统参数只读页（`/system/params`，权限码 `system.param.view`），菜单分组至此全部激活。
- **`0006_stock_invariants.sql`**：用触发器为「单据行已执行量 ≤ 订单量」补数据库层兜底（`received_qty + cancelled_qty ≤ quantity`、`shipped_qty + cancelled_qty ≤ quantity`、调拨 `received_qty ≤ shipped_qty ≤ quantity`）。SQLite 无法用 `ALTER TABLE` 追加 CHECK，且订单行表被退货表外键引用，故以触发器实现。**说明**：未对 `stock_balance.quantity` 加非负约束——余额按写入顺序累加，而 `as_of` 按 `occurred_at` 重算，系统明确支持倒挂补录历史单据，此时当前余额可合法为负。
- **`0007_apidoc_permission_grant.sql`**：`system.apidoc.view` 此前是死权限码（无任何使用点）。前端「数据接口」路由与菜单已改为按它裁剪，该迁移把它授予迁移时已存在的全部角色，保持既有可见范围不变。
- **`0008_item_substitute.sql`**：替代关系主表 `item_substitute` + 执行追溯表 `item_substitute_log`（含 `COALESCE` 表达式唯一索引与两个查询索引）。
- **`0009_substitute_permissions.sql`**：补种 3 个替代料权限码并授权。因 `sys_admin` 的权限集现已不可通过接口改写，**迁移是扩展它的唯一通路**（`0002` 的「全量权限」与 `viewer` 的 `LIKE '%.view'` 都是执行时快照，不会自动带上新码）。
- 日期口径统一为**业务时区 UTC+8**：`lib/time.ts` 是唯一的「日」换算入口，`as_of` / `dateFrom` / `dateTo`、报表默认区间、看板 30 天分日、提前期到货日均按业务日计算（此前按 UTC，UTC+8 部署下本地 00:00–08:00 会算进前一天）。
- 库存金额统一按**流水累计**取值（`Σ direction × quantity × unit_cost`，排除 `status_change`）：`/api/reports/stock-snapshot` 的 `stock_amount` 与看板 KPI `stock_amount` 与明细账期末金额同口径，不再用「数量 × 加权均价」（后者因逐笔取整会与此口径分离）。
- 同一请求内**重复提交同一订单行**（`orderItemId`）此前会绕过「在途量 / 未出库量 / 可退量」校验，造成超收入库、超量出库、超量退货（退货为入库，会凭空增加库存）。已在入参层拒绝重复行 + 服务层改为请求内累计校验，并为四个写入口补齐回归测试。
- 授权改为以数据库为准（停用 / 撤权即时生效）、生产配置启动自检、RBAC 护栏（`sys_admin` 权限集不可改写、不可改自己的角色、不可移除最后一名管理员）、前端 401 同步清理会话、内部报表 CSV 导出不再按分页截断、IF-6 缺省只返回未结需求。
- **P10 替代料**：新增 `modules/substitute/`（`substitute.plan.ts` 为只读规划深度模块——候选取数、客户认证过滤、三种策略分配、整数比例取整、缺口与跳过原因归集，被销售出库 / 需求试算 / IF-9 / 呆滞报表共用；`substitute.execute.ts` 负责追溯日志）、`GET /api/masterdata/substitutes[/plan]`、销售出库的 `allowSubstitute` / `substituteItemId`、IF-8 / IF-9、`GET /api/reports/substitute-usage`。`stock_transaction` 的账本口径、`as_of` 重算与「余额 = 流水净额」不变量均未改动。

## 种子数据与验收测试

演示场景：一家小型电子产品组装厂。种子模块 [seed.ts](packages/server/src/db/seed.ts) 复用既有业务 service（库存引擎、采购/销售/退货、调拨、盘点、预警、替代出库）在单事务内灌入：

- 基础资料：6 分类（含两级分类树 + 1 个停用分类）、16 物料（含 1 个停用物料、1 个批次管理、1 个序列号管理、4 个替代料专用物料）、5 仓库（三种类型齐全 + 1 个停用仓）、7 往来单位（`customer`/`supplier`/`both` 齐全 + 1 个停用客户）、10 行 BOM（FG-1001 双版本 + SF-2001 多层）
- **替代料**：12 条关系覆盖三种场景（销售出库 / BOM 备料 / 采购建议）× 三种策略（按比例 / 整批全量 / 手工指定）× 通用 / 仓专属 / 父件专属 × 生效中 / 未生效 / 已过期 / 已停用，含非 1:1 比例（2:3）；3 条客户认证（长期 / 长期 / 已过期）；**2 条真实替代执行追溯**（一条「主料 + 替代料」混用、一条整行由替代料满足）
- 库存：期初库存、`available / frozen / qc` 三桶、状态转移（WH-01 RM-3001 冻结 20、需质检物料入 qc）
- 单据：采购 5 单（全额入库 + 退货 / 部分入库 / 已确认 / 草稿 / 已取消）、销售 7 单（全出库 + 退货 / 部分出库 / 已确认 / 草稿 / 已取消 / 替代出库 ×2）、调拨 5 单（五种状态齐全）、盘点 4 单（已过账含盘亏 2 / 草稿 / 已取消 / 覆盖 frozen + qc 桶）、预警规则 6 条（含下限、上下限、已停用）、节假日日历 3 条、1 个已停用账号

**枚举覆盖度有测试守着**：`acceptance.test.ts` 的「枚举覆盖度」用例会从 schema 自动推导所有 `CHECK (col IN (...))` 枚举，断言演示数据里每个取值都出现过；确实无法造数据的（跨仓替代未实现、`item_substitute_log` 的 `purchase_in`/`plan` 无写入路径、`export_task` 未启用）必须在那份用例里显式登记理由。新增枚举值却忘了补演示数据时，该用例会直接失败。

用法与幂等：

```bash
pnpm seed           # 首次灌入；已灌入过（sys_param 种子标记存在）则跳过
pnpm seed --reset   # 清空全部业务表后重建，sys_*（角色/权限/参数）保留
```

验收测试 `acceptance.test.ts` 覆盖：空库基线（业务表为空、RBAC 就位、无种子标记）→ 种子幂等与 `--reset` 重建 → 主数据与枚举覆盖度 → 全链路只读校验（含账本只读性：查询类调用前后 `stock_transaction` / `stock_balance` 行数不变）。