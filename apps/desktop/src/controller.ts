import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError, memoryInputSchema, type Memory } from '@qiyi/contracts';
import { Store } from '../../server/src/store.js';
import { AssistantService } from '../../server/src/service.js';
import { Publications, type LocalAttachment } from './publications.js';
import { ServerConnection } from './server-connection.js';

export interface CaptureTransport { request(method: string, params?: unknown): Promise<unknown> }
const versioned = z.object({ id: z.string(), revision: z.number().int().positive() }).strict();

/** Local-first frontend backend. It never starts collectors or a server sync loop. */
export class DesktopController {
  readonly store: Store;
  readonly local: AssistantService;
  readonly publications: Publications;
  readonly connection: ServerConnection;
  constructor(readonly directory: string, private readonly capture: CaptureTransport) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.store = new Store(join(directory, 'local.sqlite'));
    this.local = new AssistantService(this.store);
    this.publications = new Publications(join(directory, 'uploads'), this.store);
    this.connection = new ServerConnection(directory);
  }
  close() { this.publications.close(); this.store.close(); }
  async refreshContext() {
    // Local memories only. Opening/asking/screenshotting never makes a request
    // to the personal server, nor sends a user's question there for retrieval.
    const result = await this.local.dispatch({ method: 'context.get', params: { query: '', limit: 30 } }) as { markdown: string };
    await this.capture.request('context/set', { text: result.markdown });
  }
  async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const initial = await this.capture.request('initialize') as Record<string, unknown>;
        await this.refreshContext();
        return { ...initial, assistant: { localDirectory: this.directory, server: this.connection.status(), manualUpload: true } };
      }
      case 'memory/list': return this.store.list('memories').map(memory => ({ ...memory,
        sourceId: this.publications.source(memory.id), storage: this.publications.status(memory, this.connection.status().configured ? this.connection.remote().identity : undefined) }));
      case 'memory/save': {
        const input = z.object({ memory: memoryInputSchema, id: z.string().optional(), revision: z.number().int().positive().optional(), sourceId: z.string().optional() }).strict().parse(params);
        if (input.id) this.publications.assertIdle(input.id);
        if (input.sourceId) await this.capture.request('library/content', { id: input.sourceId });
        const saved = input.id
          ? await this.local.dispatch({ method: 'memories.update', params: { ...input.memory, id: input.id, revision: input.revision } }) as Memory
          : await this.local.dispatch({ method: 'memories.create', params: input.memory }) as Memory;
        if (input.sourceId) this.publications.link(saved.id, input.sourceId);
        await this.refreshContext();
        return saved;
      }
      case 'memory/delete': {
        const input = versioned.parse(params);
        this.publications.assertIdle(input.id);
        const result = await this.local.dispatch({ method: 'memories.delete', params: input });
        await this.refreshContext();
        return result;
      }
      case 'server/status': return this.connection.status();
      case 'server/configure': {
        const input = z.object({ url: z.string(), token: z.string() }).strict().parse(params);
        return this.connection.save(input.url, input.token);
      }
      case 'server/disconnect': this.connection.clear(); return {};
      case 'server/list': {
        return this.connection.remote().client.call('memories.list', {});
      }
      case 'server/attachment': return this.connection.remote().client.call('memories.attachment', z.object({ id: z.string() }).strict().parse(params));
      case 'server/delete': return this.connection.remote().client.call('memories.delete', versioned.parse(params));
      case 'upload/prepare': {
        const input = versioned.parse(params);
        return this.publications.prepare(input.id, input.revision, this.connection.remote(), () => this.attachment(input.id));
      }
      case 'upload/commit': {
        const { id } = z.object({ id: z.string().uuid() }).strict().parse(params);
        return this.publications.commit(id, this.connection.remote());
      }
      case 'chat/ask': case 'agent/start':
        await this.refreshContext();
        return this.capture.request(method, params);
      default: {
        const allowed = ['permissions/status', 'permissions/request', 'capture', 'library/list', 'library/content', 'library/addText', 'library/addImage', 'library/summarize', 'reader/configure', 'agent/stop', 'interaction/respond'];
        if (!allowed.includes(method)) throw new AppError('METHOD_NOT_FOUND', '未知桌面接口');
        return this.capture.request(method, params);
      }
    }
  }
  private async attachment(id: string): Promise<LocalAttachment | undefined> {
    const source = this.publications.source(id);
    if (!source) return undefined;
    const result = await this.capture.request('library/content', { id: source }) as { path: string; item: { mimeType: string } };
    const mimeType = z.enum(['image/png', 'image/jpeg', 'text/plain']).parse(result.item.mimeType);
    if (statSync(result.path).size > 20 * 1024 * 1024) throw new AppError('INVALID_ASSET', '原件超过 20 MiB');
    return { mimeType, data: readFileSync(result.path) };
  }
}
