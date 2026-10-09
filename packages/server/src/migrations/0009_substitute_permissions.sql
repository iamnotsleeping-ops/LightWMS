-- ============================================================
-- 0009_substitute_permissions.sql · 替代料权限码补种（P10）
--
-- 为什么必须单独补种：`0002_rbac_seed.sql` 里
--   · sys_admin 的全量权限是「当时 sys_permission 的全集」快照；
--   · viewer 靠 `p.code LIKE '%.view'` 拿全部 view 权限。
-- 两者都是**执行时快照**，新增权限码不会被自动带上；而且 `setRolePermissions`
-- 现已禁止改写 sys_admin 的权限集，因此**迁移是扩展 sys_admin 的唯一通路**。
--
-- 授权口径（与 0002 的设计意图保持一致）：
--   · masterdata.substitute.view    → 所有已持有 masterdata.item.view 的角色
--     （即 viewer 与三个业务角色；沿用「viewer 拥有全部 view 权限」的语义）
--   · masterdata.substitute.manage  → 仅 sys_admin（与其它 masterdata.*.manage 一致）
--   · sales.outbound.substitute     → 已持有 sales.outbound.manage 的角色
--     （salesperson / warehouse_keeper）。该权限单列的意义是让运维可以按角色
--     单独**收回**「用替代料出库」的能力，而不影响其正常出库；
--     内置角色默认保留，避免升级后原有出库能力被削弱。
-- ============================================================

INSERT INTO sys_permission (code, name, module) VALUES
  ('masterdata.substitute.view',   '查看替代关系', 'masterdata'),
  ('masterdata.substitute.manage', '维护替代关系', 'masterdata'),
  ('sales.outbound.substitute',    '替代料出库',   'sales');

-- sys_admin：新增权限全给（迁移是唯一通路）
INSERT OR IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM sys_role r, sys_permission p
 WHERE r.code = 'sys_admin'
   AND p.code IN (
     'masterdata.substitute.view', 'masterdata.substitute.manage', 'sales.outbound.substitute'
   );

-- 查看：跟随 masterdata.item.view 的既有持有者
INSERT OR IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM sys_role r, sys_permission p
 WHERE p.code = 'masterdata.substitute.view'
   AND EXISTS (
     SELECT 1 FROM sys_role_permission rp
       JOIN sys_permission ip ON ip.id = rp.permission_id
      WHERE rp.role_id = r.id AND ip.code = 'masterdata.item.view'
   );

-- 替代料出库：跟随 sales.outbound.manage 的既有持有者
INSERT OR IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM sys_role r, sys_permission p
 WHERE p.code = 'sales.outbound.substitute'
   AND EXISTS (
     SELECT 1 FROM sys_role_permission rp
       JOIN sys_permission ip ON ip.id = rp.permission_id
      WHERE rp.role_id = r.id AND ip.code = 'sales.outbound.manage'
   );
