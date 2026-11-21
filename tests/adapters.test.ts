import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistantClient } from '@qiyi/client';
import { parseImport, type ActionAdapter } from '@qiyi/adapters';
import { AdapterRuntime, JsonlCollector, builtInActions, commandAction } from '@qiyi/adapters/node';
import { runJsonProcess, sshArguments } from '@qiyi/client/node';
import { fixture, source } from './helpers.js';

test('Codex import excludes instructions, tool results, reasoning and duplicate event messages', () => {
  const timestamp = '2026-11-12T08:00:00Z';
  const rows = [
    { type: 'session_meta', payload: { id: 'session-a', base_instructions: 'INTERNAL' } },
    {
      type: 'response_item',
      ordinal: 1,
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'SECRET_SYSTEM' }],
      },
    },
    {
      type: 'response_item',
      ordinal: 2,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '我喜欢 TypeScript' }],
      },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: '我喜欢 TypeScript' } },
    {
      type: 'response_item',
      ordinal: 4,
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '收到' }],
      },
    },
    { type: 'response_item', payload: { type: 'reasoning', summary: 'PRIVATE_REASONING' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'PRIVATE_TOOL' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>metadata</environment_context>' },
        ],
      },
    },
  ]
    .map((row) => JSON.stringify({ timestamp, ...row }))
    .join('\n');
  const parsed = parseImport('codex', rows);
  assert.equal(parsed.observations.length, 2);
  assert.equal(parsed.observations[0]!.externalId, 'session-a:2');
  assert.deepEqual(
    parsed.observations.map((item) => item.content),
    ['我喜欢 TypeScript', '收到'],
  );
  assert.equal(parsed.ignored, 6);
});

test('legacy Codex user_message events and generic app events have stable IDs', () => {
  const legacy = parseImport(
    'codex',
    JSON.stringify({
      timestamp: '2026-11-12T08:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '周末喜欢徒步' },
    }),
    'legacy',
  );
  assert.equal(legacy.observations[0]!.externalId, 'legacy:1');
  const app = parseImport(
    'app-jsonl',
    JSON.stringify({
      id: 'event-1',
      app: 'Reader',
      activity: '阅读技术文章',
      timestamp: '2026-11-12T08:00:00Z',
      durationSeconds: 1200,
    }),
  );
  assert.equal(app.observations[0]!.metadata.durationSeconds, 1200);
  assert.equal(app.observations[0]!.role, 'event');
  assert.throws(() => parseImport('chat-jsonl', '{}\nnot-json'), /第 2 行不是有效 JSON/);
  assert.throws(
    () =>
      parseImport(
        'chat-jsonl',
        JSON.stringify({ id: 'bad', role: 'system', timestamp: 'not-a-time', content: 'wrong' }),
      ),
    /数据无效/,
  );
});

test('file collector waits for complete lines and retries unacknowledged batches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-collector-'));
  try {
    const path = join(directory, 'chat.jsonl');
    const line = JSON.stringify({
      id: 'one',
      role: 'user',
      timestamp: '2026-11-12T08:00:00Z',
      content: '偏好早晨工作',
    });
    await writeFile(path, line);
    const collector = new JsonlCollector('chat', path, 'chat-jsonl');
    const first: unknown[] = [];
    for await (const batch of collector.collect()) {
      first.push(...batch.observations);
      await batch.acknowledge();
    }
    assert.equal(first.length, 0);
    await appendFile(path, '\n');
    await assert.rejects(async () => {
      for await (const _batch of collector.collect()) throw new Error('upload failed');
    }, /upload failed/);
    const retry: unknown[] = [];
    for await (const batch of collector.collect()) {
      retry.push(...batch.observations);
      await batch.acknowledge();
    }
    assert.equal(retry.length, 1);
    const unchanged: unknown[] = [];
    for await (const batch of collector.collect()) {
      unchanged.push(...batch.observations);
      await batch.acknowledge();
    }
    assert.equal(unchanged.length, 0);
    await symlink(path, join(directory, 'linked.jsonl'));
    const linkCollector = new JsonlCollector('chat', join(directory, 'linked.jsonl'), 'chat-jsonl');
    await assert.rejects(async () => {
      for await (const _batch of linkCollector.collect()) {
        /* consume */
      }
    }, /符号链接/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('SSH options are fixed and request content only travels through stdin', async () => {
  const args = sshArguments({
    host: 'alice@example.com',
    command: '/opt/qiyi/bin/gateway',
    port: 2222,
    identityFile: '/some path/key',
  });
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-1), '/opt/qiyi/bin/gateway');
  assert.ok(args.includes('/some path/key'));
  assert.throws(() => sshArguments({ host: '-oProxyCommand=touch /tmp/no', command: 'gateway' }));
  const input = { content: '$(touch /tmp/qiyi-never-run); `echo unsafe` " quotes\n换行' };
  const output = await runJsonProcess(
    process.execPath,
    [
      '-e',
      'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(s));',
    ],
    input,
    5000,
  );
  assert.deepEqual(output, input);
  await assert.rejects(
    runJsonProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {}, 30),
    { code: 'SSH_TIMEOUT' },
  );
});

