import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, memory, observation, source } from './helpers.js';
import { Store } from '../apps/server/src/store.js';
import type { Extraction } from '../apps/server/src/extractor.js';

test('manual memory edits use optimistic concurrency and persist across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-db-'));
  const path = join(directory, 'test.sqlite');
  const store = new Store(path);
  const profile = store.need('profile', 'owner');
  store.put('profile', 'owner', { ...profile, name: '本地测试用户' });
  store.close();
  const reopened = new Store(path);
  assert.equal(reopened.need('profile', 'owner').name, '本地测试用户');
  reopened.close();
  await rm(directory, { recursive: true });

  const f = fixture();
  try {
    const created = await f.client.call('memories.create', memory);
    await f.client.call('memories.update', {
      ...memory,
      id: created.id,
      revision: 1,
      content: '更新后的偏好',
    });
    await assert.rejects(
      f.client.call('memories.update', { ...memory, id: created.id, revision: 1 }),
      { code: 'CONFLICT' },
    );
    assert.equal(f.store.need('memories', created.id).content, '更新后的偏好');
  } finally {
    f.store.close();
  }
});

test('imports are idempotent, manual edits survive reimport, deleted records never resurrect', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    const first = await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    assert.equal(first.created, 1);
    assert.equal(
      (
        await f.client.call('observations.import', {
          sourceId: source.id,
          observations: [observation()],
        })
      ).skipped,
      1,
    );
    const record = f.store.list('observations')[0]!;
    const { externalId: _, ...input } = observation('message-1', '我手工改正了原始内容');
    const edited = await f.client.call('observations.update', {
      ...input,
      id: record.id,
      revision: record.revision,
    });
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation('message-1', '来自采集端的不同内容')],
    });
    assert.equal(f.store.need('observations', record.id).content, input.content);
    await f.client.call('observations.delete', { id: record.id, revision: edited.revision });
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation('message-1', '新一次采集仍不能复活')],
    });
    assert.equal(f.store.list('observations').length, 0);
  } finally {
    f.store.close();
  }
});

test('import batch validation is atomic and paused sources reject ingestion', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    await assert.rejects(
      f.service.dispatch({
        method: 'observations.import',
        params: {
          sourceId: source.id,
          observations: [observation(), { ...observation('bad'), content: '' }],
        },
      }),
    );
    assert.equal(f.store.list('observations').length, 0);
    await f.client.call('sources.update', { ...source, enabled: false, revision: 1 });
    await assert.rejects(
      f.client.call('observations.import', { sourceId: source.id, observations: [observation()] }),
      { code: 'SOURCE_DISABLED' },
    );
    await assert.rejects(f.service.dispatch({ method: '__proto__', params: {} }), {
      code: 'METHOD_NOT_FOUND',
    });
  } finally {
    f.store.close();
  }
});

test('AI proposals require review, never overwrite a manual fact, and only user evidence is sent', async () => {
  let seen = 0;
  const f = fixture({
    model: 'test-model',
    async extract(items) {
      seen = items.length;
      assert.ok(items.every((item) => item.role !== 'assistant'));
      return {
        memories: [{ ...memory, status: undefined, evidenceIds: [items[0]!.id] }].map(
          ({ status: _, ...item }) => item,
        ),
      };
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation(), { ...observation('assistant'), role: 'assistant' }],
    });
    await f.client.call('memories.create', { ...memory, content: '用户明确指定的内容' });
    const run = await f.client.call('analysis.run', {});
    assert.equal(run.proposed, 1);
    assert.equal(seen, 1);
    const all = f.store.list('memories');
    assert.ok(
      all.some((item) => item.content === '用户明确指定的内容' && item.status === 'confirmed'),
    );
    assert.ok(all.some((item) => item.status === 'proposed' && item.origin === 'ai'));
    const context = await f.client.call('context.get', {});
    assert.equal(context.memories.length, 1);
    assert.match(context.markdown, /用户明确指定/);
    await assert.rejects(f.client.call('analysis.run', {}), { code: 'NOTHING_TO_ANALYZE' });
  } finally {
    f.store.close();
  }
});

