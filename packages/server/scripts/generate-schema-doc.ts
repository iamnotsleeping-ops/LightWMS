/**
 * 生成《数据表字典》`docs/数据表字典.md`。
 *
 * 为什么要用脚本生成而不是手写：字段、类型、约束、索引、外键一旦手写就会随迁移漂移
 * （本项目已经吃过一次亏——对外接口清单在前端硬编码，新增 IF-8/IF-9 后页面仍显示旧清单）。
 * 这里把**结构**从库里逐字导出，只把**业务语义**（表用途、非显然字段说明、不变量）留成
 * 下面的人工注解，两者拼接成文档。
 *
 * 用法：`pnpm --filter @light-erp/server schema-doc`
 *      默认读 `packages/server/data/erp.db`，可用 `DB_PATH` 指向别的库。
 */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const dbPath = process.env.DB_PATH ?? path.join(repoRoot, 'packages/server/data/erp.db');
const outPath = path.join(repoRoot, 'docs/数据表字典.md');
const migrationsDir = path.join(repoRoot, 'packages/server/src/migrations');

interface TableNote {
  /** 这张表是什么、谁在写 */
  purpose: string;
  /** 仅列非显然字段；显然字段（code/name/is_active/created_at…）由全局约定覆盖 */
  fields?: Record<string, string>;
  /** 使用这张表时必须知道的事 */
  notes?: string[];
}

interface Group {
  title: string;
  intro?: string;
  tables: string[];
}

/** 分组顺序即文档顺序；未列出的表会归入末尾的「其它」并在生成时报错提示补注解 */
const GROUPS: Group[] = [
  {
    title: '基础资料',
    intro: '业务单据只引用这些表，不反向改写它们（唯一例外见 `item_customer_certification`）。',
    tables: ['item_category', 'item', 'warehouse', 'partner', 'bom', 'item_customer_certification'],
  },
  {
    title: '替代料',
    intro: '主料不足时按规则用替代料兜底；规则主数据与执行追溯分表存放。',
    tables: ['item_substitute', 'item_substitute_log'],
  },
  {
    title: '库存',
    intro: '这一层是系统的核心：流水是不可变账本，余额是它的汇总，其余一切库存口径都从两者推导。',
    tables: ['stock_transaction', 'stock_balance', 'stock_alert_rule'],
  },
  {
    title: '采购',
    tables: ['purchase_order', 'purchase_order_item', 'purchase_return', 'purchase_return_item'],
  },
  {
    title: '销售',
    tables: ['sales_order', 'sales_order_item', 'sales_return', 'sales_return_item'],
  },
  {
    title: '调拨与盘点',
    tables: ['transfer_order', 'transfer_order_item', 'stocktake_order', 'stocktake_order_item'],
  },
  {
    title: '系统与权限',
    intro: '`sys_*` 四张关联表是 RBAC 主体；权限码共 38 个，动作只有 `view` / `manage` / `confirm`。',
    tables: ['sys_user', 'sys_role', 'sys_permission', 'sys_user_role', 'sys_role_permission', 'sys_param', 'sys_holiday'],
  },
  {
    title: '辅助与框架',
    tables: ['doc_sequence', 'export_task', 'schema_migration'],
  },
];

