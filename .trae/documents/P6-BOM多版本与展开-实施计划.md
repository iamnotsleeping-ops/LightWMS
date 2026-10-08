# P6 · BOM 多版本与展开 实施计划

## Context

P1 交付了基础资料（含 BOM 的表与维护页），P2 交付库存核心引擎，P3/P4/P5 交付采购 / 销售 / 库存作业。P6 回到基础资料层，把 BOM 从「可维护的明细行」升级为「**可按时点解析的版本化配方 + 可多层展开的结构**」，为 P7 的对外只读接口（`GET /api/v1/boms?as_of=`、`GET /api/v1/boms/{itemCode}/explode`）提供可复用的服务层。

现状盘点（已核实代码）：

- `bom` 表在 [0001_init.sql](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/server/src/migrations/0001_init.sql#L137-L153)（L137-L153）已建好，字段完整：
  - `parent_item_id` / `child_item_id`（均 `REFERENCES item(id)`）、`qty_per INTEGER CHECK(qty_per > 0)`、`scrap_rate REAL NOT NULL DEFAULT 0`、`effective_from TEXT`（可空）、`effective_to TEXT`（可空）、时间戳。
  - `CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)`。
  - `uq_bom_version` 唯一索引：`(parent_item_id, child_item_id, COALESCE(effective_from, '0000-01-01'))` —— 保证「同父件+同子件+同生效起始」不重复，但**不阻止生效期重叠**。
  - `idx_bom_parent(parent_item_id, effective_from, effective_to)`、`idx_bom_child(child_item_id)`。
- 已有内部 CRUD：[bom.routes.ts](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/server/src/modules/masterdata/bom.routes.ts) 提供 `GET/POST /api/masterdata/boms`、`PATCH/DELETE /api/masterdata/boms/:id`，权限码 `masterdata.bom.view` / `masterdata.bom.manage`（已在 `0002_rbac_seed.sql` 种好）。列表返回**不分页的数组**，`SELECT_LIST` 已 JOIN 出父/子件编码名称与单位。
- shared 已有 [bomBodySchema / bomUpdateBodySchema / bomQuerySchema](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/shared/src/schemas/masterdata.ts#L85-L106)（L85-L106），`bomQuerySchema` 目前仅 `parentItemId` / `childItemId` / `keyword`。
- 已有前端页 [BomView.vue](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/web/src/views/masterdata/BomView.vue)（列表 + 新增/编辑对话框），并已在前端做「生效期重叠」**提示**（仅 UI 警告，后端不拦截）。
- 缺口：
  1. 无「按 `as_of` 取生效版」的服务端解析逻辑；
  2. 无「多层展开 + 循环检测」逻辑；
  3. 后端**不拦截**同 `(parent, child)` 的生效期重叠 —— 会导致某个日期解析出多条版本，破坏多版本语义；
  4. 无展开 UI。

**结论：P6 为本仓库第二个「零迁移」业务阶段 —— 表结构（含唯一索引与 CHECK）已完全支撑「多版本（按生效期区间）+ 多层展开」，只需应用层实现。**

### 已确定的范围决策

1. **零迁移**：不新增表 / 列 / 索引，不改 `0001` / `0002`；`bom` 表与权限码均已就位。
2. **版本语义 = 单条 BOM 行的生效区间**。「某父件在日期 D 的生效 BOM」= 该父件下所有 `effective_from IS NULL OR effective_from <= D` 且 `effective_to IS NULL OR effective_to >= D` 的行集合（`NULL` 表示开区间：自始 / 无限期）。
3. **`as_of` 缺省 = 今天**（服务端取当日 `YYYY-MM-DD`，不引入时区偏移；BOM 是配方主数据，日期粒度到「天」）。
4. **后端补齐重叠强校验**：把前端提示升级为服务端规则 —— 同 `(parent_item_id, child_item_id)` 的新版本生效期若与既有版本重叠（**含同日边界**，即两区间共用任一天即视为重叠），返回 `409`，保证任一日期最多解析出一条版本。要切换到新版本，需先收口旧版本的 `effective_to`（留出 ≥1 天间隙）。
5. **多层展开 = DFS 递归**解析每个父件在 `as_of` 的生效子件；累计需求 = `上层需求 × qty_per × (1 + scrap_rate)`。含**循环检测**（路径栈）：命中循环则记录 cycle 路径、该分支不再下钻、树节点标记 `cyclic`，并写入顶层 `_warnings`（**不抛错**，保证只读接口与 UI 均可用）。
6. **叶子判定**：该物料在 `as_of` 无任何生效 BOM 行（即外购件 / 原材料）。
7. **用量不做取整**：`qty_per` 为整数、`scrap_rate` 为比例，累计需求允许小数；服务端保留原始数值，展示时按原始数值格式化（BOM 用量为配方系数，不做 `qty_precision` 精度缩放，与 BOM 管理页对 `qty_per` 的展示一致）。
8. **深度熔断**：为防病态深链（非环）拖垮请求，展开设最大深度（`BOM_EXPLODE_MAX_DEPTH = 32`），触顶则停止下钻并记 `_warnings`。

## 核心算法与业务规则

### 1. 生效版解析 `resolveEffectiveLines(db, parentItemId, asOf)`

```
SELECT b.id, b.parent_item_id, b.child_item_id, b.qty_per, b.scrap_rate,
       b.effective_from, b.effective_to,
       ci.code AS child_code, ci.name AS child_name, ci.base_unit AS child_unit,
       ci.qty_precision AS child_qty_precision
  FROM bom b JOIN item ci ON ci.id = b.child_item_id
 WHERE b.parent_item_id = @parentItemId
   AND (b.effective_from IS NULL OR b.effective_from <= @asOf)
   AND (b.effective_to   IS NULL OR b.effective_to   >= @asOf)
 ORDER BY ci.code
```

- `asOf` 归一为 `YYYY-MM-DD`（缺省取服务端当日）。字符串比较即可（表内存 `YYYY-MM-DD`）。
- 该函数是「展开」的原子步骤，也被列表的 `asOf` 过滤复用。

### 2. 重叠校验 `assertBomNoOverlap(db, parentItemId, childItemId, from, to, excludeId?)`

- 取同 `(parent, child)`（`excludeId` 排除自身）的既有版本，逐一判断区间是否相交：
  `overlap = (from ?? '0000-01-01') <= (existing.to ?? '9999-12-31') AND (existing.from ?? '0000-01-01') <= (to ?? '9999-12-31')`
- 相交 → `throw new ApiError(409, '同一父件、子件在该生效期内已存在其他版本')`。
- 在 `POST` 与 `PATCH` 中调用（`PATCH` 需先读出 `parent_item_id` / `child_item_id` 与合并后的生效期）。

### 3. 多层展开 `explodeBom(db, { itemId?, itemCode?, asOf, qty })`

- 解析根物料（`itemId` 或 `itemCode` 二选一，缺则 404/400）。
- DFS，维护 `path: number[]`（祖先链，用于循环检测）与 `level`（层级，根的子件为 1）。
- 对当前父件的每一条生效行：
  1. `requiredQty = parentRequiredQty × qty_per × (1 + scrap_rate)`；
  2. 若 `childItemId ∈ path` → 命中循环：产出节点标记 `cyclic = true`、`isLeaf = true`，记录 `cyclePath`（如 `FG-001 → SA-01 → FG-001`），不下钻；
  3. 否则产出节点 `{ level, parentCode, itemCode, itemName, baseUnit, qtyPrecision, qtyPer, scrapRate, requiredQty, isLeaf, cyclic }`；
  4. 若子件在 `as_of` 有生效行且未触深度上限 → 递归（`path + child`）；否则标记 `isLeaf = true`。
- 返回 `{ root: {...}, lines: Node[], cycles: string[][], warnings: string[] }`；循环与深度熔断写入 `warnings`，由路由层放入响应 `_warnings`。
- `lines` 为**前序展开的扁平序列**（带 `level`），前端据此渲染树形/缩进表格；`root` 携带根物料与根需求。

### 4. 列表的版本过滤

`GET /api/masterdata/boms` 新增可选 `asOf`：

- 不传 → 现状行为（全部版本，按 `父件码, 子件码, 生效起始` 排序）；
- 传 `asOf` → 只返回该日期生效的版本（等价对每一行做 `resolveEffectiveLines` 的过滤条件拼接）。

这样「多版本查看」与「某日生效版查看」共用一个列表接口，避免接口膨胀。

## 文件清单

### shared（修改）
- 修改 [masterdata.ts](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/shared/src/schemas/masterdata.ts)
  - `bomQuerySchema` 增加 `asOf: dateSchema.optional()`
  - 新增 `bomExplodeQuerySchema`：`{ itemId? 正整数, itemCode? 非空串, asOf? 日期, qty? 正数默认 1 }` + `.refine(itemId 或 itemCode 至少一个)`
- `packages/shared/src/index.ts`：masterdata 已 `export *`，**无需改**。
- `packages/shared/src/constants.ts`：**不改**（无新增枚举 / 前缀）。

### server（新增 / 修改；**无迁移**）
- 新增 `packages/server/src/modules/masterdata/bom.service.ts`
  - `normalizeBomAsOf(value?: string): string`（缺省取当日 `YYYY-MM-DD`）
  - `listBoms(query: BomQuery)`（含 `asOf` 生效版过滤；路由改为调它）
  - `resolveEffectiveLines(db, parentItemId, asOf)`
  - `assertBomNoOverlap(db, parentItemId, childItemId, from, to, excludeId?)`
  - `explodeBom(db, { itemId?, itemCode?, asOf?, qty? })`
  - 常量 `BOM_EXPLODE_MAX_DEPTH = 32`
- 修改 [bom.routes.ts](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/server/src/modules/masterdata/bom.routes.ts)
  - `GET /api/masterdata/boms` → 委托 `listBoms`（支持 `asOf`）
  - `POST` / `PATCH` → 追加 `assertBomNoOverlap`
  - 新增 `GET /api/masterdata/boms/explode`（`masterdata.bom.view`）
- 新增测试 `packages/server/src/modules/masterdata/bom.test.ts`

### web（新增 / 修改）
- 修改 [BomView.vue](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/web/src/views/masterdata/BomView.vue)
  - 工具栏新增「生效日期」`el-date-picker`（传 `asOf`，清空 = 全部版本）
  - 「版本」列（显示 `生效起 ~ 生效止`，`自始` / `无限期` 文案沿用）
  - 每行新增「展开」按钮 → 跳 `/masterdata/bom/explode?itemId=<parent_item_id>`
  - 保留现有前端重叠提示作为辅助，后端 409 由 api client 统一弹错
- 新增 `packages/web/src/views/masterdata/BomExplodeView.vue`
  - 顶部：父件选择（可由 `query.itemId` 预选，`el-select` filterable）+ `asOf` 日期 + 展开数量 `el-input-number` + 「展开」
  - 主体：`el-table` 树形展示（缩进体现层级），列含 层级 / 物料编码 / 名称 / 单位用量 / 损耗率 / 累计需求（原始数值）/ 类型（外购件 / 自制件 / 循环引用）；循环行高亮显示
  - 顶部 `el-alert` 展示 `warnings`（循环 / 深度熔断）
- 修改 [router/index.ts](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/web/src/router/index.ts)：新增 `masterdata/bom/explode` → `BomExplodeView`（`meta.title = 'BOM 展开'`）
- 修改 [menu.ts](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/packages/web/src/layouts/menu.ts#L25)：在「基础资料」下新增「BOM 展开」`/masterdata/bom/explode`，权限 `masterdata.bom.view`

### 文档
- 修改 [README.md](file:///Users/dayu/Library/Application%20Support/Trae%20SOLO%20CN/ModularData/ai-agent/work-mode-projects/6ac64783f16c026553a13bf8/README.md)：P6 进度标记完成、BOM 多版本与展开口径（版本=生效区间、as_of 解析、重叠校验、循环检测）、BOM 接口清单更新（`asOf` 参数 + explode）、P6 页面清单、「零迁移」说明、P7 承接说明

## 接口清单（全部需登录 + 权限码，沿用统一信封 `ok()` / `okPage()`）

| 方法与路径 | 权限码 | 说明 |
| --- | --- | --- |
| `GET /api/masterdata/boms` | `masterdata.bom.view` | 分页无关的 BOM 列表；新增 `asOf`（传入时只返回该日期生效版本） |
| `GET /api/masterdata/boms/explode` | `masterdata.bom.view` | 多层展开：`itemId` 或 `itemCode` + `asOf` + `qty`；返回扁平树 + `cycles` + `_warnings` |
| `POST /api/masterdata/boms` | `masterdata.bom.manage` | 新建版本；**新增生效期重叠校验（409）** |
| `PATCH /api/masterdata/boms/:id` | `masterdata.bom.manage` | 修改版本；**新增生效期重叠校验（409）** |
| `DELETE /api/masterdata/boms/:id` | `masterdata.bom.manage` | 删除版本（不变） |

冲突翻译沿用 `rethrowConstraint`；重叠与状态冲突用 `ApiError(409, ...)`；入参用 Zod `parse`。`GET .../explode` 的静态路径与既有 `/:id`（仅 PATCH/DELETE）**无冲突**。

## 单元测试（镜像 P5）

复用 `createTestDb()` + `seedFixtures(db)`（`RM-001 测试零件` / `FG-001 测试成品` / `WH-01`）；多层展开用例在测试内补充插入半成品物料与 BOM 行。

**bom.test.ts**

1. **生效版解析**：同 `(parent, child)` 建两个不重叠版本 → `asOf` 落在各自区间时各取其一；区间外返回空
2. **开区间语义**：`effective_from = null`（自始）/ `effective_to = null`（无限期）边界包含
3. **重叠校验**：与既有版本重叠的新建 → 409（含同日边界）；留出 ≥1 天间隙允许；`PATCH` 至重叠区间 → 409；`PATCH` 仅改 `qty_per` 不误判
4. **单层展开**：父件一条行 → `requiredQty = qty × qty_per × (1 + scrap_rate)`
5. **多层展开**：`FG-001 → SA（半成品）→ RM-001`，层级 / 单位用量 / 累计需求逐级正确
6. **叶子判定**：无生效 BOM 的子件 `isLeaf = true`
7. **循环检测**：`A → B → A` → 结果含 `cyclic` 节点、`cycles` 非空、`warnings` 非空，且**不无限递归**
8. **自循环**：`A → A`（父件展开含自身）→ 命中循环、单条 `cyclic`
9. **深度熔断**：构造超过 `BOM_EXPLODE_MAX_DEPTH` 的长链 → 停止下钻并产生 `warnings`
10. **as_of 选择版本参与展开**：同一父件两版本用量不同 → 不同 `asOf` 展开出不同累计需求
11. **as_of 缺省 = 今天**：仅当前生效版本参与展开
12. **恒等式 / 幂等**：展开是只读操作 → 调用前后 `bom` / `item` 无任何写入

## 验证方式

1. `pnpm typecheck` —— shared / server / web 三包全通
2. `pnpm test` —— P2 21 + P3 13 + P4 12 + P5 25 + P6 新增用例全绿
3. `pnpm migrate` —— 预期无新迁移应用（零迁移）
4. curl 校验入参校验与权限边界：`viewer` 对 `GET .../boms` 与 `GET .../boms/explode` 返回 200、`POST/PATCH/DELETE` 403；`sys_admin` 全通；explode 缺 `itemId`/`itemCode` → 400
5. `AUTH_PROVIDER=mock` 启动后端 + Vite，浏览器验收（复用 demo 库）：
   - BOM 管理页建两版本（如 `FG-001 ← RM-001`，生效期相邻不重叠）→ 用「生效日期」筛选分别命中不同版本；构造重叠保存 → 后端 409 弹出提示
   - 点行内「展开」→ 展开页显示多层树与累计需求；切 `asOf` / 数量 → 结果随之变化
   - 构造循环（`A → B`、`B → A`）→ 展开页出现循环告警且不卡死（**验收后删除造数**）
   - 「BOM 展开」菜单项点亮可点击；控制台零报错
6. 用一次性脚本（验证后删除）核对展开数值与 `asOf` 版本选择，不留造数残留

## 不在本阶段范围

- **对外只读接口** `/api/v1/boms?as_of=` 与 `/api/v1/boms/{itemCode}/explode`（含 `format=csv` 与 OpenAPI 文档）—— 属 **P7**，本阶段只交付可被其包装的 service 层
- BOM 的**版本号字段 / 发布-审批-停用流程 / 变更留痕（ECO）**：本阶段「版本」即生效期区间；引入显式版本号需迁移，暂不做
- **替代料 / 替代 BOM / 选配**、按 BOM 生成生产工单 / 领料（生产模块不在 P0-P9 范围）
- 多层展开的**成本卷积 / 需求汇总报表**（后续报表阶段与 P8 看板）
- 展开结果的**导出**（Excel / CSV）与前端批量操作