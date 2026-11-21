import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Device, Job, ToolInfo } from '@qiyi/contracts';
import { AssistantContext, type AssistantState } from '../apps/web/src/state.js';
import { JobEditor } from '../apps/web/src/pages/JobEditor.js';
import { fixture } from './helpers.js';

const retiredTool: ToolInfo = {
  id: 'retired.tool',
  title: '旧工具',
  description: '用于下线兼容测试',
  example: { text: '旧参数' },
};
const replacementTool: ToolInfo = {
  id: 'replacement.tool',
  title: '替代工具',
  description: '需要用户主动选择',
  example: { text: '新参数' },
};
const device = { id: 'laptop', name: '测试设备', tools: [retiredTool] };
const jobInput = {
  deviceId: device.id,
  toolId: retiredTool.id,
  title: '保留原目标的任务',
  input: { text: '用户输入' },
};

test('approved jobs remain cancellable and removable after their tool is retired', async () => {
  const f = fixture();
  try {
    await f.client.call('devices.register', device);
    const job = await f.client.call('jobs.create', jobInput);
    const approved = await f.client.call('jobs.decide', {
      id: job.id,
      revision: job.revision,
      decision: 'approve',
    });
    await f.client.call('devices.register', { ...device, tools: [] });
    assert.equal(await f.client.call('jobs.claim', { deviceId: device.id }), null);
    await assert.rejects(
      f.client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'cancel' }),
      { code: 'CONFLICT' },
    );
    const cancelled = await f.client.call('jobs.decide', {
      id: job.id,
      revision: approved.revision,
      decision: 'cancel',
    });
    assert.equal(cancelled.status, 'cancelled');
    await f.client.call('jobs.delete', { id: job.id, revision: cancelled.revision });
    await f.client.call('devices.delete', { id: device.id });
    assert.equal(f.store.list('jobs').length, 0);
    assert.equal(f.store.list('devices').length, 0);
  } finally {
    f.store.close();
  }
});

test('retired targets cannot be approved or saved, but a pending job can be retargeted', async () => {
  const f = fixture();
  try {
    await f.client.call('devices.register', device);
    const job = await f.client.call('jobs.create', jobInput);
    await f.client.call('devices.register', { ...device, tools: [replacementTool] });
    await assert.rejects(
      f.client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' }),
      { code: 'TOOL_NOT_AVAILABLE' },
    );
    await assert.rejects(
      f.client.call('jobs.update', { ...jobInput, id: job.id, revision: job.revision }),
      { code: 'TOOL_NOT_AVAILABLE' },
    );
    assert.equal(f.store.need('jobs', job.id).revision, job.revision);
    const changed = await f.client.call('jobs.update', {
      ...jobInput,
      id: job.id,
      revision: job.revision,
      toolId: replacementTool.id,
    });
    const approved = await f.client.call('jobs.decide', {
      id: job.id,
      revision: changed.revision,
      decision: 'approve',
    });
    assert.equal(approved.toolId, replacementTool.id);
    assert.equal(approved.status, 'approved');
  } finally {
    f.store.close();
  }
});

test('cancellation still rejects running and terminal jobs after a tool is retired', async () => {
  const f = fixture();
  try {
    await f.client.call('devices.register', device);
    const job = await f.client.call('jobs.create', jobInput);
    await f.client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'approve' });
    const claimed = await f.client.call('jobs.claim', { deviceId: device.id });
    assert.ok(claimed);
    await f.client.call('devices.register', { ...device, tools: [] });
    await assert.rejects(
      f.client.call('jobs.decide', { id: job.id, revision: claimed.revision, decision: 'cancel' }),
      { code: 'INVALID_JOB_STATE' },
    );
    const finished = await f.client.call('jobs.finish', {
      id: job.id,
      claimToken: claimed.claimToken,
      success: true,
      output: '完成',
    });
    await assert.rejects(
      f.client.call('jobs.decide', { id: job.id, revision: finished.revision, decision: 'cancel' }),
      { code: 'INVALID_JOB_STATE' },
    );
  } finally {
    f.store.close();
  }
});

const pendingJob: Job = {
  ...jobInput,
  id: 'job-one',
  revision: 1,
  status: 'pending',
  result: null,
  error: null,
  createdAt: '2026-11-12T08:00:00.000Z',
  updatedAt: '2026-11-12T08:00:00.000Z',
  startedAt: null,
};

function renderEditor(devices: Device[], job?: Job): string {
  const f = fixture();
  try {
    const state: AssistantState = {
      snapshot: { ...f.service.snapshot(), devices },
      local: null,
      busy: false,
      navigate() {},
      mutate: async () => false,
      notify() {},
      confirm() {},
      refresh: async () => {},
    };
    return renderToStaticMarkup(
      createElement(
        AssistantContext.Provider,
        { value: state },
        createElement(JobEditor, { job, onClose() {} }),
      ),
    );
  } finally {
    f.store.close();
  }
}

function selectedValues(markup: string): string[] {
  return [...markup.matchAll(/<option([^>]*)>/g)]
    .filter((match) => match[1]!.includes('selected='))
    .map((match) => /value="([^"]*)"/.exec(match[1]!)![1]!);
}

test('the real job editor renders empty or removed devices without losing the old target', () => {
  const emptyDevice = { ...device, tools: [], lastSeenAt: pendingJob.updatedAt };
  for (const devices of [[emptyDevice], []]) {
    const markup = renderEditor(devices, pendingJob);
    assert.deepEqual(selectedValues(markup), [device.id, retiredTool.id]);
    assert.match(markup, /已下线：retired\.tool/);
    assert.match(markup, /所选工具已不可用/);
    assert.match(markup, /取消任务/);
    assert.match(markup, /<button[^>]*disabled=""[^>]*>保存修改<\/button>/);
    assert.match(markup, /用户输入/);
  }
});

test('the job editor does not silently choose another registered tool for an old job', () => {
  const markup = renderEditor(
    [{ ...device, tools: [replacementTool], lastSeenAt: pendingJob.updatedAt }],
    pendingJob,
  );
  assert.deepEqual(selectedValues(markup), [device.id, retiredTool.id]);
  assert.match(markup, /value="replacement\.tool"/);
  assert.match(markup, /替代工具/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>保存修改<\/button>/);
});

test('the editor reflects current availability and tolerates an empty new-job registry', () => {
  const online = renderEditor([{ ...device, lastSeenAt: pendingJob.updatedAt }], pendingJob);
  const offline = renderEditor(
    [{ ...device, tools: [], lastSeenAt: pendingJob.updatedAt }],
    pendingJob,
  );
  assert.doesNotMatch(online, /所选工具已不可用/);
  assert.match(online, /<button class="button primary">保存修改<\/button>/);
  assert.match(offline, /所选工具已不可用/);
  const empty = renderEditor([]);
  assert.match(empty, /暂无可用设备/);
  assert.match(empty, /<button[^>]*disabled=""[^>]*>创建待批准任务<\/button>/);
});
