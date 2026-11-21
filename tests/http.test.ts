import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { AssistantClient, HttpTransport } from '@qiyi/client';
import { AdapterRuntime } from '@qiyi/adapters/node';
import { fixture } from './helpers.js';
import { createServer } from '../apps/server/src/http.js';
import { createBridge } from '../apps/bridge/src/http.js';
import { CompatibleExtractor } from '../apps/server/src/extractor.js';

const token = 'test-token-at-least-32-characters-long';

test('HTTP transport does not bind native browser fetch to its class instance', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async function (this: unknown) {
      assert.ok(
        this === undefined || this === globalThis,
        'native fetch must not receive the transport as its receiver',
      );
      return Response.json({ ok: true, data: 'works' });
    };
    const result = await new HttpTransport('http://localhost/rpc').request('snapshot.get', {});
    assert.deepEqual(result, { ok: true, data: 'works' });
  } finally {
    globalThis.fetch = original;
  }
});

test('backend requires authentication and validates unknown methods', async () => {
  const f = fixture();
  const app = createServer(f.service, token);
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { method: 'snapshot.get', params: {} },
    });
    assert.equal(denied.statusCode, 401);
    const accepted = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${token}` },
      payload: { method: 'snapshot.get', params: {} },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().data.system.aiConfigured, false);
    const invalid = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${token}` },
      payload: { method: 'process.exec', params: { command: 'bad' } },
    });
    assert.equal(invalid.statusCode, 404);
  } finally {
    await app.close();
    f.store.close();
  }
});

test('bridge blocks cross-origin requests and DNS rebinding hosts', async () => {
  const f = fixture();
  const runtime = new AdapterRuntime(f.client, {
    deviceId: 'bridge-test',
    pollIntervalMs: 5000,
  });
  const app = await createBridge({
    port: 4311,
    mode: 'http',
    runtime,
    transport: {
      request: async (method, params) => ({
        ok: true,
        data: await f.service.dispatch({ method, params }),
      }),
    },
  });
  try {
    const payload = { method: 'snapshot.get', params: {} };
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { host: '127.0.0.1:4311', origin: 'https://evil.example' },
      payload,
    });
    assert.equal(badOrigin.statusCode, 403);
    const badHost = await app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { host: 'evil.example:4311' },
      payload,
    });
    assert.equal(badHost.statusCode, 403);
    const good = await app.inject({
      method: 'POST',
      url: '/api/rpc',
      headers: { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:5173' },
      payload,
    });
    assert.equal(good.statusCode, 200);
    assert.equal(good.json().ok, true);
    assert.equal(good.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
    f.store.close();
  }
});

test('real gateway process forwards stdin JSON to a live loopback backend', async () => {
  const f = fixture();
  const app = createServer(f.service, token);
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new AssistantClient(
      new HttpTransport(`http://127.0.0.1:${address.port}/rpc`, token),
    );
    const before = await client.call('snapshot.get', {});
    assert.equal(before.system.version, '0.1.0');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--conditions=qiyi-source', '--import', 'tsx', 'apps/server/src/gateway.ts'],
        {
          env: {
            ...process.env,
            ENV_FILE: '/nonexistent/qiyi.env',
            API_TOKEN: token,
            SERVER_PORT: String(address.port),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      child.stdin.end(
        JSON.stringify({
          method: 'profile.update',
          params: {
            name: '网关用户',
            bio: '经 stdin 传输',
            locale: 'zh-CN',
            timezone: 'Asia/Shanghai',
            revision: 1,
          },
        }),
      );
    });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal((await client.call('snapshot.get', {})).profile.name, '网关用户');
  } finally {
    await app.close();
    f.store.close();
  }
});

test('compatible model integration validates JSON, evidence and completion status', async () => {
  let requestBody: Record<string, unknown> = {};
  const fetcher = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: '{"memories":[]}' } }],
    });
  }) as typeof fetch;
  const extractor = new CompatibleExtractor(
    { baseUrl: 'http://localhost:1234/v1', model: 'local-test' },
    fetcher,
  );
  assert.deepEqual(await extractor.extract([]), { memories: [] });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.model, 'local-test');
  const bad = new CompatibleExtractor(
    { baseUrl: 'http://localhost:1234/v1', model: 'bad' },
    (async () =>
      Response.json({
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
      })) as typeof fetch,
  );
  await assert.rejects(bad.extract([]), { code: 'MODEL_INCOMPLETE' });
  const invalid = new CompatibleExtractor(
    { baseUrl: 'http://localhost:1234/v1', model: 'bad' },
    (async () =>
      Response.json({
        choices: [{ finish_reason: 'stop', message: { content: 'not json' } }],
      })) as typeof fetch,
  );
  await assert.rejects(invalid.extract([]), { code: 'MODEL_INVALID_JSON' });
  const httpError = new CompatibleExtractor(
    { baseUrl: 'http://localhost:1234/v1', model: 'bad' },
    (async () => new Response('secret upstream body', { status: 401 })) as typeof fetch,
  );
  await assert.rejects(httpError.extract([]), { code: 'MODEL_HTTP_ERROR' });
  assert.throws(
    () => new CompatibleExtractor({ baseUrl: 'http://remote.example/v1', model: 'unsafe' }),
    /HTTPS/,
  );
});

test('production static hosting serves assets and SPA routes while preserving request and path boundaries', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'qiyi-static-'));
  const f = fixture();
  const runtime = new AdapterRuntime(f.client, { deviceId: 'static-test', pollIntervalMs: 5000 });
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Synthetic app</title>');
  await writeFile(join(root, 'assets/app.js'), 'export const synthetic = true;');
  const app = await createBridge({
    port: 4311,
    mode: 'http',
    runtime,
    transport: {
      request: async (method, params) => ({
        ok: true,
        data: await f.service.dispatch({ method, params }),
      }),
    },
    staticRoot: root,
  });
  try {
    for (const url of ['/', '/index.html', '/preferences']) {
      const response = await app.inject({ url, headers: { host: '127.0.0.1:4311' } });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /Synthetic app/);
      assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
    }
    const asset = await app.inject({ url: '/assets/app.js', headers: { host: '127.0.0.1:4311' } });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /synthetic/);
    // inject() and fetch() normalize dot segments before transmission; use a raw HTTP path.
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const { request } = await import('node:http');
    for (const path of ['/assets/../index.html', '/assets/%2E%2E/index.html']) {
      const denied = await new Promise<{ status: number | undefined; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port: address.port,
              path,
              headers: { host: '127.0.0.1:4311' },
            },
            (response) => {
              let body = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => {
                body += chunk;
              });
              response.on('end', () => resolve({ status: response.statusCode, body }));
              response.on('error', reject);
            },
          );
          req.on('error', reject);
          req.end();
        },
      );
      assert.equal(denied.status, 403);
      assert.doesNotMatch(denied.body, /Synthetic app/);
    }
    const badHost = await app.inject({ url: '/', headers: { host: 'evil.example:4311' } });
    assert.equal(badHost.statusCode, 403);
    const badOrigin = await app.inject({
      url: '/assets/app.js',
      headers: { host: '127.0.0.1:4311', origin: 'https://evil.example' },
    });
    assert.equal(badOrigin.statusCode, 403);
    const unknownApi = await app.inject({
      url: '/api/missing',
      headers: { host: '127.0.0.1:4311' },
    });
    assert.equal(unknownApi.statusCode, 404);
  } finally {
    await app.close();
    f.store.close();
    await rm(root, { recursive: true });
  }
});
