import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantClient } from '@qiyi/client';
import { AssistantService } from '../apps/server/src/service.js';
import { Store, type Collections } from '../apps/server/src/store.js';
import { fixture, memory } from './helpers.js';

const preference = () => ({
  requestId: randomUUID(),
  title: '回答简洁',
  content: '偏好先给结论，再按需要补充解释。',
});
const device = {
  id: 'test-laptop',
  name: '测试设备',
  tools: [
    {
      id: 'notes.create',
      title: '创建笔记',
      description: '写入本机笔记目录',
      example: { text: '一条笔记' },
    },
  ],
};
const task = () => ({
  requestId: randomUUID(),
  deviceId: device.id,
  toolId: 'notes.create',
  title: '记录本次讨论',
  input: { text: '合成的测试笔记' },
});

test('agent preferences remain proposed and cannot replace an already confirmed memory', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const confirmed = await f.client.call('memories.create', memory);
  const proposed = await f.client.call('memories.propose', preference());

  assert.equal(proposed.category, 'preference');
  assert.equal(proposed.status, 'proposed');
  assert.equal(proposed.origin, 'agent');
  assert.equal(proposed.confidence, 0.5);
  assert.deepEqual(proposed.tags, []);
  assert.deepEqual(f.store.need('memories', confirmed.id), confirmed);
  const context = await f.client.call('context.get', {});
  assert.deepEqual(
    context.memories.map((item) => item.id),
    [confirmed.id],
  );
});

test('proposal contracts reject lifecycle overrides and invalid request IDs before writing', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  for (const field of ['status', 'category', 'origin', 'confidence']) {
    await assert.rejects(
      f.service.dispatch({
        method: 'memories.propose',
        params: { ...preference(), [field]: field === 'confidence' ? 1 : 'confirmed' },
      }),
      { name: 'ZodError' },
    );
  }
  for (const requestId of [undefined, 'not-a-uuid']) {
    await assert.rejects(
      f.service.dispatch({ method: 'memories.propose', params: { ...preference(), requestId } }),
      { name: 'ZodError' },
    );
    await assert.rejects(
      f.service.dispatch({ method: 'jobs.propose', params: { ...task(), requestId } }),
      { name: 'ZodError' },
    );
  }
  await assert.rejects(
    f.service.dispatch({
      method: 'jobs.propose',
      params: { ...task(), status: 'approved' },
    }),
    { name: 'ZodError' },
  );
  assert.equal(f.store.list('memories').length, 0);
  assert.equal(f.store.list('jobs').length, 0);
  assert.equal(f.store.list('agentRequests').length, 0);
});

test('preference retries normalize defaults, reject changed input, and retain human corrections', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const input = preference();
  const created = await f.client.call('memories.propose', input);
  const retry = await f.client.call('memories.propose', {
    ...input,
    title: ` ${input.title} `,
    tags: [],
  });
  assert.equal(retry.id, created.id);
  await assert.rejects(
    f.client.call('memories.propose', { ...input, content: '另一条不同的偏好' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );

  const corrected = await f.client.call('memories.update', {
    ...memory,
    id: created.id,
    revision: created.revision,
    content: '由用户修改并确认的内容',
    status: 'confirmed',
  });
  assert.deepEqual(await f.client.call('memories.propose', input), corrected);
  assert.equal(f.store.list('memories').length, 1);
  assert.deepEqual((await f.client.call('context.get', {})).memories, [corrected]);
});

test('device discovery only returns devices, and proposed jobs cannot be claimed', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const registered = await f.client.call('devices.register', device);
  await f.client.call('memories.create', memory);
  assert.deepEqual(await f.client.call('devices.list', {}), [registered]);

  const proposed = await f.client.call('jobs.propose', task());
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.startedAt, null);
  assert.equal(await f.client.call('jobs.claim', { deviceId: device.id }), null);
});

