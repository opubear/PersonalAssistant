import { createHash } from 'node:crypto';
import { AppError, type Job, type Memory, type RpcParsedParams } from '@qiyi/contracts';
import type { DataService } from './data-service.js';
import type { JobService } from './jobs.js';
import { publicJob, type Collections, type Store } from './store.js';

/** Agent writes are proposals; human review still owns confirmation and approval. */
export class AgentProposalService {
  constructor(
    private readonly store: Store,
    private readonly data: DataService,
    private readonly jobs: JobService,
  ) {}

  preference({ requestId, ...input }: RpcParsedParams<'memories.propose'>): Memory {
    return this.createOnce('memories', requestId, input, () =>
      this.data.createMemory(
        { ...input, category: 'preference', status: 'proposed', confidence: 0.5 },
        'agent',
      ),
    );
  }

  job({ requestId, ...input }: RpcParsedParams<'jobs.propose'>): Job {
    return publicJob(this.createOnce('jobs', requestId, input, () => this.jobs.create(input)));
  }

  private createOnce<K extends 'memories' | 'jobs'>(
    kind: K,
    requestId: string,
    input: object,
    create: () => Collections[K],
  ): Collections[K] {
    const key = JSON.stringify([kind, requestId]);
    // Hash the JSON representation that crosses the API and is persisted, not object key order.
    const jsonInput: unknown = JSON.parse(JSON.stringify(input));
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonicalize(jsonInput)))
      .digest('hex');

    return this.store.transaction(() => {
      const previous = this.store.get('agentRequests', key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '请求 ID 已用于不同内容，请勿更改重试参数',
            409,
          );

        // Preserve edits and lifecycle changes; a receipt never recreates a deleted proposal.
        const current = this.store.get(kind, previous.targetId);
        if (!current)
          throw new AppError('PROPOSAL_DELETED', '此请求对应的提议已被删除，不能通过重试恢复', 409);
        return current;
      }

      const created = create();
      this.store.put('agentRequests', key, { fingerprint, targetId: created.id });
      return created;
    });
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  return value;
}
