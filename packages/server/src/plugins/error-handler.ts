import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** 统一响应信封：成功 code=0，失败 code 取 HTTP 状态码 */
export function registerErrorHandler(app: FastifyInstance): void {
  // Fastify 5 默认把 error 推断为 unknown，须显式指定泛型
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        code: 400,
        message: '参数校验失败',
        data: null,
        _warnings: error.issues.map((issue) => ({
          code: 'INVALID_PARAM',
          field: issue.path.join('.'),
          message: issue.message,
          dropped_rows: null,
        })),
      });
      return;
    }

    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      app.log.error(error);
    }
    reply.status(status).send({
      code: status,
      message: status >= 500 ? '服务器内部错误' : error.message,
      data: null,
      _warnings: [],
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ code: 404, message: '接口不存在', data: null, _warnings: [] });
  });
}