test('invalid AI evidence does not partially write memories or mark input as analyzed', async () => {
  const { status: _, ...candidate } = memory;
  const f = fixture({
    model: 'bad-model',
    async extract(items) {
      return {
        memories: [
          { ...candidate, evidenceIds: [items[0]!.id] },
          { ...candidate, title: '错误证据', evidenceIds: ['invented'] },
        ],
      };
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    await assert.rejects(f.client.call('analysis.run', {}), { code: 'MODEL_INVALID_EVIDENCE' });
    assert.equal(f.store.list('memories').length, 0);
    assert.equal(f.store.list('observations')[0]!.analyzedHash, null);
    assert.equal(f.store.list('analysis')[0]!.status, 'failed');
  } finally {
    f.store.close();
  }
});

test('automatic analysis failure pauses persistently instead of repeatedly calling a paid model', async () => {
  let requests = 0;
  let shouldFail = true;
  const f = fixture({
    model: 'test',
    async extract() {
      requests++;
      if (shouldFail) throw new Error('provider down');
      return { memories: [] };
    },
  });
  try {
    await f.client.call('sources.create', { ...source, autoAnalyze: true });
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    await assert.rejects(f.service.analysis.run(undefined, true), /provider down/);
    assert.ok(f.service.snapshot().system.automaticAnalysisPause);
    await assert.rejects(f.service.analysis.run(undefined, true), {
      code: 'AUTOMATIC_ANALYSIS_PAUSED',
    });
    assert.equal(requests, 1);
    assert.ok(f.store.get('runtime', 'analysis')?.automaticAnalysisPause);
    shouldFail = false;
    await f.client.call('analysis.run', {});
    assert.equal(f.service.snapshot().system.automaticAnalysisPause, null);
  } finally {
    f.store.close();
  }
});

test('concurrent evidence edits invalidate an in-flight extraction', async () => {
  let release!: (result: Extraction) => void;
  const f = fixture({
    model: 'slow-model',
    extract: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    const record = f.store.list('observations')[0]!;
    const pending = f.client.call('analysis.run', {});
    const { externalId: _, ...edited } = observation('message-1', '内容已经改变');
    await f.client.call('observations.update', { ...edited, id: record.id, revision: 1 });
    const { status: __, ...candidate } = memory;
    release({ memories: [{ ...candidate, evidenceIds: [record.id] }] });
    await assert.rejects(pending, { code: 'ANALYSIS_STALE' });
    assert.equal(f.store.list('memories').length, 0);
  } finally {
    f.store.close();
  }
});

test('deleting a source invalidates confirmed evidence and suppresses automatic resurrection', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    const original = f.store.list('observations')[0]!;
    const fact = await f.client.call('memories.create', memory);
    f.store.put('memories', fact.id, { ...fact, evidenceIds: [original.id] });
    await f.client.call('sources.delete', { id: source.id, revision: 1 });
    assert.equal(f.store.list('observations').length, 0);
    assert.equal(f.store.need('memories', fact.id).evidenceStale, true);
    assert.equal((await f.client.call('context.get', {})).memories.length, 0);
    await f.client.call('sources.create', source);
    assert.equal(
      (
        await f.client.call('observations.import', {
          sourceId: source.id,
          observations: [observation()],
        })
      ).skipped,
      1,
    );
  } finally {
    f.store.close();
  }
});

test('AI disabled is explicit, and context supports relevance filtering', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.client.call('analysis.run', {}), { code: 'AI_NOT_CONFIGURED' });
    await f.client.call('memories.create', memory);
    await f.client.call('memories.create', {
      ...memory,
      title: '晚间阅读',
      content: '睡前阅读',
      category: 'habit',
    });
    assert.equal((await f.client.call('context.get', { query: '沟通' })).memories.length, 2);
    assert.equal((await f.client.call('context.get', { query: '晚间' })).memories.length, 1);
    assert.equal((await f.client.call('context.get', { query: '不存在' })).memories.length, 0);
  } finally {
    f.store.close();
  }
});

test('jobs require approval, claim atomically, protect their token and finish idempotently', async () => {
  const f = fixture();
  try {
    await f.client.call('devices.register', {
      id: 'laptop',
      name: 'Laptop',
      tools: [{ id: 'notes.create', title: '笔记', description: '保存笔记', example: {} }],
    });
    const job = await f.client.call('jobs.create', {
      deviceId: 'laptop',
      toolId: 'notes.create',
      title: '测试笔记',
      input: { title: '一条笔记', content: '内容' },
    });
    assert.equal(await f.client.call('jobs.claim', { deviceId: 'laptop' }), null);
    await f.client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
    const [first, second] = await Promise.all([
      f.client.call('jobs.claim', { deviceId: 'laptop' }),
      f.client.call('jobs.claim', { deviceId: 'laptop' }),
    ]);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal('claimToken' in f.service.snapshot().jobs[0]!, false);
    assert.equal('claimToken' in (await f.client.call('data.export', {})).jobs[0]!, false);
    await assert.rejects(
      f.client.call('jobs.finish', {
        id: job.id,
        claimToken: 'wrong',
        success: true,
        output: 'ok',
      }),
      { code: 'INVALID_CLAIM' },
    );
    const params = { id: job.id, claimToken: first.claimToken, success: true, output: 'ok' };
    const finished = await f.client.call('jobs.finish', params);
    assert.deepEqual(await f.client.call('jobs.finish', params), finished);
    assert.equal(finished.status, 'succeeded');
  } finally {
    f.store.close();
  }
});

test('crashed worker tasks become uncertain failures instead of being re-executed', async () => {
  const f = fixture();
  try {
    await f.client.call('devices.register', {
      id: 'laptop',
      name: 'Laptop',
      tools: [{ id: 'test', title: 'Test', description: 'Test tool', example: {} }],
    });
    const job = await f.client.call('jobs.create', {
      deviceId: 'laptop',
      toolId: 'test',
      title: '任务',
      input: {},
    });
    await f.client.call('jobs.decide', { id: job.id, revision: 1, decision: 'approve' });
    const claim = await f.client.call('jobs.claim', { deviceId: 'laptop' });
    assert.ok(claim);
    f.store.put('jobs', job.id, { ...claim, startedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(await f.client.call('jobs.claim', { deviceId: 'laptop' }), null);
    assert.equal(f.store.need('jobs', job.id).status, 'failed');
    assert.match(f.store.need('jobs', job.id).error!, /结果未知/);
  } finally {
    f.store.close();
  }
});
