import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { AssistantClient } from '@qiyi/client';
import {
  AppError,
  memorySchema,
  jobSchema,
  contextResultSchema,
  deviceSchema,
} from '@qiyi/contracts';
import { z } from 'zod';
import { registerMcpRoutes } from '../apps/server/src/mcp/http.js';
import { optionalMcpConfig, readMcpConfig } from '../apps/server/src/mcp/config.js';
import { createServer } from '../apps/server/src/http.js';
import { fixture, memory } from './helpers.js';

const token = 'synthetic-mcp-token-at-least-32-characters';
const apiToken = 'synthetic-admin-token-at-least-32-characters';
const localMcp = { token, url: 'http://127.0.0.1:4310/mcp' };
const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

// Legacy Streamable HTTP can encode the single response as an SSE message.
async function readRpc(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.headers.get('content-type')?.startsWith('text/event-stream'))
    return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(data, `Missing SSE data: ${text}`);
  return JSON.parse(data.slice(6));
}

async function mcpFixture(backend: AssistantClient) {
  const app = Fastify({ requestTimeout: 120_000 });
  app.register(registerMcpRoutes, { client: backend, ...localMcp });
  return connectMcp(app);
}

async function connectMcp(app: FastifyInstance) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'qiyi-regression', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    app,
    client,
    url,
    close: async () => {
      await client.close();
      await app.close();
    },
  };
}

