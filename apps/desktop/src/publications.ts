import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, memoryInputSchema, type Memory, type MemoryInput, type RpcParams } from '@qiyi/contracts';
import type { AssistantClient } from '@qiyi/client';
import { Store, assertRevision } from '../../server/src/store.js';

export type Remote = { client: AssistantClient; identity: string; label: string };
export type LocalAttachment = { mimeType: 'image/png' | 'image/jpeg' | 'text/plain'; data: Buffer };
type Publication = {
  id: string; memoryId: string; localRevision: number; target: string; targetLabel: string;
  memory: MemoryInput; attachment?: { path: string; digest: string; mimeType: LocalAttachment['mimeType']; size: number };
  previous?: { id: string; revision: number }; remoteBefore?: Memory;
  state: 'prepared' | 'sending' | 'failed' | 'uploaded'; error?: string; code?: string;
  remoteId?: string; remoteRevision?: number; createdAt: string;
};

/** No background synchronization. A durable snapshot is sent only by commit(). */
export class Publications {
  private readonly db: DatabaseSync;
  private readonly active = new Set<string>();
  constructor(private readonly directory: string, private readonly memories: Store) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'publications.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS publications(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY, source TEXT NOT NULL);');
  }
  close() { this.db.close(); }
  link(id: string, source: string) { this.db.prepare('INSERT INTO links VALUES(?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source').run(id, source); }
  source(id: string): string | undefined { return (this.db.prepare('SELECT source FROM links WHERE id=?').get(id) as { source: string } | undefined)?.source; }
  assertIdle(id: string) { if (this.active.has(id)) throw new AppError('UPLOAD_BUSY', '这条记忆正在上传，请等待结果'); }
  list(): Publication[] { return (this.db.prepare('SELECT body FROM publications ORDER BY rowid DESC').all() as { body: string }[]).map(row => JSON.parse(row.body) as Publication); }
  private save(value: Publication) { this.db.prepare('INSERT INTO publications VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(value.id, JSON.stringify(value)); return value; }
  private need(id: string) {
    const row = this.db.prepare('SELECT body FROM publications WHERE id=?').get(id) as { body: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', '上传预览已失效，请重新选择');
    return JSON.parse(row.body) as Publication;
  }
  status(memory: Memory, target?: string): string {
    const entries = this.list().filter(p => p.memoryId === memory.id && p.target === target);
    const latest = entries[0];
    if (latest && ['sending', 'failed'].includes(latest.state)) return '上传未完成，可手动重试';
    const uploaded = entries.find(p => p.state === 'uploaded');
    return !uploaded ? '仅本地' : uploaded.localRevision === memory.revision ? '已上传此版本' : '本地有修改，未上传';
  }

  async prepare(id: string, revision: number, remote: Remote, attachment: () => Promise<LocalAttachment | undefined>) {
    this.assertIdle(id);
    this.active.add(id);
    try { return await this.prepareSnapshot(id, revision, remote, attachment); }
    finally { this.active.delete(id); }
  }

  private async prepareSnapshot(id: string, revision: number, remote: Remote, attachment: () => Promise<LocalAttachment | undefined>) {
    const memory = this.memories.need('memories', id);
    assertRevision(memory, revision);
    if (memory.status !== 'confirmed' || memory.evidenceStale)
      throw new AppError('UNCONFIRMED_MEMORY', '请先确认记忆及其依据');
    const history = this.list().filter(p => p.memoryId === id && p.target === remote.identity);
    const last = history[0];
    // An uncertain network result must retry the exact operation, including
    // after restart or local edits. The UI previews that original snapshot.
    if (last && ['sending', 'failed'].includes(last.state) && !['CONFLICT', 'NOT_FOUND', 'UPLOAD_DELETED'].includes(last.code ?? ''))
      return this.preview(last);
    const published = history.find(p => p.state === 'uploaded');
    const remoteBefore = published?.remoteId ? await remote.client.call('memories.get', { id: published.remoteId }) : undefined;
    const original = await attachment();
    for (const obsolete of history.filter(p => p.state === 'prepared')) {
      this.db.prepare('DELETE FROM publications WHERE id=?').run(obsolete.id);
      if (obsolete.attachment) rmSync(obsolete.attachment.path, { force: true });
    }
    const requestId = randomUUID();
    let asset: Publication['attachment'];
    if (original) {
      if (!original.data.length || original.data.length > 20 * 1024 * 1024) throw new AppError('INVALID_ASSET', '原件超过 20 MiB 或为空');
      const path = join(this.directory, requestId + '.asset');
      writeFileSync(path, original.data, { flag: 'wx', mode: 0o600 });
      asset = { path, mimeType: original.mimeType, size: original.data.length, digest: createHash('sha256').update(original.data).digest('hex') };
    }
    const { category, title, content, summary, tags, confidence, status } = memory;
    const publication: Publication = {
      id: requestId, memoryId: id, localRevision: revision, target: remote.identity, targetLabel: remote.label,
      memory: memoryInputSchema.parse({ category, title, content, summary, tags, confidence, status }),
      attachment: asset, state: 'prepared', createdAt: new Date().toISOString(),
      ...(remoteBefore ? { previous: { id: remoteBefore.id, revision: remoteBefore.revision }, remoteBefore } : {}),
    };
    return this.preview(this.save(publication));
  }

  private preview(value: Publication) {
    return { id: value.id, memoryId: value.memoryId, localRevision: value.localRevision, memory: value.memory,
      target: value.targetLabel, previous: value.remoteBefore,
      retry: value.state !== 'prepared',
      attachment: value.attachment ? { mimeType: value.attachment.mimeType, size: value.attachment.size, path: value.attachment.path } : null };
  }

  async commit(id: string, remote: Remote): Promise<Memory> {
    const operation = this.need(id);
    if (operation.target !== remote.identity) throw new AppError('TARGET_CHANGED', '服务器配置已改变，请重新预览');
    this.assertIdle(operation.memoryId);
    if (operation.state === 'uploaded') return remote.client.call('memories.get', { id: operation.remoteId! });
    if (operation.state === 'prepared') assertRevision(this.memories.need('memories', operation.memoryId), operation.localRevision);
    this.active.add(operation.memoryId);
    try {
      const payload: RpcParams<'memories.upload'> = { requestId: operation.id, memory: operation.memory, ...(operation.previous ? { previous: operation.previous } : {}) };
      if (operation.attachment) {
        const data = readFileSync(operation.attachment.path);
        if (createHash('sha256').update(data).digest('hex') !== operation.attachment.digest) throw new AppError('INVALID_ASSET', '待上传原件发生变化，请重新生成预览');
        payload.attachment = { mimeType: operation.attachment.mimeType, data: data.toString('base64') };
      }
      this.save({ ...operation, state: 'sending', error: undefined, code: undefined });
      const result = await remote.client.call('memories.upload', payload);
      this.save({ ...operation, state: 'uploaded', remoteId: result.id, remoteRevision: result.revision });
      return result;
    } catch (error) {
      this.save({ ...operation, state: 'failed', error: error instanceof Error ? error.message : '上传失败', code: error instanceof AppError ? error.code : 'NETWORK_UNKNOWN' });
      throw error;
    } finally { this.active.delete(operation.memoryId); }
  }
}
