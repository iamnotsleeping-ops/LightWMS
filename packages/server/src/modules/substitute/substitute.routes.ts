import {
  idParamSchema,
  PERMISSIONS,
  substituteRelationBodySchema,
  substituteRelationQuerySchema,
  substituteRelationUpdateBodySchema,
  substitutionPlanQuerySchema,
} from '@light-erp/shared';
import type { FastifyInstance } from 'fastify';
import { ok, okPage } from '../../lib/response';
import {
  createSubstitute,
  deleteSubstitute,
  listSubstitutes,
  planForQuery,
  updateSubstitute,
} from './substitute.service';

/**
 * 替代关系主数据接口。
 *
 * 查看与维护分权：`masterdata.substitute.view` 供规划页面「看建议」，
 * `masterdata.substitute.manage` 才是改配置；两者都不等于「替代料出库」
 * （那是 `sales.outbound.substitute`，由销售模块单独校验）。
 */
export function registerSubstituteRoutes(app: FastifyInstance): void {
  const view = { preHandler: app.requirePermission(PERMISSIONS.masterdataSubstituteView) };
  const manage = { preHandler: app.requirePermission(PERMISSIONS.masterdataSubstituteManage) };

  app.get('/api/masterdata/substitutes', view, async (request) => {
    const query = substituteRelationQuerySchema.parse(request.query);
    const { list, page } = listSubstitutes(query);
    return okPage(list, page);
  });

  // 必须早于任何 `/:id` 路由声明，否则 'plan' 会先被当成 id 匹配而 400/404
  app.get('/api/masterdata/substitutes/plan', view, async (request) => {
    const query = substitutionPlanQuerySchema.parse(request.query);
    return ok(planForQuery(query));
  });

  app.post('/api/masterdata/substitutes', manage, async (request) => {
    const body = substituteRelationBodySchema.parse(request.body);
    return ok(createSubstitute(body, request.user.sub));
  });

  app.patch('/api/masterdata/substitutes/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const body = substituteRelationUpdateBodySchema.parse(request.body);
    return ok(updateSubstitute(id, body));
  });

  app.delete('/api/masterdata/substitutes/:id', manage, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(deleteSubstitute(id));
  });
}