test('runtime reports a lost completion again without rerunning the action', async () => {
  const f = fixture();
  let executions = 0;
  let loseFirstReply = true;
  const action: ActionAdapter = {
    info: { id: 'test.action', title: 'Test', description: 'Test action', example: {} },
    execute: async () => {
      executions++;
      return 'done';
    },
  };
  const client = new AssistantClient({
    request: async (method, params) => {
      const data = await f.service.dispatch({ method, params });
      if (method === 'jobs.finish' && loseFirstReply) {
        loseFirstReply = false;
        throw new Error('connection lost after commit');
      }
      return { ok: true, data };
    },
  });
  const runtime = new AdapterRuntime(
    client,
    {
      deviceId: 'test-device',
      pollIntervalMs: 5000,
    },
    { actions: [action], collectors: [] },
  );
  try {
    await runtime.sync();
    const job = await client.call('jobs.create', {
      deviceId: 'test-device',
      toolId: action.info.id,
      title: '一次执行',
      input: {},
    });
    await client.call('jobs.decide', { id: job.id, revision: 1, decision: 'approve' });
    await assert.rejects(runtime.sync(), /connection lost/);
    assert.equal(executions, 1);
    await Promise.all([runtime.sync(), runtime.sync()]);
    assert.equal(executions, 1);
    assert.equal(f.store.need('jobs', job.id).status, 'succeeded');
  } finally {
    await runtime.stop();
    f.store.close();
  }
});

test('built-in note tool writes an idempotent file and rejects path traversal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-action-'));
  const f = fixture();
  try {
    const note = builtInActions(directory).find((action) => action.info.id === 'notes.create')!;
    const context = { jobId: 'safe-id', client: f.client };
    const input = { title: '../../not-a-path', content: '正文' };
    await note.execute(input, context);
    await note.execute(input, context);
    assert.equal(
      await readFile(join(directory, 'safe-id.md'), 'utf8'),
      '# ../../not-a-path\n\n正文\n',
    );
    await assert.rejects(note.execute(input, { ...context, jobId: '../../escape' }));
    await assert.rejects(note.execute({ ...input, content: '变更' }, context), /内容不同/);
  } finally {
    f.store.close();
    await rm(directory, { recursive: true });
  }
});

test('custom command adapter passes JSON stdin, captures structured output, fails closed', async () => {
  const action = commandAction({
    id: 'test.command',
    title: 'Test',
    description: 'Test command',
    executable: process.execPath,
    args: [
      '-e',
      'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(s))));',
    ],
    example: {},
  });
  const f = fixture();
  try {
    const output = await action.execute(
      { text: 'echo $HOME && whoami' },
      { jobId: 'one', client: f.client },
    );
    assert.deepEqual(JSON.parse(output), { jobId: 'one', input: { text: 'echo $HOME && whoami' } });
    const broken = commandAction({
      id: 'test.broken',
      title: 'Bad',
      description: 'Bad output',
      executable: process.execPath,
      args: ['-e', 'console.log("not json")'],
      example: {},
    });
    await assert.rejects(broken.execute({}, { jobId: 'two', client: f.client }), /未返回合法 JSON/);
  } finally {
    f.store.close();
  }
});
