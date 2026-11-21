import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, truncate, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantClient } from '@qiyi/client';
import { AdapterRuntime, createImportRegistry, type ImportParser } from '@qiyi/adapters';
import { JsonlCollector, createAdapterRuntime } from '@qiyi/adapters/node';
import type { RpcHandlers, Memory } from '@qiyi/contracts';
import { createServer } from '../apps/server/src/http.js';
import { AssistantContext, type AssistantState } from '../apps/web/src/state.js';
import { Sources } from '../apps/web/src/pages/Sources.js';
import { fixture, source, observation, memory } from './helpers.js';

// Typecheck is part of the test command's parent gate. A result mismatch must be rejected.
// @ts-expect-error Handler return values are bound to the corresponding RPC result schema.
const invalidHandler: RpcHandlers['sources.list'] = () => 'wrong shape';
void invalidHandler;

const customParser: ImportParser = {
  id: 'reader-events',
  title: 'Reader events',
  parse: (input) => ({
    observations: input.trim() ? [observation('reader-1', JSON.parse(input).text)] : [],
    ignored: 0,
  }),
};

test('a custom parser and collector work through the unchanged server and report actual registrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-plugin-'));
  const f = fixture();
  const registry = createImportRegistry([customParser]);
  const customSource = { ...source, id: 'reader', kind: customParser.id };
  const path = join(directory, 'reader.jsonl');
  await writeFile(path, '{"text":"I prefer long reading sessions"}\n');
  const runtime = createAdapterRuntime(
    f.client,
    {
      deviceId: 'reader-device',
      outputDirectory: directory,
      pollIntervalMs: 5000,
      collectors: [{ sourceId: customSource.id, format: customParser.id, path }],
      commands: [],
    },
    { formats: registry },
  );
  try {
    await f.client.call('sources.create', customSource);
    await runtime.sync();
    assert.equal(f.store.list('observations')[0]!.content, 'I prefer long reading sessions');
    assert.deepEqual(runtime.status().collectors, [
      { sourceId: 'reader', format: 'reader-events' },
    ]);
    const injected = new AdapterRuntime(
      f.client,
      { deviceId: 'injected-device', pollIntervalMs: 5000 },
      {
        collectors: [
          {
            sourceId: 'reader',
            kind: customParser.id,
            async *collect() {
              yield [observation('reader-2', 'second')];
            },
          },
        ],
      },
    );
    try {
      assert.deepEqual(injected.status().collectors, [
        { sourceId: 'reader', format: 'reader-events' },
      ]);
      await injected.sync();
      assert.equal(f.store.list('observations').length, 2);
    } finally {
      await injected.stop();
    }
    const state: AssistantState = {
      snapshot: f.service.snapshot(),
      local: null,
      busy: false,
      navigate() {},
      mutate: async () => false,
      notify() {},
      confirm() {},
      refresh: async () => {},
    };
    const markup = renderToStaticMarkup(
      createElement(AssistantContext.Provider, { value: state }, createElement(Sources)),
    );
    assert.match(markup, /reader-events/);
    assert.match(markup, /由适配器上传/);
  } finally {
    await runtime.stop();
    f.store.close();
    await rm(directory, { recursive: true });
  }
});

test('registries reject unknown or duplicate formats and invalid plugin output at the boundary', () => {
  const formats = createImportRegistry([customParser]);
  assert.throws(() => formats.parse('unknown', '{}'), /未注册/);
  assert.throws(() => createImportRegistry([customParser, customParser]), /重复/);
  assert.throws(() => createImportRegistry([{ ...customParser, id: 'manual' }]), /保留/);
  assert.throws(() => new JsonlCollector('source', '/synthetic', 'unknown'), /未注册/);
  assert.throws(
    () =>
      createImportRegistry([
        { ...customParser, parse: () => ({ observations: [], ignored: -1 }) },
      ]).parse(customParser.id, ''),
    /忽略数量/,
  );
  assert.throws(() =>
    createImportRegistry([
      {
        ...customParser,
        parse: () => ({
          observations: [{ ...observation(), role: 'system' as never }],
          ignored: 0,
        }),
      },
    ]).parse(customParser.id, ''),
  );
});

