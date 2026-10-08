-- ============================================================
-- 0002_rbac_seed.sql · 内置角色、权限码与系统参数
-- 权限码格式：模块.资源.动作，动作统一为 view / manage / confirm
-- ============================================================

INSERT INTO sys_role (code, name, description) VALUES
  ('sys_admin',        '系统管理员', '内置角色：拥有全部权限'),
  ('purchaser',        '采购员',     '内置角色：采购单据与入库'),
  ('salesperson',      '销售员',     '内置角色：销售单据与出库'),
  ('warehouse_keeper', '仓管员',     '内置角色：库存作业与出入库执行'),
  ('viewer',           '只读用户',   '内置角色：仅查看，不可修改');

INSERT INTO sys_permission (code, name, module) VALUES
  ('masterdata.item.view',       '查看物料',       'masterdata'),
  ('masterdata.item.manage',     '维护物料',       'masterdata'),
  ('masterdata.category.view',   '查看物料分类',   'masterdata'),
  ('masterdata.category.manage', '维护物料分类',   'masterdata'),
  ('masterdata.bom.view',        '查看 BOM',       'masterdata'),
  ('masterdata.bom.manage',      '维护 BOM',       'masterdata'),
  ('masterdata.partner.view',    '查看往来单位',   'masterdata'),
  ('masterdata.partner.manage',  '维护往来单位',   'masterdata'),
  ('masterdata.warehouse.view',  '查看仓库',       'masterdata'),
  ('masterdata.warehouse.manage','维护仓库',       'masterdata'),
  ('purchase.order.view',        '查看采购单',     'purchase'),
  ('purchase.order.manage',      '维护采购单',     'purchase'),
  ('purchase.order.confirm',     '确认/取消采购单','purchase'),
  ('purchase.inbound.manage',    '采购入库/退货',  'purchase'),
  ('sales.order.view',           '查看销售单',     'sales'),
  ('sales.order.manage',         '维护销售单',     'sales'),
  ('sales.order.confirm',        '确认/取消销售单','sales'),
  ('sales.outbound.manage',      '销售出库/退货',  'sales'),
  ('inventory.query.view',       '库存查询',       'inventory'),
  ('inventory.transaction.view', '查看库存流水',   'inventory'),
  ('inventory.status.manage',    '冻结/质检放行',  'inventory'),
  ('inventory.transfer.view',    '查看调拨单',     'inventory'),
  ('inventory.transfer.manage',  '维护调拨单',     'inventory'),
  ('inventory.stocktake.view',   '查看盘点单',     'inventory'),
  ('inventory.stocktake.manage', '维护盘点单',     'inventory'),
  ('inventory.alert.view',       '查看库存预警',   'inventory'),
  ('inventory.alert.manage',     '维护库存预警',   'inventory'),
  ('report.view',                '查看报表',       'report'),
  ('system.user.view',           '查看用户',       'system'),
  ('system.user.manage',         '维护用户',       'system'),
  ('system.role.view',           '查看角色权限',   'system'),
  ('system.role.manage',         '维护角色权限',   'system'),
  ('system.param.view',          '查看系统参数',   'system'),
  ('system.param.manage',        '维护系统参数',   'system'),
  ('system.apidoc.view',         '查看数据接口',   'system');

-- 系统管理员：全量权限
INSERT INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r, sys_permission p WHERE r.code = 'sys_admin';

-- 只读用户：全部 view 权限
INSERT INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r, sys_permission p
WHERE r.code = 'viewer' AND p.code LIKE '%.view';

-- 采购员
INSERT INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r, sys_permission p
WHERE r.code = 'purchaser' AND p.code IN (
  'masterdata.item.view', 'masterdata.category.view', 'masterdata.bom.view',
  'masterdata.partner.view', 'masterdata.warehouse.view',
  'purchase.order.view', 'purchase.order.manage', 'purchase.order.confirm',
  'purchase.inbound.manage',
  'inventory.query.view', 'inventory.transaction.view', 'inventory.transfer.view',
  'report.view'
);

-- 销售员
INSERT INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r, sys_permission p
WHERE r.code = 'salesperson' AND p.code IN (
  'masterdata.item.view', 'masterdata.category.view', 'masterdata.bom.view',
  'masterdata.partner.view', 'masterdata.warehouse.view',
  'sales.order.view', 'sales.order.manage', 'sales.order.confirm',
  'sales.outbound.manage',
  'inventory.query.view', 'inventory.transaction.view',
  'report.view'
);

-- 仓管员
INSERT INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r, sys_permission p
WHERE r.code = 'warehouse_keeper' AND p.code IN (
  'masterdata.item.view', 'masterdata.category.view', 'masterdata.bom.view',
  'masterdata.partner.view', 'masterdata.warehouse.view',
  'purchase.order.view', 'purchase.inbound.manage',
  'sales.order.view', 'sales.outbound.manage',
  'inventory.query.view', 'inventory.transaction.view', 'inventory.status.manage',
  'inventory.transfer.view', 'inventory.transfer.manage',
  'inventory.stocktake.view', 'inventory.stocktake.manage',
  'inventory.alert.view', 'inventory.alert.manage',
  'report.view'
);

-- 系统参数默认值：港口仓默认不计入库存（在途到港）
INSERT INTO sys_param (key, value, description, updated_at) VALUES
  ('port_stock_as_inventory', 'false', '港口仓库存是否计入库存口径，默认 false（视为在途到港）',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));