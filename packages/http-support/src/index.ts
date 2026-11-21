import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@qiyi/contracts';

export function installErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError && error.status >= 500)
      request.log.error({ err: error }, 'API contract failure');
    if (error instanceof AppError)
      return reply
        .code(error.status)
        .send({ ok: false, error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues
            .map((issue) => `${issue.path.join('.') || '请求'}: ${issue.message}`)
            .join('; '),
        },
      });
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (status === 413)
      return reply.code(413).send({
        ok: false,
        error: { code: 'BODY_TOO_LARGE', message: '请求超过 4 MiB，请拆分批次' },
      });
    request.log.error({ err: error }, 'Request failed');
    return reply
      .code(status >= 400 && status < 500 ? status : 500)
      .send({ ok: false, error: { code: 'REQUEST_FAILED', message: '请求失败，请检查服务日志' } });
  });
}