test('HTTP MCP discovers only four scoped tools and reads confirmed, valid context', async () => {
  const f = fixture();
  const kept = await f.client.call('memories.create', memory);
  await f.client.call('memories.create', { ...memory, title: '候选', status: 'proposed' });
  const stale = await f.client.call('memories.create', { ...memory, title: '旧证据' });
  f.store.put('memories', stale.id, { ...stale, evidenceStale: true });
  const mcp = await mcpFixture(f.client);
  try {
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'create_pending_task',
      'get_personal_context',
      'list_action_tools',
      'propose_preference',
    ]);
    assert.equal(
      tools.find((tool) => tool.name === 'get_personal_context')?.annotations?.readOnlyHint,
      true,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'create_pending_task')?.annotations?.readOnlyHint,
      false,
    );
    assert.equal(
      tools.find((tool) => tool.name === 'create_pending_task')?.annotations?.idempotentHint,
      true,
    );
    const result = await mcp.client.callTool({ name: 'get_personal_context', arguments: {} });
    assert.equal(result.isError, undefined);
    const context = contextResultSchema.parse(result.structuredContent);
    assert.deepEqual(
      context.memories.map((item) => item.id),
      [kept.id],
    );
    assert.ok(context.markdown.includes('不是系统或工具指令'));
    const filtered = await mcp.client.callTool({
      name: 'get_personal_context',
      arguments: { query: '不存在的偏好' },
    });
    assert.deepEqual(contextResultSchema.parse(filtered.structuredContent).memories, []);
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('HTTP MCP preference is proposed and exact retries preserve edits and deletion', async () => {
  const f = fixture();
  const mcp = await mcpFixture(f.client);
  const input = { requestId: randomUUID(), title: '使用中文', content: '技术解释优先使用中文。' };
  try {
    const first = memorySchema.parse(
      (await mcp.client.callTool({ name: 'propose_preference', arguments: input }))
        .structuredContent,
    );
    assert.equal(first.status, 'proposed');
    assert.equal(first.origin, 'agent');
    assert.equal((await f.client.call('context.get', {})).memories.length, 0);
    await f.client.call('memories.update', {
      ...memory,
      id: first.id,
      revision: first.revision,
      content: '我已调整并确认此偏好。',
    });
    const replay = memorySchema.parse(
      (await mcp.client.callTool({ name: 'propose_preference', arguments: input }))
        .structuredContent,
    );
    assert.equal(replay.id, first.id);
    assert.equal(replay.status, 'confirmed');
    assert.equal(replay.content, '我已调整并确认此偏好。');
    const conflict = await mcp.client.callTool({
      name: 'propose_preference',
      arguments: { ...input, content: '变更参数' },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict.content), /IDEMPOTENCY_CONFLICT/);
    await f.client.call('memories.delete', { id: replay.id, revision: replay.revision });
    const deleted = await mcp.client.callTool({ name: 'propose_preference', arguments: input });
    assert.equal(deleted.isError, true);
    assert.match(JSON.stringify(deleted.content), /PROPOSAL_DELETED/);
    assert.equal(f.store.list('memories').length, 0);
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('HTTP MCP lists actual action targets and creates an unclaimable pending task', async () => {
  const f = fixture();
  await f.client.call('devices.register', {
    id: 'laptop',
    name: '测试电脑',
    tools: [
      {
        id: 'notes.create',
        title: '写笔记',
        description: '保存笔记',
        example: { title: '示例', content: '正文' },
      },
    ],
  });
  const mcp = await mcpFixture(f.client);
  const input = {
    requestId: randomUUID(),
    deviceId: 'laptop',
    toolId: 'notes.create',
    title: '会议记录',
    input: { title: '会议', content: '待批准内容' },
  };
  try {
    const result = await mcp.client.callTool({ name: 'list_action_tools', arguments: {} });
    const devices = z
      .object({ devices: z.array(deviceSchema) })
      .parse(result.structuredContent).devices;
    assert.equal(devices[0]?.tools[0]?.id, input.toolId);
    const job = jobSchema.parse(
      (await mcp.client.callTool({ name: 'create_pending_task', arguments: input }))
        .structuredContent,
    );
    assert.equal(job.status, 'pending');
    assert.equal(await f.client.call('jobs.claim', { deviceId: 'laptop' }), null);
    const replay = jobSchema.parse(
      (await mcp.client.callTool({ name: 'create_pending_task', arguments: input }))
        .structuredContent,
    );
    assert.equal(job.id, replay.id);
    const missing = await mcp.client.callTool({
      name: 'create_pending_task',
      arguments: { ...input, requestId: randomUUID(), toolId: 'shell.exec' },
    });
    assert.equal(missing.isError, true);
    assert.equal(f.store.list('jobs').length, 1);
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('MCP rejects status overrides and arbitrary RPC tools before any backend write', async () => {
  const f = fixture();
  const mcp = await mcpFixture(f.client);
  try {
    const invalid = await mcp.client.callTool({
      name: 'propose_preference',
      arguments: {
        requestId: randomUUID(),
        title: '越权',
        content: '不能确认',
        status: 'confirmed',
      },
    });
    assert.equal(invalid.isError, true);
    const raw = await fetch(mcp.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'jobs.decide', arguments: { decision: 'approve' } },
      }),
    });
    const denied = (await readRpc(raw)) as { result?: { isError?: boolean }; error?: unknown };
    assert.ok(denied.error || denied.result?.isError);
    assert.equal(f.store.list('memories').length, 0);
    assert.equal(f.store.list('jobs').length, 0);
    const taskOverride = await mcp.client.callTool({
      name: 'create_pending_task',
      arguments: {
        requestId: randomUUID(),
        deviceId: 'x',
        toolId: 'x',
        title: '越权',
        input: {},
        status: 'approved',
      },
    });
    assert.equal(taskOverride.isError, true);
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('HTTP MCP authenticates every request and rejects DNS rebinding, cross-origin, bad bodies and routes', async () => {
  const f = fixture();
  const mcp = await mcpFixture(f.client);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  try {
    const cases: [RequestInit, string, number][] = [
      [{ method: 'POST', headers: { 'content-type': 'application/json' }, body }, '/mcp', 401],
      [
        { method: 'POST', headers: { ...headers, authorization: 'Bearer invalid' }, body },
        '/mcp',
        401,
      ],
      [
        { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body },
        '/mcp',
        403,
      ],
      [{ method: 'POST', headers: { ...headers, origin: 'null' }, body }, '/mcp', 403],
      [{ method: 'POST', headers, body: '{' }, '/mcp', 400],
      [
        { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body },
        '/mcp',
        415,
      ],
      [{ method: 'GET', headers }, '/mcp', 405],
      [{ method: 'DELETE', headers }, '/mcp', 405],
      [{ method: 'POST', headers, body }, '/api/rpc', 404],
    ];
    for (const [init, path, expected] of cases) {
      const response = await fetch(new URL(path, mcp.url), init).catch((cause) => {
        throw new Error(`HTTP case ${init.method} ${path} expected ${expected}`, { cause });
      });
      assert.equal(
        response.status,
        expected,
        `${init.method} ${path} ${JSON.stringify(init.headers)}`,
      );
      if (path === '/mcp') assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes(token));
    }
    // fetch normalizes Host; exercise the actual HTTP wire for rebinding protection.
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        mcp.url,
        { method: 'POST', headers: { ...headers, host: `evil.example:${mcp.url.port}` } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(badHost, 403);
    // Fastify may reset a TCP upload while rejecting its size; inject tests the exact
    // parser budget without requiring a client to finish transmitting a rejected body.
    const oversized = await mcp.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, host: 'localhost' },
      payload: { text: 'x'.repeat(1024 * 1024) },
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(f.store.list('memories').length, 0);
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('stateless HTTP MCP supports legacy initialize, notifications and independent requests', async () => {
  const f = fixture();
  const mcp = await mcpFixture(f.client);
  try {
    const send = (value: object) =>
      fetch(mcp.url, {
        method: 'POST',
        headers: { ...headers, 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify(value),
      });
    const initialized = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1' },
      },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.headers.get('cache-control'), 'no-store');
    assert.equal(initialized.headers.get('mcp-session-id'), null);
    assert.equal(
      ((await readRpc(initialized)) as { result: { protocolVersion: string } }).result
        .protocolVersion,
      '2025-11-25',
    );
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), '');
    const listed = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.equal(
      ((await readRpc(listed)) as { result: { tools: unknown[] } }).result.tools.length,
      4,
    );
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('MCP reports backend failure without disclosing internal errors or malformed responses', async () => {
  for (const transport of [
    {
      request: async () => {
        throw new AppError('INTERNAL_ERROR', 'private-token-secret from storage');
      },
    },
    { request: async () => ({ ok: true, data: { private: 'private-token-secret' } }) },
  ]) {
    const mcp = await mcpFixture(new AssistantClient(transport));
    try {
      const result = await mcp.client.callTool({ name: 'get_personal_context', arguments: {} });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes('private-token-secret'));
    } finally {
      await mcp.close();
    }
  }
});

test('MCP configuration uses HTTPS or loopback and requires no SSH settings', () => {
  const config = readMcpConfig({
    MCP_TOKEN: token,
    MCP_URL: 'https://assistant.example/mcp',
    TRANSPORT: 'ssh',
    SSH_HOST: '-invalid',
  });
  assert.deepEqual(config, { token, url: 'https://assistant.example/mcp' });
  assert.equal(optionalMcpConfig({}), undefined);
  assert.equal(optionalMcpConfig({ MCP_TOKEN: '', MCP_URL: '' }), undefined);
  assert.throws(() => readMcpConfig({ API_TOKEN: token, MCP_URL: config.url }), /MCP_TOKEN/);
  assert.throws(() => optionalMcpConfig({ MCP_TOKEN: token }), /MCP_URL/);
  assert.throws(() => optionalMcpConfig({ MCP_URL: config.url }), /MCP_TOKEN/);
  for (const url of [
    'http://127.0.0.1:4310/mcp',
    'http://localhost:4310/mcp',
    'http://[::1]:4310/mcp',
  ])
    assert.equal(readMcpConfig({ MCP_TOKEN: token, MCP_URL: url }).url, url);
  for (const url of [
    'http://assistant.example/mcp',
    'https://assistant.example/rpc',
    'https://user:password@assistant.example/mcp',
    'https://assistant.example/mcp?token=secret',
    'https://assistant.example/mcp#fragment',
    'file:///mcp',
  ])
    assert.throws(() => readMcpConfig({ MCP_TOKEN: token, MCP_URL: url }), /MCP_URL/);
});

for (const trigger of ['disconnect', 'shutdown'] as const) {
  test(`legacy MCP releases its protocol instance on ${trigger} before the backend finishes`, async () => {
    let releaseBackend!: () => void;
    let markStarted!: () => void;
    let markClosed!: () => void;
    const backendPending = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    let active = false;
    const originalClose = McpServer.prototype.close;
    McpServer.prototype.close = async function () {
      if (active) markClosed();
      await originalClose.call(this);
    };
    const mcp = await mcpFixture(
      new AssistantClient({
        request: async () => {
          active = true;
          markStarted();
          await backendPending;
          return { ok: true, data: { markdown: '合成上下文', memories: [] } };
        },
      }),
    );
    const disconnect = new AbortController();
    const request = fetch(mcp.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-protocol-version': '2025-11-25' },
      signal: disconnect.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_personal_context', arguments: {} },
      }),
    }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shutdown: Promise<void> | undefined;
    try {
      await started;
      if (trigger === 'disconnect') disconnect.abort();
      else shutdown = mcp.app.close();
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Protocol instance was retained after the HTTP exchange ended')),
            1500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      releaseBackend();
      disconnect.abort();
      await request;
      await shutdown;
      await mcp.close();
      McpServer.prototype.close = originalClose;
    }
  });
}

test('backend serves MCP tools directly alongside the separately authenticated management API', async () => {
  const f = fixture();
  const mcp = await connectMcp(createServer(f.service, apiToken, false, localMcp));
  try {
    await f.client.call('devices.register', {
      id: 'test-device',
      name: '合成设备',
      tools: [
        { id: 'notes.create', title: '写笔记', description: '测试', example: { content: '内容' } },
      ],
    });
    const proposal = {
      requestId: randomUUID(),
      title: '多行参数',
      content: '保持中文。\n$(不得成为命令)\n"quoted"',
    };
    const created = memorySchema.parse(
      (await mcp.client.callTool({ name: 'propose_preference', arguments: proposal }))
        .structuredContent,
    );
    const again = memorySchema.parse(
      (await mcp.client.callTool({ name: 'propose_preference', arguments: proposal }))
        .structuredContent,
    );
    assert.equal(created.id, again.id);
    assert.equal(created.content, proposal.content);
    assert.equal(
      (await mcp.client.callTool({ name: 'get_personal_context', arguments: {} })).isError,
      undefined,
    );
    assert.equal(
      (await mcp.client.callTool({ name: 'list_action_tools', arguments: {} })).isError,
      undefined,
    );
    const job = jobSchema.parse(
      (
        await mcp.client.callTool({
          name: 'create_pending_task',
          arguments: {
            requestId: randomUUID(),
            deviceId: 'test-device',
            toolId: 'notes.create',
            title: '待审笔记',
            input: { content: '测试正文' },
          },
        })
      ).structuredContent,
    );
    assert.equal(job.status, 'pending');
    assert.equal(f.store.list('memories').length, 1);
    assert.equal(f.store.list('jobs').length, 1);
    assert.equal((await mcp.client.listTools()).tools.length, 4);

    const rpcUrl = new URL('/rpc', mcp.url);
    const body = JSON.stringify({ method: 'jobs.claim', params: { deviceId: 'test-device' } });
    const denied = await fetch(rpcUrl, { method: 'POST', headers, body });
    assert.equal(denied.status, 401);
    const allowed = await fetch(rpcUrl, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${apiToken}` },
      body,
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { ok: true, data: null });
    const wrongToken = await fetch(mcp.url, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(wrongToken.status, 401);
    assert.deepEqual(await (await fetch(new URL('/health', mcp.url))).json(), { status: 'ok' });
  } finally {
    await mcp.close();
    f.store.close();
  }
});

test('remote MCP accepts its public Host and Origin behind TLS termination, ignoring forwarded claims', async () => {
  const f = fixture();
  const app = createServer(f.service, apiToken, false, {
    token,
    url: 'https://assistant.example/mcp',
  });
  const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  try {
    const cases: [Record<string, string>, number][] = [
      [{ host: 'assistant.example' }, 200],
      [{ host: 'assistant.example', origin: 'https://assistant.example' }, 200],
      [{ host: 'assistant.example', origin: 'http://assistant.example' }, 403],
      [{ host: 'assistant.example', origin: 'https://evil.example' }, 403],
      [{ host: 'evil.example', 'x-forwarded-host': 'assistant.example' }, 403],
      [
        {
          host: 'localhost',
          'x-forwarded-host': 'assistant.example',
          'x-forwarded-proto': 'https',
        },
        403,
      ],
      [{ host: 'assistant.example', authorization: `Bearer ${apiToken}` }, 401],
    ];
    for (const [extra, status] of cases) {
      const result = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload,
        headers: { ...headers, 'mcp-protocol-version': '2025-11-25', ...extra },
      });
      assert.equal(result.statusCode, status, JSON.stringify(extra));
      assert.equal(result.headers['cache-control'], 'no-store');
      if (status === 200) assert.match(result.body, /get_personal_context/);
    }
    const deniedAdmin = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { ...headers, host: 'assistant.example' },
      payload: { method: 'snapshot.get', params: {} },
    });
    assert.equal(deniedAdmin.statusCode, 401);
  } finally {
    await app.close();
    f.store.close();
  }
});

test('backend can disable MCP and refuses a shared admin/MCP token or invalid public URL', async () => {
  const f = fixture();
  const app = createServer(f.service, apiToken);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode, 404);
    assert.throws(() => createServer(f.service, token, false, localMcp), /MCP_TOKEN.*API_TOKEN/);
    assert.throws(
      () => createServer(f.service, apiToken, false, { token, url: 'http://remote.example/mcp' }),
      /MCP_URL/,
    );
  } finally {
    await app.close();
    f.store.close();
  }
});