test('job retries ignore nested object key order and preserve edits and execution state without leaking tokens', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  await f.client.call('devices.register', device);
  const input = {
    ...task(),
    input: { text: '示例', options: { a: 1, b: [{ x: 1, y: 2 }] } },
  };
  const created = await f.client.call('jobs.propose', input);
  const reordered = {
    ...input,
    input: { options: { b: [{ y: 2, x: 1 }], a: 1 }, text: '示例' },
  };
  assert.equal((await f.client.call('jobs.propose', reordered)).id, created.id);
  await assert.rejects(f.client.call('jobs.propose', { ...input, input: { text: '不同任务' } }), {
    code: 'IDEMPOTENCY_CONFLICT',
  });

  const edited = await f.client.call('jobs.update', {
    id: created.id,
    revision: created.revision,
    deviceId: device.id,
    toolId: input.toolId,
    title: '用户修改后的任务',
    input: { text: '用户修改后的参数' },
  });
  assert.deepEqual(await f.client.call('jobs.propose', reordered), edited);
  const approved = await f.client.call('jobs.decide', {
    id: edited.id,
    revision: edited.revision,
    decision: 'approve',
  });
  assert.deepEqual(await f.client.call('jobs.propose', input), approved);
  const claimed = await f.client.call('jobs.claim', { deviceId: device.id });
  assert.ok(claimed?.claimToken);
  const repeated = await f.client.call('jobs.propose', input);
  assert.equal(repeated.status, 'running');
  assert.equal(Object.hasOwn(repeated, 'claimToken'), false);
  assert.equal(f.store.list('jobs').length, 1);
});

test('failed target validation does not consume a job request ID', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const input = task();
  await assert.rejects(f.client.call('jobs.propose', input), { code: 'NOT_FOUND' });
  await f.client.call('devices.register', { ...device, tools: [] });
  await assert.rejects(f.client.call('jobs.propose', input), { code: 'TOOL_NOT_AVAILABLE' });
  assert.equal(f.store.list('jobs').length, 0);
  assert.equal(f.store.list('agentRequests').length, 0);

  await f.client.call('devices.register', device);
  assert.equal((await f.client.call('jobs.propose', input)).status, 'pending');
  assert.equal(f.store.list('agentRequests').length, 1);
});

test('proposal creation and its retry receipt are committed atomically', async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  const input = preference();
  const put = f.store.put.bind(f.store);
  f.store.put = <K extends keyof Collections>(kind: K, id: string, value: Collections[K]) => {
    if (kind === 'agentRequests') throw new Error('simulated receipt write failure');
    return put(kind, id, value);
  };

  await assert.rejects(f.client.call('memories.propose', input), /receipt write failure/);
  assert.equal(f.store.list('memories').length, 0);
  assert.equal(f.store.list('agentRequests').length, 0);
  f.store.put = put;
  assert.equal((await f.client.call('memories.propose', input)).status, 'proposed');
});

test('receipts persist across restarts, are operation scoped, and never resurrect deleted proposals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-proposal-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const connect = () => {
    const service = new AssistantService(store);
    return new AssistantClient({
      request: async (method, params) => ({
        ok: true,
        data: await service.dispatch({ method, params }),
      }),
    });
  };
  try {
    let client = connect();
    const preferenceInput = preference();
    const jobInput = { ...task(), requestId: preferenceInput.requestId };
    const proposed = await client.call('memories.propose', preferenceInput);
    await client.call('devices.register', device);
    const job = await client.call('jobs.propose', jobInput);
    store.close();
    store = new Store(path);
    client = connect();

    assert.deepEqual(await client.call('memories.propose', preferenceInput), proposed);
    assert.deepEqual(await client.call('jobs.propose', jobInput), job);
    await client.call('memories.delete', { id: proposed.id, revision: proposed.revision });
    await client.call('jobs.delete', { id: job.id, revision: job.revision });
    store.close();
    store = new Store(path);
    client = connect();

    await assert.rejects(client.call('memories.propose', preferenceInput), {
      code: 'PROPOSAL_DELETED',
    });
    await assert.rejects(client.call('jobs.propose', jobInput), { code: 'PROPOSAL_DELETED' });
    assert.equal(store.list('memories').length, 0);
    assert.equal(store.list('jobs').length, 0);
    assert.equal(store.list('agentRequests').length, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
});