test('malformed and oversized files do not starve healthy files, and repaired files retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-isolated-files-'));
  const broken = join(directory, 'a-broken.jsonl');
  const large = join(directory, 'b-large.jsonl');
  const healthy = join(directory, 'z-healthy.jsonl');
  const row = (id: string) =>
    JSON.stringify({ id, role: 'user', content: 'healthy', timestamp: '2026-11-12T00:00:00Z' }) +
    '\n';
  const collector = new JsonlCollector('source', directory, 'chat-jsonl');
  try {
    await writeFile(broken, 'broken\n');
    await writeFile(large, '');
    await truncate(large, 20 * 1024 * 1024 + 1);
    await writeFile(healthy, row('healthy'));
    const first: string[] = [];
    await assert.rejects(
      async () => {
        for await (const batch of collector.collect()) {
          first.push(...batch.observations.map((item) => item.identity!.messageId));
          await batch.acknowledge();
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /a-broken.jsonl/);
        assert.match(error.message, /b-large.jsonl/);
        return true;
      },
    );
    assert.deepEqual(first, ['healthy']);
    await writeFile(healthy, row('healthy') + row('new'));
    const second: string[] = [];
    await assert.rejects(async () => {
      for await (const batch of collector.collect()) {
        second.push(...batch.observations.map((item) => item.identity!.messageId));
        await batch.acknowledge();
      }
    });
    assert.deepEqual(second, ['healthy', 'new']);
    await writeFile(broken, row('repaired'));
    await rm(large);
    const repaired: string[] = [];
    for await (const batch of collector.collect()) {
      repaired.push(...batch.observations.map((item) => item.identity!.messageId));
      await batch.acknowledge();
    }
    assert.deepEqual(repaired, ['repaired']);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('clients reject incompatible success payloads and tolerate additive fields', async () => {
  const invalid = new AssistantClient({ request: async () => ({ ok: true, data: { items: [] } }) });
  await assert.rejects(invalid.call('sources.list', {}), { code: 'INVALID_RESPONSE' });
  const f = fixture();
  try {
    const profile = f.service.snapshot().profile;
    const compatible = new AssistantClient({
      request: async () => ({ ok: true, data: { ...profile, futureField: 'ignored' } }),
    });
    assert.deepEqual(await compatible.call('profile.update', { ...profile }), profile);
    const missing = new AssistantClient({
      request: async () => ({ ok: true, data: { ...profile, revision: undefined } }),
    });
    await assert.rejects(missing.call('profile.update', { ...profile }), {
      code: 'INVALID_RESPONSE',
    });
  } finally {
    f.store.close();
  }
});

test('server response validation reports implementation drift as a server contract failure', async () => {
  const f = fixture();
  const token = 'synthetic-token-at-least-32-characters';
  const app = createServer(f.service, token);
  try {
    const created = await f.client.call('memories.create', memory);
    // Simulate incompatible persisted data, not a malformed user request.
    f.store.put('memories', created.id, { ...created, content: undefined } as unknown as Memory);
    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${token}` },
      payload: { method: 'snapshot.get', params: {} },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'INVALID_RESPONSE');
    assert.doesNotMatch(response.body, /ZodError|stack|synthetic-token/);
  } finally {
    await app.close();
    f.store.close();
  }
});

test('server rejection of a file does not acknowledge it or starve other files and actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-upload-isolation-'));
  const f = fixture();
  let uploads = 0;
  let executions = 0;
  const client = new AssistantClient({
    request: async (method, params) => {
      if (method === 'observations.import') uploads++;
      return { ok: true, data: await f.service.dispatch({ method, params }) };
    },
  });
  const badFile = join(directory, 'a-ambiguous.jsonl');
  const row = (id: string, conversationId?: string) =>
    JSON.stringify({
      id,
      conversationId,
      role: 'user',
      content: 'synthetic',
      timestamp: '2026-11-12T00:00:00Z',
    }) + '\n';
  const action = {
    info: { id: 'test.action', title: 'Test', description: 'Synthetic', example: {} },
    execute: async () => {
      executions++;
      return 'done';
    },
  };
  const runtime = new AdapterRuntime(
    client,
    { deviceId: 'device', pollIntervalMs: 5000 },
    {
      collectors: [new JsonlCollector(source.id, directory, 'chat-jsonl')],
      actions: [action],
    },
  );
  try {
    await client.call('sources.create', source);
    await client.call('observations.import', {
      sourceId: source.id,
      observations: [{ ...observation('a:b:c'), metadata: { conversationId: 'a' } }],
    });
    const previous = f.store.list('observations')[0]!;
    await client.call('observations.update', {
      id: previous.id,
      revision: previous.revision,
      kind: previous.kind,
      role: previous.role,
      content: 'hand-edited',
      occurredAt: previous.occurredAt,
      metadata: previous.metadata,
    });
    await client.call('devices.register', { id: 'device', name: 'Test', tools: [action.info] });
    const job = await client.call('jobs.create', {
      deviceId: 'device',
      toolId: action.info.id,
      title: 'Test',
      input: {},
    });
    await client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
    await writeFile(badFile, row('c', 'a:b'));
    await writeFile(join(directory, 'z-healthy.jsonl'), row('healthy'));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(runtime.sync(), /a-ambiguous.jsonl/);
      assert.equal(f.store.list('observations').length, 2);
    }
    assert.equal(executions, 1);
    const beforeRepair = uploads;
    await writeFile(badFile, row('repaired'));
    await runtime.sync();
    assert.equal(uploads, beforeRepair + 1);
    assert.equal(f.store.list('observations').length, 3);
    await runtime.sync();
    assert.equal(uploads, beforeRepair + 1);
  } finally {
    await runtime.stop();
    f.store.close();
    await rm(directory, { recursive: true });
  }
});
