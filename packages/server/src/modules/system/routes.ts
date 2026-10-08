import {
  idParamSchema,
  PERMISSIONS,
  roleBodySchema,
  rolePermissionBodySchema,
  roleUpdateBodySchema,
  userCreateBodySchema,
  userQuerySchema,
  userRoleBodySchema,
  userUpdateBodySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { ok, okPage } from '../../lib/response';
import {
  createRole,
  createUser,
  deleteRole,
  listParams,
  listPermissions,
  listRoles,
  listUsers,
  setRolePermissions,
  setUserRoles,
  updateRole,
  updateUser,
} from './service';

export function registerSystemRoutes(app: FastifyInstance): void {
  // ---------- 用户 ----------
  app.get(
    '/api/system/users',
    { preHandler: app.requirePermission(PERMISSIONS.systemUserView) },
    async (request) => {
      const query = userQuerySchema.parse(request.query);
      const { list, total } = listUsers(query);
      return okPage(list, { page: query.page, pageSize: query.pageSize, total });
    },
  );

  app.post(
    '/api/system/users',
    { preHandler: app.requirePermission(PERMISSIONS.systemUserManage) },
    async (request) => ok({ id: createUser(userCreateBodySchema.parse(request.body)) }),
  );

  app.patch(
    '/api/system/users/:id',
    { preHandler: app.requirePermission(PERMISSIONS.systemUserManage) },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      updateUser(id, userUpdateBodySchema.parse(request.body));
      return ok({ id });
    },
  );

  app.put(
    '/api/system/users/:id/roles',
    { preHandler: app.requirePermission(PERMISSIONS.systemUserManage) },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = userRoleBodySchema.parse(request.body);
      setUserRoles(id, body.roleIds);
      return ok({ id });
    },
  );

  // ---------- 角色与权限 ----------
  app.get(
    '/api/system/permissions',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleView) },
    async () => ok(listPermissions()),
  );

  app.get(
    '/api/system/roles',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleView) },
    async () => ok(listRoles()),
  );

  app.post(
    '/api/system/roles',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleManage) },
    async (request) => ok({ id: createRole(roleBodySchema.parse(request.body)) }),
  );

  app.patch(
    '/api/system/roles/:id',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleManage) },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      updateRole(id, roleUpdateBodySchema.parse(request.body));
      return ok({ id });
    },
  );

  app.delete(
    '/api/system/roles/:id',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleManage) },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      deleteRole(id);
      return ok({ id });
    },
  );

  app.put(
    '/api/system/roles/:id/permissions',
    { preHandler: app.requirePermission(PERMISSIONS.systemRoleManage) },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const body = rolePermissionBodySchema.parse(request.body);
      setRolePermissions(id, body.permissionIds);
      return ok({ id });
    },
  );

  // ---------- 系统参数（只读） ----------
  app.get(
    '/api/system/params',
    { preHandler: app.requirePermission(PERMISSIONS.systemParamView) },
    async () => ok(listParams()),
  );
}