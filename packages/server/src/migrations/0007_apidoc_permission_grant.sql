-- ============================================================
-- 0007_apidoc_permission_grant.sql · 让 system.apidoc.view 不再是死权限码
--
-- 背景：`system.apidoc.view`（查看数据接口）自 0002 播种以来没有任何使用点——
-- 后端无路由挂它，前端 `/system/api-docs` 的路由与菜单也未声明权限，任何已登录用户
-- 都能访问，属「配置存在但无效」。
--
-- 处理：前端路由与菜单已改为按该权限码裁剪，本迁移把它授予**全部已存在角色**，
-- 从而保持「所有可登录角色都能查看接口文档」的既有行为不变（不收紧权限），
-- 同时让该权限码真正生效、可由管理员按角色收放。
-- 迁移之后新建的自定义角色默认不具备该权限，需管理员显式授予。
-- ============================================================

INSERT OR IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM sys_role r, sys_permission p
 WHERE p.code = 'system.apidoc.view';
