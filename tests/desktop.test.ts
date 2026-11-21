import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AssistantClient, HttpTransport } from '@qiyi/client';
import type { Memory, MemoryInput } from '@qiyi/contracts';
import { DesktopController, type CaptureTransport } from '../apps/desktop/src/controller.js';
import { Publications, type Remote } from '../apps/desktop/src/publications.js';
import { ServerConnection } from '../apps/desktop/src/server-connection.js';
import { Store } from '../apps/server/src/store.js';
import { AssistantService } from '../apps/server/src/service.js';
import { createServer } from '../apps/server/src/http.js';
import { memory } from './helpers.js';

const token = 'test-desktop-token-at-least-32-characters';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY6sAAAAASUVORK5CYII=', 'base64');
class Capture implements CaptureTransport {
  calls: { method: string; params: unknown }[] = [];
  constructor(readonly picture: string) {}
  async request(method: string, params: unknown = {}) {
    this.calls.push({ method, params });
    if (method === 'initialize') return { protocolVersion: 1, directory: '/synthetic' };
    if (method === 'library/content') return { path: this.picture, item: { id: 'local-picture', mimeType: 'image/png', kind: 'image' } };
    return {};
  }
}

test('capture and reader configuration do not forward personal memory to the temporary reader', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-reader-context-'));
  const capture = new Capture(join(root, 'synthetic.png'));
  const desktop = new DesktopController(join(root, 'local'), capture);
  t.after(() => { desktop.close(); rmSync(root, { recursive: true, force: true }); });
  await desktop.dispatch('memory/save', { memory: { ...memory, content: 'PRIVATE_PERSONAL_CONTEXT' } });
  capture.calls.length = 0;
  await desktop.dispatch('capture', {});
  const configuration = { provider: 'codex', executable: 'codex', arguments: ['app-server'], basePrompt: '', reasoningEffort: 'low' };
  await desktop.dispatch('reader/configure', { configuration });
  assert.deepEqual(capture.calls, [{ method: 'capture', params: {} }, { method: 'reader/configure', params: { configuration } }]);
  await desktop.dispatch('chat/ask', { text: '关于我的偏好' });
  assert.equal(capture.calls[2]?.method, 'context/set');
  assert.ok(JSON.stringify(capture.calls[2]?.params).includes('PRIVATE_PERSONAL_CONTEXT'));
});

test('desktop startup, capture, chat, local edits and upload preview do not send data; commit sends only selected memory and original', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-desktop-'));
  const serverStore = new Store(join(root, 'server.sqlite'));
  const service = new AssistantService(serverStore);
  const app = createServer(service, token);
  let requests = 0;
  app.addHook('onRequest', async () => { requests++; });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const picture = join(root, 'source.png'); writeFileSync(picture, png);
  const capture = new Capture(picture);
  const desktop = new DesktopController(join(root, 'local'), capture);
  t.after(async () => { desktop.close(); await app.close(); serverStore.close(); rmSync(root, { recursive: true, force: true }); });
  await desktop.dispatch('server/configure', { url: address, token });
  await desktop.dispatch('initialize', {});
  const first = await desktop.dispatch('memory/save', { memory: { ...memory, content: 'LOCAL_SELECTED', summary: '只上传这一条' }, sourceId: 'local-picture' }) as Memory;
  await desktop.dispatch('memory/save', { memory: { ...memory, content: 'NEVER_UPLOAD' } });
  await desktop.dispatch('capture', {});
  await desktop.dispatch('chat/ask', { text: 'PRIVATE_QUESTION' });
  assert.equal(requests, 0);
  assert.ok(JSON.stringify(capture.calls).includes('LOCAL_SELECTED'));
  const preview = await desktop.dispatch('upload/prepare', { id: first.id, revision: first.revision }) as { id: string; attachment: { size: number } };
  assert.equal(preview.attachment.size, png.length);
  assert.equal(requests, 0);
  assert.equal(serverStore.list('memories').length, 0);
  const uploaded = await desktop.dispatch('upload/commit', { id: preview.id }) as Memory;
  assert.equal(requests, 1);
  assert.equal(serverStore.list('memories').length, 1);
  assert.equal(uploaded.content, 'LOCAL_SELECTED'); assert.equal(uploaded.summary, '只上传这一条');
  assert.deepEqual(readFileSync(join(root, 'assets', uploaded.attachment!.id)), png);
  assert.ok(!JSON.stringify(serverStore.list('memories')).includes('NEVER_UPLOAD'));
  await desktop.dispatch('memory/save', { id: first.id, revision: first.revision, memory: { ...memory, content: 'LOCAL_EDIT_ONLY' } });
  assert.equal(requests, 1);
  assert.equal(serverStore.need('memories', uploaded.id).content, 'LOCAL_SELECTED');
  const rows = await desktop.dispatch('memory/list', {}) as { id: string; storage: string }[];
  assert.equal(rows.find(row => row.id === first.id)?.storage, '本地有修改，未上传');
  const remoteAsset = await desktop.dispatch('server/attachment', { id: uploaded.id }) as { data: string };
  assert.deepEqual(Buffer.from(remoteAsset.data, 'base64'), png);
  await desktop.dispatch('server/delete', { id: uploaded.id, revision: uploaded.revision });
  assert.equal(serverStore.list('memories').length, 0);
  assert.equal(existsSync(join(root, 'assets', uploaded.attachment!.id)), false);
  assert.equal(desktop.store.list('memories').length, 2);
});

