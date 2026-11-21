import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, type Memory, type RpcParsedParams } from '@qiyi/contracts';
import { Store, assertRevision } from './store.js';

/** User-selected snapshots. This endpoint is deliberately absent from MCP tools. */
export class MemoryUploads {
  constructor(private readonly store: Store) {}

  remove(id: string, revision: number) {
    const attachment = this.store.transaction(() => {
      const memory = this.store.need('memories', id);
      assertRevision(memory, revision);
      this.store.remove('memories', id);
      return memory.attachment;
    });
    if (attachment && !this.store.list('memories').some(memory => memory.attachment?.id === attachment.id))
      rmSync(this.assetPath(attachment.id), { force: true });
    return { deleted: true as const };
  }

  upload(input: RpcParsedParams<'memories.upload'>): Memory {
    if (input.memory.status !== 'confirmed')
      throw new AppError('UNCONFIRMED_MEMORY', '请先在本地确认记忆，再手动上传');
    const { requestId, ...payload } = input;
    const key = JSON.stringify(['memory-upload', requestId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    let retiredAttachment: string | undefined;
    const result = this.store.transaction(() => {
      const receipt = this.store.get('agentRequests', key);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint)
          throw new AppError('IDEMPOTENCY_CONFLICT', '同一次上传的内容已改变', 409);
        const current = this.store.get('memories', receipt.targetId);
        if (!current) throw new AppError('UPLOAD_DELETED', '服务器副本已删除，不会通过重试恢复', 409);
        return current;
      }
      const previous = input.previous ? this.store.need('memories', input.previous.id) : undefined;
      if (previous) assertRevision(previous, input.previous!.revision);
      const attachment = input.attachment ? this.saveAttachment(input.attachment) : undefined;
      if (previous?.attachment?.id !== attachment?.id) retiredAttachment = previous?.attachment?.id;
      const now = new Date().toISOString();
      const memory: Memory = {
        ...input.memory, id: previous?.id ?? randomUUID(), origin: 'manual',
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
        evidenceIds: [], evidenceStale: false, ...(attachment ? { attachment } : {}),
      };
      this.store.put('memories', memory.id, memory);
      this.store.put('agentRequests', key, { fingerprint, targetId: memory.id });
      return memory;
    });
    if (retiredAttachment && !this.store.list('memories').some(memory => memory.attachment?.id === retiredAttachment))
      rmSync(this.assetPath(retiredAttachment), { force: true });
    return result;
  }

  attachment(id: string): { mimeType: 'image/png' | 'image/jpeg' | 'text/plain'; data: string } {
    const attachment = this.store.need('memories', id).attachment;
    if (!attachment) throw new AppError('NOT_FOUND', '这条记忆没有上传原件', 404);
    const path = this.assetPath(attachment.id);
    if (!lstatSync(path).isFile()) throw new AppError('INVALID_ASSET', '服务器原件不是有效文件');
    const data = readFileSync(path);
    if (data.length !== attachment.size || createHash('sha256').update(data).digest('hex') !== attachment.id)
      throw new AppError('INVALID_ASSET', '服务器原件校验失败');
    return { mimeType: attachment.mimeType, data: data.toString('base64') };
  }

  private saveAttachment(input: NonNullable<RpcParsedParams<'memories.upload'>['attachment']>): NonNullable<Memory['attachment']> {
    const data = Buffer.from(input.data, 'base64');
    if (!data.length || data.length > 20 * 1024 * 1024 || data.toString('base64') !== input.data)
      throw new AppError('INVALID_ASSET', '原件编码无效或超过 20 MiB');
    const valid = input.mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : input.mimeType === 'image/jpeg' ? data.subarray(0, 3).equals(Buffer.from([255,216,255]))
      : data.length <= 64 * 1024 && Buffer.from(data.toString('utf8')).equals(data);
    if (!valid) throw new AppError('INVALID_ASSET', '原件内容与类型不匹配');
    const id = createHash('sha256').update(data).digest('hex');
    const path = this.assetPath(id);
    mkdirSync(this.store.assetDirectory!, { recursive: true, mode: 0o700 });
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    // A database rollback may leave an unreferenced immutable file; it never
    // exposes an attachment without an associated, authorized memory record.
    return { id, mimeType: input.mimeType, size: data.length };
  }

  private assetPath(id: string): string {
    if (!this.store.assetDirectory) throw new AppError('ASSETS_NOT_CONFIGURED', '服务器未配置原件存储目录');
    if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError('INVALID_ASSET', '原件 ID 无效');
    return join(this.store.assetDirectory, id);
  }
}
