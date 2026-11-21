import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AppError,
  type AnalysisRun,
  type Device,
  type Job,
  type Memory,
  type Observation,
  type Profile,
  type Source,
} from '@qiyi/contracts';

export type StoredJob = Job & { claimToken?: string };
export interface Collections {
  runtime: { automaticAnalysisPause: string | null };
  agentRequests: { fingerprint: string; targetId: string };
  profile: Profile;
  memories: Memory;
  sources: Source;
  observations: Observation;
  jobs: StoredJob;
  devices: Device;
  analysis: AnalysisRun;
}
export type ImportKey = { observationId: string | null; hash: string };

/** SQL owns atomicity and deduplication; validated domain documents own their schema. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string, readonly assetDirectory = path === ':memory:' ? undefined : join(dirname(path), 'assets')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;',
    );
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 2) throw new Error(`数据库版本 ${version} 高于当前程序支持的版本`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
        PRIMARY KEY(kind, id)
      );
      CREATE TABLE IF NOT EXISTS import_keys (
        source_id TEXT NOT NULL, external_id TEXT NOT NULL, observation_id TEXT, hash TEXT NOT NULL,
        PRIMARY KEY(source_id, external_id)
      );
    `);
    if (version < 2)
      this.transaction(() => {
        // Keep legacy keys in their own namespace: arbitrary old IDs can resemble a new encoded ID.
        this.db.exec(`
        CREATE TABLE import_keys_v2 (
          source_id TEXT NOT NULL, external_id TEXT NOT NULL, observation_id TEXT, hash TEXT NOT NULL,
          key_version INTEGER NOT NULL, PRIMARY KEY(source_id, external_id, key_version)
        );
        INSERT INTO import_keys_v2 SELECT source_id, external_id, observation_id, hash, 1 FROM import_keys;
        DROP TABLE import_keys;
        ALTER TABLE import_keys_v2 RENAME TO import_keys;
        PRAGMA user_version = 2;
      `);
        for (const memory of this.list('memories')) {
          // v1 model output admitted whitespace-only tags; they carry no information.
          const tags = memory.tags.map((tag) => tag.trim()).filter(Boolean);
          if (JSON.stringify(tags) === JSON.stringify(memory.tags)) continue;
          this.put('memories', memory.id, {
            ...memory,
            tags,
            revision: memory.revision + 1,
            updatedAt: new Date().toISOString(),
          });
        }
      });
    if (!this.get('profile', 'owner'))
      this.put('profile', 'owner', {
        name: '我的个人空间',
        bio: '',
        locale: 'zh-CN',
        timezone: 'Asia/Shanghai',
        revision: 1,
        updatedAt: new Date().toISOString(),
      });
  }

  get<K extends keyof Collections>(kind: K, id: string): Collections[K] | undefined {
    const row = this.db
      .prepare('SELECT body FROM records WHERE kind = ? AND id = ?')
      .get(kind, id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Collections[K]) : undefined;
  }

  need<K extends keyof Collections>(kind: K, id: string): Collections[K] {
    const value = this.get(kind, id);
    if (!value) throw new AppError('NOT_FOUND', '记录不存在或已删除', 404);
    return value;
  }

  list<K extends keyof Collections>(kind: K): Collections[K][] {
    const rows = this.db
      .prepare(
        "SELECT body FROM records WHERE kind = ? ORDER BY COALESCE(json_extract(body, '$.updatedAt'), json_extract(body, '$.lastSeenAt')) DESC, id",
      )
      .all(kind) as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as Collections[K]);
  }

  put<K extends keyof Collections>(kind: K, id: string, value: Collections[K]): Collections[K] {
    this.db
      .prepare(
        'INSERT INTO records(kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body',
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }

  remove(kind: keyof Collections, id: string): void {
    this.db.prepare('DELETE FROM records WHERE kind = ? AND id = ?').run(kind, id);
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  importKey(sourceId: string, externalId: string, keyVersion = 1): ImportKey | undefined {
    return this.db
      .prepare(
        'SELECT observation_id AS observationId, hash FROM import_keys WHERE source_id = ? AND external_id = ? AND key_version = ?',
      )
      .get(sourceId, externalId, keyVersion) as ImportKey | undefined;
  }

  setImportKey(
    sourceId: string,
    externalId: string,
    observationId: string | null,
    hash: string,
    keyVersion = 1,
  ): void {
    this.db
      .prepare(
        'INSERT INTO import_keys VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id, external_id, key_version) DO UPDATE SET observation_id = excluded.observation_id, hash = excluded.hash',
      )
      .run(sourceId, externalId, observationId, hash, keyVersion);
  }

  tombstoneObservation(sourceId: string, observationId: string): void {
    this.db
      .prepare(
        "UPDATE import_keys SET observation_id = NULL, hash = 'deleted' WHERE source_id = ? AND observation_id = ?",
      )
      .run(sourceId, observationId);
  }

  clearImportKeys(sourceId: string): void {
    this.db.prepare('DELETE FROM import_keys WHERE source_id = ?').run(sourceId);
  }
  close(): void {
    this.db.close();
  }
}

export function assertRevision(record: { revision: number }, expected: number): void {
  if (record.revision !== expected)
    throw new AppError('CONFLICT', '这条信息已在其他端更新，请刷新后重新编辑', 409);
}

export function publicJob(job: StoredJob): Job {
  const { claimToken: _claimToken, ...value } = job;
  return value;
}
