import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { AppError, parseRpcRequest } from '@qiyi/contracts';
import type { Transport } from '@qiyi/client';
import type { AdapterRuntime } from '@qiyi/adapters/node';
import { installErrors } from '@qiyi/http-support';

type BridgeOptions = {
  port: number;
  transport: Transport;
  runtime: AdapterRuntime;
  mode: string;
  staticRoot?: string;
  logger?: boolean;
};

export async function createBridge(options: BridgeOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 4 * 1024 * 1024,
    requestTimeout: 120_000,
  });
  installErrors(app);
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  const origins = new Set(
    [...hosts]
      .map((host) => `http://${host}`)
      .concat(['http://127.0.0.1:5173', 'http://localhost:5173']),
  );
  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(request.headers.host ?? ''))
      throw new AppError('INVALID_HOST', '只允许本机访问', 403);
    if (request.headers.origin && !origins.has(request.headers.origin))
      throw new AppError('INVALID_ORIGIN', '不允许跨站访问本机桥接服务', 403);
    if (
      request.method === 'POST' &&
      !request.headers['content-type']?.startsWith('application/json')
    )
      throw new AppError('INVALID_CONTENT_TYPE', '请使用 application/json', 415);
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.post('/api/rpc', async (request) => {
    const { method, params } = parseRpcRequest(request.body);
    return options.transport.request(method, params);
  });
  app.get('/api/local/status', async () => ({
    ...options.runtime.status(),
    transport: options.mode,
  }));
  app.post('/api/local/sync', async () => {
    await options.runtime.sync();
    return { ok: true, data: options.runtime.status() };
  });
  if (options.staticRoot) {
    await app.register(staticFiles, { root: options.staticRoot, prefix: '/', index: 'index.html' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/'))
        return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('onClose', async () => {
    await options.runtime.stop();
  });
  return app;
}