const NOTES: Record<string, TableNote> = {
  item_category: {
    purpose: '物料分类（树形，`parent_id` 自引用）。',
    fields: {
      capacity_group: '产能归类。界面上可维护，但**当前没有任何逻辑读取它**，仅是留给后续排产/产能的占位字段。',
    },
  },
  item: {
    purpose: '物料主数据。物料编码在本系统内唯一，是采购/销售/BOM/替代料的共同引用点。',
    fields: {
      base_unit: '基本计量单位。`0005` 迁移已把历史中文单位（件/只/个/块/张）统一为 `EA`，现由 `BASE_UNITS` 枚举收敛。',
      qty_precision: '数量精度。**字段存在但写入侧仍强制整数**（zod `.int()`、`CHECK (quantity > 0)`、库存引擎 `Number.isInteger`）。改小数数量是独立议题，不要只看这个字段就以为已支持小数。',
      inspection_required: '=1 时采购入库落 `qc` 桶（待检），需走「质检放行」才进 `available`。',
      batch_managed: '批次管理标记。当前仅作标记，未参与库存键（库存维度是 物料 × 仓库 × 状态）。',
      serial_managed: '序列号管理标记，同上。',
      category_id: '引用 `item_category.id`。',
    },
    notes: ['删除受保护：被单据/BOM/库存引用的物料不能删除（服务层拦，非数据库级）。'],
  },
  warehouse: {
    purpose: '工厂 / 仓库主数据。`type` 决定是否可能被库存口径排除。',
    fields: {
      type: '`plant` 工厂 / `warehouse` 仓库 / `port` 港口仓。系统参数 `port_stock_as_inventory=false` 时，**港口仓默认不计入库存查询与报表**（明细账不排除）。',
      parent_id: '上级组织，自引用。',
    },
  },
  partner: {
    purpose: '往来单位（客户 / 供应商），`type` 区分角色。',
    fields: {
      type: '`customer` / `supplier` / `both`。同一伙伴可两种角色兼有。',
      lead_time_days: '约定提前期。供应商提前期分析实际用「实际到货日 − 订单日」计算，此字段是人工约定值。',
    },
  },
  bom: {
    purpose: 'BOM 明细（父件 ← 子件），**多版本**靠生效期表达，同一父件可有多条重叠期为空的记录。',
    fields: {
      qty_per: '单位用量（整数，`CHECK (qty_per > 0)`）。',
      scrap_rate: '损耗率。',
      'effective_from / effective_to': '版本生效期，`NULL` 表示不设边界；`as_of` 查询即按此择版本。',
    },
    notes: [
      'BOM 展开只在内存里递归，不落表；循环引用由服务层检测并回传 `cycles`。',
      'P10 的替代料建议**不改写 BOM**：缺口行的替代建议由前端调 `GET /api/masterdata/substitutes/plan` 得到。',
    ],
  },
  item_customer_certification: {
    purpose: '客户对物料的认证（正向语义）。当前唯一消费方是**替代出库**：销售出库场景下，替代料必须对该客户有未过期认证，否则被跳过。',
    fields: {
      certified_at: '认证日期。',
      expire_at: '失效日期，`NULL` 表示长期有效。',
    },
    notes: [
      '**只约束「替代」这一动作**：客户直接下单购买该物料时，认证与否不影响正常出库。',
      'default-deny：没有记录 = 不允许替代。因此未配置认证时替代出库完全不可用。',
    ],
  },
  item_substitute: {
    purpose: '替代关系主表（主料 → 替代料）。',
    fields: {
      parent_item_id: '适用父件，`NULL` = 不限父件（通用）。命中多条时取更专属的一条。',
      warehouse_id: '适用仓库，`NULL` = 全仓。同上，越专属越优先。',
      priority: '同场景内的兜底顺序，越小越先。',
      'ratio_num / ratio_den': '替代比例（整数分子 / 分母）。换算 `替代用量 = ⌈缺口 × 分子 ÷ 分母⌉`，回算 `覆盖量 = ⌊替代用量 × 分母 ÷ 分子⌋`。用整数是为了不动全系统数量精度（见 ADR 0001）。',
      strategy: '`proportion` 按比例混用（主料优先）/ `whole_batch` 整批全量（不做混用）/ `manual` 手工指定。',
      scene: '`sales_out` / `bom_plan` / `purchase_hint`。**硬分区**，不跨场景匹配。',
      cross_warehouse: '跨仓替代开关。**当前固定 0 且未实现跨仓逻辑**，字段为后续预留。',
      is_active: '停用即不参与匹配（走软停用而非删除，便于留痕）。',
    },
    notes: [
      '**单向**：A→B 与 B→A 是两条独立记录，不互推。',
      '**一层**：只匹配主料的直接替代料，绝不递归「替代料的替代料」。',
      '同一主料 / 替代料 / 场景下，(父件, 仓库) 组合唯一：唯一索引用 `COALESCE(...,0)` 表达式，因为 SQLite 中 `NULL` 不参与唯一性判断。',
      '`CHECK (main_item_id <> sub_item_id)` 由数据库兜底，服务层也拦。',
    ],
  },
  item_substitute_log: {
    purpose: '替代执行追溯（只增不改）。',
    fields: {
      'biz_type / biz_id / biz_no': '来源单据。`sales_out` 对应销售出库，`plan` 预留给纯规划留痕。',
      'main_need_qty / main_actual_qty': '该行的主料需求量与其中实际用主料满足的部分。',
      sub_actual_qty: '替代料实际用量（替代料自身单位）。',
      'ratio_num / ratio_den': '当时的比例快照——**不能**只按关系表现值反推历史。',
      reason: '写入原因文案。',
    },
    notes: [
      '**账本里没有「替代」这个 `biz_type`**：替代出库在 `stock_transaction` 仍是一笔普通 `sale_out`（`biz_type` 是 CHECK 枚举且 SQLite 无法 `ALTER`，而该表是不可变核心账本）。所以「这是替代」只能靠本表追溯（见 ADR 0003）。',
      '`stock_transaction` 只记实际出库的物料与数量，不记「本来该出什么」；主料需求侧的信息在本表。',
    ],
  },
  stock_transaction: {
    purpose: '库存流水：**不可变账本**，一切库存数量的唯一事实来源。',
    fields: {
      direction: '`1` 入 / `-1` 出。`quantity` 恒为正，方向由本字段表达。',
      quantity: '数量（整数，`CHECK (quantity > 0)`）。',
      stock_status: '`available` / `frozen` / `qc`，状态转移也记流水（`biz_type = status_change`）。',
      unit_cost: '本笔的单位成本（分）。状态转移不改动成本。',
      biz_type: '8 个取值：`purchase_in` / `sale_out` / `purchase_return` / `sale_return` / `transfer_out` / `transfer_in` / `adjust` / `status_change`。**新增取值不可能**（SQLite 无法 `ALTER` CHECK），需要新语义时另开日志表。',
      occurred_at: '业务发生时刻（UTC ISO 8601）。**`as_of` 历史重算按本字段排序**，而业务日归属按 UTC+8 换算。',
    },
    notes: [
      '只增不改：业务上禁止 UPDATE / DELETE，修正靠反向流水。',
      '同一事务内的写入顺序固定：写流水 → 更新余额 → 累加单据表体已执行量 → 推进单据状态。',
      '**库存金额按流水累计**（`Σ direction × quantity × unit_cost`，排除 `status_change`），不等于「数量 × 均价」——逐笔取整会让两者分离。',
      '倒挂补录（后补历史单据）是明确支持的，故 `stock_balance.quantity` **允许为负**，没有非负约束。',
    ],
  },
  stock_balance: {
    purpose: '余额汇总快照：`(物料, 仓库, 状态)` 的当前数量与移动加权平均成本。',
    fields: {
      quantity: '该维度当前数量。允许为负（倒挂补录的合法结果）。',
      avg_cost: '该维度的移动加权平均成本（分）。入库时重算、出库时结转。',
    },
    notes: [
      '**禁止绕过流水直接改余额**：余额只是缓存，`as_of` 查询一律从流水重算。',
      '不变量：`stock_balance.quantity` = 同维度流水的 `Σ direction × quantity`（验收测试与替代出库测试都断言了这条）。',
      '主键是 `(product_id, warehouse_id, stock_status)`，即三状态各自独立成行。',
    ],
  },
  stock_alert_rule: {
    purpose: '库存预警阈值规则（最小 / 最大数量），按 物料 ×（可选）仓库 配置。',
    fields: {
      warehouse_id: '`NULL` = 不限仓库的通用规则。',
      'min_qty / max_qty': '触发下限 / 上限。当前预警只看 `below_min`。',
    },
    notes: ['唯一的「先查后写」唯一性先例：SQLite 中 `NULL` 不参与唯一约束，故由服务层 `assertUnique` 兜住「同一物料同一仓库只有一条规则」。'],
  },
  purchase_order: {
    purpose: '采购单表头。',
    fields: {
      status: '`draft` / `confirmed` / `partial` / `received` / `cancelled`，由表体执行进度推导推进。',
      order_date: '下单日期（业务日）。',
      promised_date: '供应商承诺到货日，提前期分析的对照基准。',
    },
  },
  purchase_order_item: {
    purpose: '采购单表体（行）。',
    fields: {
      line_no: '行号，从 1 开始，**保存后不可变**；`(order_id, line_no)` 是业务唯一键。',
      received_qty: '已入库量。由入库过账累加，触发器兜底不得越界。',
      cancelled_qty: '行级已取消量。',
      warehouse_id: '收货仓库（行级指定）。',
    },
    notes: ['数据库触发器强制 `received_qty + cancelled_qty <= quantity`（见触发器一节）。'],
  },
  purchase_return: {
    purpose: '采购退货单表头：把已入库的货退回供应商，因此它对应的是**出库**方向的库存变动。',
    fields: { return_date: '退货日期（业务日）。', order_id: '来源采购单。' },
  },
  purchase_return_item: {
    purpose: '采购退货单表体。',
    fields: {
      order_item_id: '指向来源采购单行，退货量受「已入库量 − 已退量」约束。',
      quantity: '退货数量（整数，`CHECK (quantity > 0)`）。',
    },
  },
  sales_order: {
    purpose: '销售单表头。',
    fields: {
      status: '`draft` / `confirmed` / `partial` / `shipped` / `cancelled`。',
      customer_id: '客户（`partner`）。这也决定了替代出库时校验哪一份客户认证。',
    },
  },
  sales_order_item: {
    purpose: '销售单表体（行）。',
    fields: {
      shipped_qty: '已出库量。**口径始终是「客户订的主料被满足了多少」**：发生替代时，替代料的折算覆盖量计入本字段，故它不会因为替代而改变含义。',
      cancelled_qty: '行级已取消量。',
      warehouse_id: '发货仓库（行级）。替代只支持**同仓**，即替代料从同一仓库扣减。',
      required_date: '客户要求交期。',
    },
    notes: [
      '触发器强制 `shipped_qty + cancelled_qty <= quantity`。',
      '`reserved`（已预占）只统计本表在 `confirmed` / `partial` 状态下的未出库量。',
    ],
  },
  sales_return: { purpose: '销售退货单表头（货退回仓库，库存增加）。', fields: { order_id: '来源销售单。' } },
  sales_return_item: {
    purpose: '销售退货单表体。',
    fields: { order_item_id: '指向来源销售单行，退货量受「已出库量 − 已退量」约束。' },
  },
  transfer_order: {
    purpose: '调拨单表头（仓 → 仓）。',
    fields: {
      status: '`draft` / `confirmed` / `shipped` / `received` / `cancelled`。',
      'from_warehouse_id / to_warehouse_id': '调出 / 调入仓，`CHECK (from_warehouse_id <> to_warehouse_id)`。',
    },
    notes: ['整单发货 / 整单收货：确认后一次性处理全部表体行。'],
  },
  transfer_order_item: {
    purpose: '调拨单表体。',
    fields: { 'shipped_qty / received_qty': '已发出 / 已收到量，调拨在途 = `shipped_qty − received_qty`。' },
    notes: ['触发器强制 `received_qty <= shipped_qty <= quantity`。'],
  },
  stocktake_order: {
    purpose: '盘点单表头。',
    fields: { status: '`draft` / `posted` / `cancelled`。过账即写差异流水并推进状态。' },
  },
  stocktake_order_item: {
    purpose: '盘点单表体（按物料 × 状态盘）。',
    fields: {
      book_qty: '账面量（生成盘点单时的快照）。',
      counted_qty: '实盘量。',
      diff_qty: '差异 = 实盘 − 账面，过账时按本字段写 `adjust` 流水。',
      stock_status: '盘点针对的状态桶（`available` / `frozen` / `qc`）。',
    },
  },
  sys_user: {
    purpose: '用户账号。',
    fields: {
      dingtalk_user_id: '钉钉用户 id；**mock 登录时存的是 `mock:<登录名>`**，而 mock 登录正是按本字段匹配的。',
      dingtalk_union_id: '钉钉 unionId，SSO 登录的匹配键。切钉钉后账号按本字段匹配，**不会**与 mock 账号自动合并。',
      is_active: '停用后即使持有有效令牌也会被拒（授权以数据库为准，每请求回查）。',
    },
    notes: ['通过界面新建的用户 `dingtalk_user_id` 为空，因此**无法用 mock 登录**（mock 只匹配 `mock:` 前缀）。'],
  },
  sys_role: { purpose: '角色。`sys_admin` 是内置超级管理员，其权限集不可通过接口改写（新增权限码由迁移补授）。', fields: {} },
  sys_permission: {
    purpose: '权限码字典（38 个）。',
    fields: { code: '`模块.资源.动作`，动作只有 `view` / `manage` / `confirm`（`report.view` 为两段式例外）。', module: '所属模块，用于前端分组。' },
  },
  sys_user_role: { purpose: '用户 ↔ 角色。', notes: ['两道护栏：不允许改**自己**的角色，不允许移除**最后一名**系统管理员。'] },
  sys_role_permission: { purpose: '角色 ↔ 权限。', notes: ['`sys_admin` 在此表中持有全部权限码；`viewer` 持全部 `*.view`。两者都是**在迁移执行时**取快照写入的，新增权限码不会自动带上，需由迁移显式补授。'] },
  sys_param: {
    purpose: '系统参数（键值）。',
    fields: { key: '当前实际使用的参数：`port_stock_as_inventory`（港口仓是否计入库存口径，默认 false）。' },
    notes: ['无写入接口，只读页展示；值可由迁移或运维直接改库。'],
  },
  sys_holiday: {
    purpose: '节假日 / 调休日历（`kind` = `holiday` 放假 / `workday` 补班）。',
    fields: { holiday_date: '日期（YYYY-MM-DD）。' },
    notes: ['当前表为空且**没有业务逻辑读取**——工作日推算尚未接入，属预留。'],
  },
  doc_sequence: {
    purpose: '单据号序列：按 (单据类型, 业务日) 维护下一个序号，保证单号如 `PO-20261005-0001` 连续且不重复。',
    fields: { doc_type: '单据类型前缀（PO/SO/TR/ST 等）。', biz_date: '业务日（UTC+8）。', next_no: '下一个可用序号。' },
    notes: ['发号在业务事务内完成，避免并发重号。'],
  },
  export_task: {
    purpose: '异步导出任务表。',
    notes: ['`0001` 建表预留，**当前未启用**：报表导出走同步 CSV 下载（`format=csv`），不落任务表。'],
  },
  schema_migration: {
    purpose: '迁移框架自维护的已应用版本表（不写在 `0001_init.sql` 里）。',
    fields: { version: '迁移文件名（不含 `.sql`）。', applied_at: '应用时刻。' },
    notes: ['迁移**只增不改**：已应用的迁移文件内容不得修改，否则各环境 schema 会分叉。'],
  },
};

