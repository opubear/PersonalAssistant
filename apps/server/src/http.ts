import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { installErrors } from '@qiyi/http-support';
import { AppError } from '@qiyi/contracts';
import type { AssistantService } from './service.js';
import { AssistantClient } from '@qiyi/client';
import { registerMcpRoutes } from './mcp/http.js';
import { readMcpConfig, type McpConfig } from './mcp/config.js';

export function createServer(
  service: AssistantService,
  token: string,
  logger = false,
  mcp?: McpConfig,
): FastifyInstance {
  if (token.length < 32 || token.startsWith('replace-with-'))
    throw new Error('API_TOKEN 必须是至少 32 字符的随机密钥，请运行 npm run setup');
  if (mcp) {
    readMcpConfig({ MCP_TOKEN: mcp.token, MCP_URL: mcp.url });
    if (mcp.token === token) throw new Error('MCP_TOKEN 必须与管理 API_TOKEN 不同');
  }
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization'] } : false,
    // A manually selected image may be 20 MiB before base64 encoding.
    bodyLimit: 32 * 1024 * 1024,
    requestTimeout: 120_000,
  });
  installErrors(app);
  const expected = Buffer.from(`Bearer ${token}`);
  app.get('/health', async () => ({ status: 'ok' }));
  app.post(
    '/rpc',
    {
      preHandler: async (request) => {
        const provided = Buffer.from(request.headers.authorization ?? '');
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
          throw new AppError('UNAUTHORIZED', '无效 API 凭证', 401);
      },
    },
    async (request) => ({ ok: true, data: await service.dispatch(request.body) }),
  );
  if (mcp) {
    const client = new AssistantClient({
      request: async (method, params) => ({
        ok: true,
        data: await service.dispatch({ method, params }),
      }),
    });
    app.register(registerMcpRoutes, { ...mcp, client });
  }
  return app;
}