test('an uncertain upload is not retried on restart; explicit retry reuses exact content and request ID', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-retry-'));
  const local = new Store(join(root, 'local.sqlite'));
  const server = new Store(join(root, 'remote.sqlite'));
  const localService = new AssistantService(local), remoteService = new AssistantService(server);
  let calls = 0, loseReply = true;
  const remote: Remote = { identity: 'one-server', label: 'https://example.test', client: new AssistantClient({
    request: async (method, params) => {
      calls++;
      const data = await remoteService.dispatch({ method, params });
      if (loseReply) { loseReply = false; throw new Error('connection lost after commit'); }
      return { ok: true, data };
    },
  }) };
  let publications = new Publications(join(root, 'uploads'), local);
  t.after(() => { publications.close(); local.close(); server.close(); rmSync(root, { recursive: true, force: true }); });
  const saved = await localService.dispatch({ method: 'memories.create', params: memory }) as Memory;
  const preview = await publications.prepare(saved.id, saved.revision, remote, async () => ({ mimeType: 'image/png', data: png }));
  await assert.rejects(publications.commit(preview.id, remote), /connection lost/);
  await localService.dispatch({ method: 'memories.update', params: { ...memory, id: saved.id, revision: saved.revision, content: '未授权的新内容' } });
  publications.close(); publications = new Publications(join(root, 'uploads'), local);
  assert.equal(calls, 1);
  const retry = await publications.prepare(saved.id, 2, remote, async () => { throw new Error('must use frozen original'); });
  assert.equal(retry.id, preview.id); assert.equal(retry.retry, true);
  assert.equal(retry.memory.content, memory.content);
  const result = await publications.commit(retry.id, remote);
  assert.equal(calls, 2); assert.equal(server.list('memories').length, 1);
  assert.deepEqual(readFileSync(join(root, 'assets', result.attachment!.id)), png);
  assert.equal(publications.status(local.need('memories', saved.id), remote.identity), '本地有修改，未上传');
});

test('preview binds revision and destination; old previews and unconfirmed memories cannot upload', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-preview-'));
  const local = new Store(join(root, 'local.sqlite')); const service = new AssistantService(local);
  const publications = new Publications(join(root, 'uploads'), local);
  let calls = 0;
  const remote: Remote = { identity: 'first', label: 'https://one.test', client: new AssistantClient({ request: async () => { calls++; throw new Error('must not send'); } }) };
  t.after(() => { publications.close(); local.close(); rmSync(root, { recursive: true, force: true }); });
  const saved = await service.dispatch({ method: 'memories.create', params: memory }) as Memory;
  const first = await publications.prepare(saved.id, 1, remote, async () => undefined);
  const second = await publications.prepare(saved.id, 1, remote, async () => undefined);
  await assert.rejects(publications.commit(first.id, remote), { code: 'NOT_FOUND' });
  await assert.rejects(publications.commit(second.id, { ...remote, identity: 'other-server' }), { code: 'TARGET_CHANGED' });
  await service.dispatch({ method: 'memories.update', params: { ...memory, id: saved.id, revision: 1, status: 'proposed' } });
  await assert.rejects(publications.commit(second.id, remote), { code: 'CONFLICT' });
  await assert.rejects(publications.prepare(saved.id, 2, remote, async () => undefined), { code: 'UNCONFIRMED_MEMORY' });
  assert.equal(calls, 0);
});

test('server uploads preserve human edits, reject conflicts and invalid attachments, and never resurrect deleted copies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-upload-server-'));
  const store = new Store(join(root, 'server.sqlite')); const service = new AssistantService(store);
  const client = new AssistantClient({ request: async (method, params) => ({ ok: true, data: await service.dispatch({ method, params }) }) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { requestId: randomUUID(), memory, attachment: { mimeType: 'image/png' as const, data: png.toString('base64') } };
  const created = await client.call('memories.upload', input);
  const updated = await client.call('memories.update', { ...memory, id: created.id, revision: created.revision, content: '服务器人工修改' });
  assert.equal((await client.call('memories.upload', input)).content, updated.content);
  await assert.rejects(client.call('memories.upload', { ...input, memory: { ...memory, content: '改变重试内容' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(client.call('memories.upload', { ...input, requestId: randomUUID(), previous: { id: created.id, revision: 1 } }), { code: 'CONFLICT' });
  await assert.rejects(client.call('memories.upload', { ...input, requestId: randomUUID(), attachment: { mimeType: 'image/png', data: Buffer.from('not a picture').toString('base64') } }), { code: 'INVALID_ASSET' });
  assert.equal(store.list('memories').length, 1);
  await client.call('memories.delete', { id: created.id, revision: updated.revision });
  await assert.rejects(client.call('memories.upload', input), { code: 'UPLOAD_DELETED' });
  assert.equal(store.list('memories').length, 0);
});

test('corrupt or missing server settings keep local storage available; credentials are not returned', t => {
  const root = mkdtempSync(join(tmpdir(), 'qiyi-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'server-connection.json'), 'broken');
  const settings = new ServerConnection(root);
  assert.equal(settings.status().configured, false);
  assert.equal(readFileSync(settings.path, 'utf8'), 'broken');
  assert.throws(() => settings.save('http://example.com', token), { code: 'INVALID_SERVER' });
  settings.save('https://example.com', token);
  assert.ok(!JSON.stringify(settings.status()).includes(token));
  settings.clear(); assert.equal(existsSync(settings.path), false);
});