/** 生成时报错提示用的必填注解键 */
function assertAnnotations(tables: string[]): void {
  const missing = tables.filter((table) => !NOTES[table]);
  if (missing.length > 0) {
    throw new Error(`以下表缺少人工注解，请在 NOTES 中补充：${missing.join(', ')}`);
  }
}

function tablesOf(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function columnsOf(db: Database.Database, table: string) {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }[];
}

function indexesOf(db: Database.Database, table: string) {
  const list = db.prepare(`PRAGMA index_list("${table}")`).all() as {
    name: string;
    unique: number;
  }[];
  return list.map((index) => {
    const info = db.prepare(`PRAGMA index_info("${index.name}")`).all() as { name: string | null }[];
    const cols = info.map((row) => row.name).filter((name): name is string => name !== null);
    return { name: index.name, unique: index.unique === 1, columns: cols };
  });
}

function foreignKeysOf(db: Database.Database, table: string) {
  const list = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
    from: string;
    table: string;
    to: string;
    on_delete: string;
  }[];
  return list.map((fk) => ({
    from: fk.from,
    target: `${fk.table}.${fk.to}`,
    onDelete: fk.on_delete === 'NO ACTION' ? null : fk.on_delete,
  }));
}

/** 从建表语句里取出所有 CHECK 括号内的原文（含嵌套括号，逐字保留） */
function checksOf(ddl: string): string[] {
  const found: string[] = [];
  const pattern = /CHECK\s*\(/gi;
  let match = pattern.exec(ddl);
  while (match) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < ddl.length && depth > 0) {
      const char = ddl[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    found.push(ddl.slice(start, index - 1).replace(/\s+/g, ' ').trim());
    match = pattern.exec(ddl);
  }
  return [...new Set(found)];
}

/** 建表语句里位于末尾的整表约束（PRIMARY KEY / UNIQUE） */
function tableConstraintsOf(ddl: string): string[] {
  const body = ddl.slice(ddl.indexOf('('));
  const found: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    if (/^(PRIMARY KEY|UNIQUE)\s*\(/.test(trimmed)) found.push(trimmed.replace(/\s+/g, ' '));
  }
  return found;
}

function migrationOf(table: string): string {
  for (const file of readdirSync(migrationsDir).sort()) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
    if (new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?${table}\\b`, 'i').test(sql)) return file;
  }
  return '—';
}

/** 中文序号（用于章节编号，够用到 20） */
const CN_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

function main(): void {
  const db = new Database(dbPath, { readonly: true });
  const allTables = tablesOf(db);
  assertAnnotations(allTables);

  const grouped = new Set(GROUPS.flatMap((group) => group.tables));
  const ungrouped = allTables.filter((table) => !grouped.has(table));
  if (ungrouped.length > 0) throw new Error(`以下表未分组：${ungrouped.join(', ')}`);

  const triggers = db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all() as { name: string; tbl_name: string; sql: string }[];
  const ddlOf = (table: string): string =>
    (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql;

  const lines: string[] = [];
  const push = (...text: string[]): void => {
    lines.push(...text);
  };

  push(
    '# 数据表字典',
    '',
    '本文件由 `packages/server/scripts/generate-schema-doc.ts` 生成：**字段、类型、约束、索引、外键均从数据库逐字导出**，只有表用途与字段说明是人工注解。',
    '因此它不会随迁移漂移；改完迁移后重新生成即可：',
    '',
    '```bash',
    'pnpm --filter @light-erp/server schema-doc',
    '```',
    '',
    `当前对应迁移 \`0001\`–\`0009\`，共 **${allTables.length} 张表**、**${
      (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n
    } 个索引**、**${triggers.length} 个触发器**。`,
    '',
    '> 术语（主料 / 替代料 / 替代比例 / 业务日 / 可承诺量 …）见仓库根目录 [CONTEXT.md](../CONTEXT.md)；',
    '> 表间设计取舍见 [docs/adr/](./adr/)；接口清单见 [README.md](../README.md)。',
    '',
    '## 一、全局约定',
    '',
    '读任何一张表前先知道这几条，它们能省掉文档里成千上万字的重复说明：',
    '',
    '| 约定 | 内容 |',
    '| --- | --- |',
    '| 金额 | 一律**整数分**，字段名以 `_cost` / `_amount` 结尾；不存在浮点金额。 |',
    '| 数量 | 一律**整数**（最小单位）。写入侧强制整数，`stock_transaction` 有 `CHECK (quantity > 0)`。 |',
    '| 日期 | 业务日期为 `TEXT` `YYYY-MM-DD`（由人填写，如 `order_date`、`return_date`）。 |',
    '| 时点 | 时间戳为 `TEXT` ISO 8601（UTC），如 `occurred_at`、`created_at`。**两者不能混用**，业务日归属必须经 UTC+8 换算（`lib/time.ts`）。 |',
    '| 命名 | 数据库与 API 一律 `snake_case`；内部业务接口的**查询参数**用 `camelCase`，对外 `/api/v1` 用 `snake_case`。 |',
    '| 主键 | 业务表统一 `id INTEGER PRIMARY KEY AUTOINCREMENT`；关联表用复合主键。 |',
    '| 外键 | `*_id` 字段的命名即指向 `*(id)`；未标注 `ON DELETE` 的默认 `NO ACTION`（即不可删被引用行）。 |',
    '| 审计字段 | 业务表普遍带 `created_at` / `updated_at`（UTC ISO 8601），语义各处一致。 |',
    '| 枚举 | 一律用 `TEXT` + `CHECK (col IN (...))` 收敛，**不用数字码**；SQLite 无法 `ALTER` CHECK，新增枚举值需重建表（故关键枚举宁可用独立日志表承载新语义，见 ADR 0003）。 |',
    '| 删除 | 主数据用 `is_active` 停用，而非软删除标记；单据用 `cancelled` 状态。物理删除仅限未被引用的数据。 |',
    '',
    '## 二、表分层与关系',
    '',
    '```text',
    '基础资料层              业务单据层                       库存层',
    'item_category           purchase_order                  ┌ stock_transaction  流水（只增不改，唯一事实来源）',
    'item          ──┬─→      ├ purchase_order_item          │      ↑ 写入',
    'warehouse        │       purchase_return(_item)        └ stock_balance      余额（汇总快照，可重算）',
    'partner          │       sales_order                         ↑',
    'bom              │        ├ sales_order_item                 │ 由流水推导',
    'item_customer_   │       sales_return(_item)                 │',
    'certification    │       transfer_order(_item)              │',
    'item_substitute  │       stocktake_order(_item)             │',
    'item_substitute_ └→      引用，不被业务改写                    │',
    'log                                                          │',
    '        替代执行追溯 ────────────────────────────────────────┘',
    '```',
    '',
    '- 单据一律「表头 + 表体」：`(order_id, line_no)` 是表体业务唯一键，`line_no` 从 1 开始且保存后不可变。',
    '- 所有库存变动都在同一事务内按固定顺序完成：**写流水 → 更新余额（含成本重算）→ 累加表体已执行量 → 推进单据状态**。',
    '- 在途是派生量，不落字段：采购在途 = 表体 `quantity − received_qty − cancelled_qty`（状态 `confirmed`/`partial`）；调拨在途 = `shipped_qty − received_qty`。',
    '',
    '## 表清单（点击跳转）',
    '',
  );

  for (const group of GROUPS) {
    push(`**${group.title}**：${group.tables.map((table) => `[\`${table}\`](#${table})`).join('、')}`, '');
  }
  push('');

  let sectionNumber = 3; // 一、全局约定 / 二、表分层与关系 已用掉
  for (const group of GROUPS) {
    push(`## ${CN_NUMBERS[sectionNumber - 1]}、${group.title}`, '');
    sectionNumber += 1;
    if (group.intro) push(group.intro, '');
    for (const table of group.tables) {
      const note = NOTES[table];
      const columns = columnsOf(db, table);
      const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
      push(`<a id="${table}"></a>`, '', `### \`${table}\``, '', note.purpose, '');
      push(`- 建表迁移：\`${migrationOf(table)}\``);
      push(`- 演示库行数：${rowCount}`, '');
      const ddl = ddlOf(table);
      const checks = checksOf(ddl);
      const tableConstraints = tableConstraintsOf(ddl);

      push('| 字段 | 类型 | 约束 | 默认 |', '| --- | --- | --- | --- |');
      for (const column of columns) {
        const flags: string[] = [];
        if (column.pk) flags.push(column.pk > 1 ? `PK(${column.pk})` : 'PK');
        if (column.notnull) flags.push('NOT NULL');
        if (foreignKeysOf(db, table).some((fk) => fk.from === column.name)) flags.push('FK');
        if (checks.some((check) => new RegExp(`(^|[^\\w])${column.name}([^\\w]|$)`).test(check))) {
          flags.push('CHECK');
        }
        push(
          `| \`${column.name}\` | ${column.type || '—'} | ${flags.join(' ') || '—'} | ${
            column.dflt_value ?? '—'
          } |`,
        );
      }
      push('');

      const indexes = indexesOf(db, table);
      if (indexes.length > 0) {
        push('索引：', '');
        for (const index of indexes) {
          push(
            `- ${index.unique ? '**UNIQUE** ' : ''}\`${index.name}\` (${index.columns.join(', ') || '表达式'})`,
          );
        }
        push('');
      }

      const fks = foreignKeysOf(db, table);
      if (fks.length > 0) {
        push('外键：', '');
        for (const fk of fks) {
          push(`- \`${fk.from}\` → \`${fk.target}\`${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}`);
        }
        push('');
      }

      if (checks.length > 0 || tableConstraints.length > 0) {
        push('约束（取自建表语句，仅压缩空白）：', '');
        for (const constraint of tableConstraints) push(`- \`${constraint}\``);
        for (const check of checks) push(`- \`CHECK (${check})\``);
        push('');
      }

      const fieldNotes = Object.entries(note.fields ?? {});
      if (fieldNotes.length > 0) {
        push('非显然字段：', '');
        for (const [field, text] of fieldNotes) push(`- \`${field}\`：${text}`);
        push('');
      }
      if (note.notes && note.notes.length > 0) {
        push('注意：', '');
        for (const item of note.notes) push(`- ${item}`);
        push('');
      }
    }
  }

  push(`## ${CN_NUMBERS[sectionNumber - 1]}、跨表不变量`, '', '这些约束**跨表**，数据库不强制，靠服务层与测试保证：', '');
  push(
    '- **余额 = 流水净额**：任一 `(物料, 仓库, 状态)` 的 `stock_balance.quantity` 等于同维度流水的 `Σ direction × quantity`。',
    '- **库存金额按流水累计**：`Σ direction × quantity × unit_cost`，排除 `biz_type = status_change`；与「数量 × 均价」不是同一口径。',
    '- **已执行量 ≤ 订单量**：由 6 个触发器在数据库层兜底（见下节）。',
    '- **权限以数据库为准**：每个受保护请求回查 `sys_user.is_active` 与该用户经角色实际持有的权限码，令牌里的权限快照不作数。',
    '- **`item_substitute` 单向且一层**：不互推、不递归。',
    '- **替代必须认证**：销售出库场景下，替代料需在 `item_customer_certification` 中有未过期记录，否则跳过并在 `skipped` 中给出原因。',
    '- **替代不改账本口径**：替代出库仍写普通 `sale_out` 流水，`sales_order_item.shipped_qty` 仍按主料口径累加。',
    '',
    `## ${CN_NUMBERS[sectionNumber]}、触发器（${triggers.length} 个：数据库层兜底）`,
    '',
    'SQLite 无法用 `ALTER TABLE` 追加 CHECK，且订单行表被退货表外键引用，故「已执行量」约束以触发器实现（迁移 `0006_stock_invariants.sql`）：',
    '',
    '| 触发器 | 作用表 | 规则 |',
    '| --- | --- | --- |',
  );
  const triggerRules: Record<string, string> = {
    trg_purchase_item_exec_qty_insert: '`received_qty + cancelled_qty <= quantity` 且两者非负',
    trg_purchase_item_exec_qty_update: '同上（更新方向）',
    trg_sales_item_exec_qty_insert: '`shipped_qty + cancelled_qty <= quantity` 且两者非负',
    trg_sales_item_exec_qty_update: '同上（更新方向）',
    trg_transfer_item_exec_qty_insert: '`received_qty <= shipped_qty <= quantity` 且非负',
    trg_transfer_item_exec_qty_update: '同上（更新方向）',
  };
  for (const trigger of triggers) {
    push(`| \`${trigger.name}\` | \`${trigger.tbl_name}\` | ${triggerRules[trigger.name] ?? '—'} |`);
  }
  push(
    '',
    '> 刻意**没有**对 `stock_balance.quantity` 加非负约束：系统明确支持倒挂补录历史单据，此时当前余额可合法为负。',
    '',
    `## ${CN_NUMBERS[sectionNumber + 1]}、迁移清单`,
    '',
    '| 迁移 | 内容 |',
    '| --- | --- |',
    '| `0001_init.sql` | 初始 schema（系统/权限、基础资料、单据、库存） |',
    '| `0002_rbac_seed.sql` | RBAC 种子：内置角色与权限码（`sys_admin` / `viewer` 的权限集是**执行时快照**） |',
    '| `0003_purchase_return.sql` | 采购退货 |',
    '| `0004_sales_return.sql` | 销售退货 |',
    '| `0005_base_unit_enum.sql` | 计量单位收敛为 `EA`（历史中文单位迁移） |',
    '| `0006_stock_invariants.sql` | 6 个触发器：单据行已执行量兜底 |',
    '| `0007_apidoc_permission_grant.sql` | 把死权限码 `system.apidoc.view` 授予既有角色 |',
    '| `0008_item_substitute.sql` | 替代关系主表 + 执行追溯表 |',
    '| `0009_substitute_permissions.sql` | 3 个替代料权限码并授权 |',
    '',
    '迁移**只增不改**：已应用的迁移文件不得修改，否则各环境 schema 会分叉。',
    '',
    `## ${CN_NUMBERS[sectionNumber + 2]}、按维度速查`,
    '',
    '排查「谁引用了这张表 / 谁带这个字段」时可以直接按下面找（**成员列表由库结构算出**，不会写错）：',
    '',
  );

  const withColumn = (column: string): string[] =>
    allTables.filter((table) => columnsOf(db, table).some((c) => c.name === column));
  const referencing = (target: string): string[] =>
    allTables.filter((table) => foreignKeysOf(db, table).some((fk) => fk.target.startsWith(`${target}.`)));
  const withTrigger = [...new Set(triggers.map((trigger) => trigger.tbl_name))];
  const list = (tables: string[]): string =>
    tables.length > 0 ? tables.map((table) => `\`${table}\``).join('、') : '（无）';

  push(
    `- **引用 \`item\` 的表**（${referencing('item').length} 张）：${list(referencing('item'))}`,
    `- **引用 \`warehouse\` 的表**（${referencing('warehouse').length} 张）：${list(referencing('warehouse'))}`,
    `- **带 \`created_by\` 的表**（${withColumn('created_by').length} 张）：${list(withColumn('created_by'))}`,
    `- **带 \`line_no\` 的表体**（${withColumn('line_no').length} 张）：${list(withColumn('line_no'))}`,
    `- **只增不改的表**：\`stock_transaction\`、\`item_substitute_log\`（\`schema_migration\` 亦为追加写入）`,
    `- **有触发器保护的表**（${withTrigger.length} 张）：${list(withTrigger)}`,
    '- **当前无逻辑读取的预留字段 / 表**：`item_category.capacity_group`、`item.batch_managed`、`item.serial_managed`、`item.qty_precision`、`item_substitute.cross_warehouse`、`sys_holiday`、`export_task`。其中 `qty_precision` 与 `cross_warehouse` 是有意留待后续的（见 ADR 0001），不要误以为功能已存在。',
    '',
  );

  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  db.close();
  console.log(`已生成 ${path.relative(repoRoot, outPath)}：${allTables.length} 张表、${triggers.length} 个触发器`);
}

main();
