import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistantClient } from '@qiyi/client';
import {
  AdapterRuntime,
  type ActionAdapter,
  type Collector,
  type ReportConflict,
} from '@qiyi/adapters';
import { createAdapterRuntime } from '@qiyi/adapters/node';
import { fixture, source } from './helpers.js';

for (const terminal of ['expired', 'deleted', 'invalid-claim'] as const) {
  test(`a ${terminal} completion report releases collection and future work without rerunning the action`, async () => {
    const f = fixture();
    let offline = false;
    let executions = 0;
    let collections = 0;
    const reports: ReportConflict[] = [];
    const action: ActionAdapter = {
      info: { id: 'test.action', title: 'Test', description: 'Synthetic', example: {} },
      execute: async () => {
        executions++;
        return 'side effect completed';
      },
    };
    const collector: Collector = {
      sourceId: source.id,
      kind: source.kind,
      async *collect() {
        collections++;
        yield [];
      },
    };
    const client = new AssistantClient({
      request: async (method, params) => {
        if (method === 'jobs.finish' && offline) throw new Error('offline before delivery');
        return { ok: true, data: await f.service.dispatch({ method, params }) };
      },
    });
    const runtime = new AdapterRuntime(
      client,
      { deviceId: 'device', pollIntervalMs: 5000 },
      {
        actions: [action],
        collectors: [collector],
        onReportConflict: async (report) => {
          reports.push(report);
        },
      },
    );
    const enqueue = async () => {
      const job = await client.call('jobs.create', {
        deviceId: 'device',
        toolId: action.info.id,
        title: 'Synthetic',
        input: {},
      });
      await client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
      return job;
    };
    try {
      await client.call('sources.create', source);
      await runtime.sync();
      const first = await enqueue();
      offline = true;
      await assert.rejects(runtime.sync(), /offline/);
      await assert.rejects(runtime.sync(), /offline/);
      assert.equal(executions, 1);
      f.store.put('jobs', first.id, {
        ...f.store.need('jobs', first.id),
        startedAt: '2020-01-01T00:00:00Z',
      });
      f.service.snapshot();
      if (terminal === 'deleted') {
        const expired = f.store.need('jobs', first.id);
        await client.call('jobs.delete', { id: first.id, revision: expired.revision });
      }
      if (terminal === 'invalid-claim')
        f.store.put('jobs', first.id, {
          ...f.store.need('jobs', first.id),
          claimToken: 'replacement-token',
        });
      const second = await enqueue();
      const before = collections;
      offline = false;
      await runtime.sync();
      assert.equal(collections, before + 1);
      assert.equal(executions, 2);
      assert.equal(f.store.need('jobs', second.id).status, 'succeeded');
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.jobId, first.id);
      assert.equal(reports[0]!.output, 'side effect completed');
      assert.equal('claimToken' in reports[0]!, false);
      assert.deepEqual(runtime.status().reportConflicts, reports);
      await runtime.sync();
      assert.equal(executions, 2);
      assert.equal(reports.length, 1);
    } finally {
      await runtime.stop();
      f.store.close();
    }
  });
}

test('the Node host archives a terminal report before releasing the queue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-report-'));
  const f = fixture();
  let offline = false;
  const action: ActionAdapter = {
    info: { id: 'test.action', title: 'Test', description: 'Test', example: {} },
    execute: async () => 'completed',
  };
  const client = new AssistantClient({
    request: async (method, params) => {
      if (method === 'jobs.finish' && offline) throw new Error('offline');
      return { ok: true, data: await f.service.dispatch({ method, params }) };
    },
  });
  const runtime = createAdapterRuntime(
    client,
    {
      deviceId: 'device',
      pollIntervalMs: 5000,
      outputDirectory: directory,
      collectors: [],
      commands: [],
    },
    { actions: [action] },
  );
  try {
    await runtime.sync();
    const job = await client.call('jobs.create', {
      deviceId: 'device',
      toolId: action.info.id,
      title: 'Test',
      input: {},
    });
    await client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
    offline = true;
    await assert.rejects(runtime.sync(), /offline/);
    f.store.put('jobs', job.id, {
      ...f.store.need('jobs', job.id),
      startedAt: '2020-01-01T00:00:00Z',
    });
    f.service.snapshot();
    offline = false;
    await runtime.sync();
    const archived = JSON.parse(
      await readFile(join(directory, 'report-conflicts', `${job.id}.json`), 'utf8'),
    );
    assert.equal(archived.jobId, job.id);
    assert.equal(archived.output, 'completed');
    assert.equal(archived.code, 'INVALID_JOB_STATE');
    assert.equal(archived.claimToken, undefined);
  } finally {
    await runtime.stop();
    f.store.close();
    await rm(directory, { recursive: true });
  }
});

test('diagnostic persistence failures keep the report available for retry', async () => {
  const f = fixture();
  let executions = 0;
  let archiveFails = true;
  let finishFails = true;
  const action: ActionAdapter = {
    info: { id: 'test.action', title: 'Test', description: 'Test', example: {} },
    execute: async () => {
      executions++;
      return 'done';
    },
  };
  const client = new AssistantClient({
    request: async (method, params) => {
      if (method === 'jobs.finish' && finishFails) throw new Error('offline');
      return { ok: true, data: await f.service.dispatch({ method, params }) };
    },
  });
  const runtime = new AdapterRuntime(
    client,
    { deviceId: 'device', pollIntervalMs: 5000 },
    {
      actions: [action],
      onReportConflict: async () => {
        if (archiveFails) throw new Error('disk full');
      },
    },
  );
  try {
    await runtime.sync();
    const job = await client.call('jobs.create', {
      deviceId: 'device',
      toolId: action.info.id,
      title: 'Test',
      input: {},
    });
    await client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
    await assert.rejects(runtime.sync(), /offline/);
    f.store.put('jobs', job.id, {
      ...f.store.need('jobs', job.id),
      startedAt: '2020-01-01T00:00:00Z',
    });
    f.service.snapshot();
    finishFails = false;
    await assert.rejects(runtime.sync(), /disk full/);
    archiveFails = false;
    await runtime.sync();
    assert.equal(runtime.status().reportConflicts.length, 1);
    assert.equal(executions, 1);
  } finally {
    await runtime.stop();
    f.store.close();
  }
});
