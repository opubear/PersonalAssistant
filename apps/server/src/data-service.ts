import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  legacyChatExternalId,
  type ImportResult,
  type Memory,
  type MemoryInput,
  type Observation,
  type ObservationInput,
  type Source,
  type SourceInput,
} from '@qiyi/contracts';
import { assertRevision, Store } from './store.js';
import { prepareImport } from './import-identity.js';

export const now = () => new Date().toISOString();
export const hashObservation = (input: ObservationInput) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        content: input.content,
        role: input.role,
        kind: input.kind,
        occurredAt: input.occurredAt,
        metadata: Object.fromEntries(
          Object.entries(input.metadata).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    )
    .digest('hex');

export class DataService {
  constructor(private readonly store: Store) {}

  createMemory(input: MemoryInput, origin: Memory['origin'] = 'manual'): Memory {
    const memory: Memory = {
      ...input,
      id: randomUUID(),
      origin,
      evidenceIds: [],
      evidenceStale: false,
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.put('memories', memory.id, memory);
  }

  updateMemory(id: string, revision: number, input: MemoryInput): Memory {
    return this.store.transaction(() => {
      const existing = this.store.need('memories', id);
      assertRevision(existing, revision);
      return this.store.put('memories', id, {
        ...existing,
        ...input,
        origin: existing.origin,
        evidenceStale: false,
        revision: revision + 1,
        updatedAt: now(),
      });
    });
  }

  createSource(id: string, input: SourceInput): Source {
    return this.store.transaction(() => {
      if (this.store.get('sources', id)) throw new AppError('SOURCE_EXISTS', '来源 ID 已存在', 409);
      return this.store.put('sources', id, {
        ...input,
        id,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      });
    });
  }

  updateSource(id: string, revision: number, input: SourceInput): Source {
    return this.store.transaction(() => {
      const existing = this.store.need('sources', id);
      assertRevision(existing, revision);
      if (
        input.kind !== existing.kind &&
        this.store.list('observations').some((item) => item.sourceId === id)
      )
        throw new AppError('SOURCE_HAS_DATA', '已有数据的来源不能更改格式；请新建来源');
      return this.store.put('sources', id, {
        ...existing,
        ...input,
        revision: revision + 1,
        updatedAt: now(),
      });
    });
  }

  importObservations(sourceId: string, inputs: ObservationInput[]): ImportResult {
    return this.store.transaction(() => {
      const source = this.store.need('sources', sourceId);
      if (!source.enabled) throw new AppError('SOURCE_DISABLED', '此来源已暂停，未接收数据', 409);
      const result: ImportResult = { created: 0, updated: 0, skipped: 0 };
      for (const raw of inputs) {
        const { input, key, keyVersion } = prepareImport(this.store, sourceId, source.kind, raw);
        const hash = hashObservation(input);
        // Tombstones and hand-edited content take precedence over future device uploads.
        if (key && (key.observationId === null || key.hash === hash)) {
          result.skipped++;
          continue;
        }
        const previous = key?.observationId
          ? this.store.need('observations', key.observationId)
          : undefined;
        if (previous?.edited) {
          result.skipped++;
          continue;
        }
        const id = previous?.id ?? randomUUID();
        const observation: Observation = {
          ...input,
          id,
          sourceId,
          contentHash: hash,
          analyzedHash: null,
          edited: false,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
        };
        if (previous) this.invalidateEvidence(id);
        this.store.put('observations', id, observation);
        this.store.setImportKey(sourceId, input.externalId, id, hash, keyVersion);
        if (previous) result.updated++;
        else result.created++;
      }
      return result;
    });
  }

  updateObservation(
    id: string,
    revision: number,
    input: Omit<ObservationInput, 'externalId' | 'identity'>,
  ): Observation {
    return this.store.transaction(() => {
      const existing = this.store.need('observations', id);
      assertRevision(existing, revision);
      const next = {
        ...existing,
        ...input,
        revision: revision + 1,
        edited: true,
        analyzedHash: null,
        updatedAt: now(),
      };
      next.contentHash = hashObservation(next);
      this.invalidateEvidence(id);
      return this.store.put('observations', id, next);
    });
  }

  deleteObservation(id: string, revision: number): void {
    this.store.transaction(() => {
      const observation = this.store.need('observations', id);
      assertRevision(observation, revision);
      this.removeObservation(observation);
    });
  }

  deleteSource(id: string, revision: number): void {
    this.store.transaction(() => {
      assertRevision(this.store.need('sources', id), revision);
      for (const observation of this.store
        .list('observations')
        .filter((item) => item.sourceId === id))
        this.removeObservation(observation);
      this.store.remove('sources', id);
      // Keep source-scoped tombstones: recreating the same source must not resurrect deleted data.
    });
  }

  private removeObservation(observation: Observation): void {
    this.invalidateEvidence(observation.id);
    this.store.tombstoneObservation(observation.sourceId, observation.id);
    this.store.setImportKey(
      observation.sourceId,
      observation.externalId,
      null,
      'deleted',
      observation.identity ? 2 : 1,
    );
    if (observation.identity)
      this.store.setImportKey(
        observation.sourceId,
        legacyChatExternalId(observation.identity),
        null,
        'deleted',
        3,
      );
    this.store.remove('observations', observation.id);
  }

  private invalidateEvidence(observationId: string): void {
    for (const memory of this.store.list('memories')) {
      if (!memory.evidenceIds.includes(observationId)) continue;
      this.store.put('memories', memory.id, {
        ...memory,
        evidenceStale: true,
        revision: memory.revision + 1,
        updatedAt: now(),
      });
    }
  }
}
