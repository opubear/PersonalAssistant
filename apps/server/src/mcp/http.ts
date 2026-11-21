import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AssistantClient } from '@qiyi/client';
import { createAssistantMcp } from './tools.js';
import { isLoopbackHttp, mcpTokenSchema, parseMcpUrl, type McpConfig } from './config.js';

/** Register inside an encapsulated Fastify plugin so /rpc keeps its own authentication. */
export async function registerMcpRoutes(
  app: FastifyInstance,
  options: McpConfig & {
    client: AssistantClient;
  },
) {
  const token = Buffer.from(mcpTokenSchema.parse(options.token));
  const endpoint = new URL(parseMcpUrl(options.url));
  const handler = createMcpHandler(() => createAssistantMcp(options.client), {
    // Tools are fixed and need no long-lived subscription streams.
    maxSubscriptions: 0,
    maxRequestBodySize: 1024 * 1024,
  });
  const exchanges = new Set<AbortController>();

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const port = request.raw.socket.localPort;
    const hosts = isLoopbackHttp(endpoint)
      ? new Set(
          ['127.0.0.1', 'localhost', '[::1]'].map((host) => (port ? `${host}:${port}` : host)),
        )
      : new Set([endpoint.host]);
    // The HTTPS proxy preserves Host. Forwarded headers are never an authority source.
    const host = request.headers.host?.toLowerCase() ?? '';
    if (!hosts.has(host)) return reply.code(403).send(httpError('Invalid Host'));
    const origin = request.headers.origin;
    const origins = isLoopbackHttp(endpoint)
      ? [...hosts].map((allowed) => `http://${allowed}`)
      : [endpoint.origin];
    if (origin !== undefined && !origins.includes(origin))
      return reply.code(403).send(httpError('Invalid Origin'));
    const authorization = request.headers.authorization ?? '';
    const candidate = Buffer.from(
      authorization.startsWith('Bearer ') ? authorization.slice(7) : '',
    );
    if (candidate.length !== token.length || !timingSafeEqual(candidate, token))
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="qiyi-mcp"')
        .send(httpError('Unauthorized'));
    if (request.url !== '/mcp') return reply.code(404).send(httpError('Not found'));
    // Stateless tools have no GET notification stream or DELETE session endpoint.
    if (request.method !== 'POST')
      return reply.code(405).header('Allow', 'POST').send(httpError('Method not allowed'));
  });

  app.route({
    url: '/mcp',
    method: ['POST', 'GET', 'HEAD', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
    bodyLimit: 1024 * 1024,
    handler: async (request, reply) => {
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json'))
        return reply.code(415).send(httpError('Content-Type must be application/json'));
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (['authorization', 'content-length', 'transfer-encoding', 'connection'].includes(key))
          continue;
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const exchange = new AbortController();
      const disconnected = () => {
        if (!reply.raw.writableFinished) exchange.abort();
      };
      exchanges.add(exchange);
      reply.raw.on('close', disconnected);
      if (reply.raw.destroyed) exchange.abort();
      try {
        const response = await handler.fetch(
          new Request(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(request.body),
            signal: exchange.signal,
          }),
        );
        for (const [name, value] of response.headers)
          if (name !== 'cache-control') reply.header(name, value);
        return reply
          .code(response.status)
          .send(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
      } catch (error) {
        if (!exchange.signal.aborted) throw error;
        // Release the HTTP exchange. An already accepted write can still finish;
        // its outcome must be recovered with the same proposal requestId.
        reply.hijack();
        reply.raw.destroy();
        return reply;
      } finally {
        exchanges.delete(exchange);
        reply.raw.off('close', disconnected);
      }
    },
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    if (status >= 500) app.log.error({ code: 'MCP_HTTP_ERROR' }, 'MCP request failed');
    return reply
      .code(status)
      .send(httpError(status >= 500 ? 'Internal server error' : 'Invalid request'));
  });
  app.addHook('preClose', async () => {
    for (const exchange of exchanges) exchange.abort();
    await handler.close();
  });
}

function httpError(message: string) {
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null };
}
