import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chatExternalId, type Observation, type ObservationInput } from '@qiyi/contracts';
import { parseImport } from '@qiyi/adapters';
import { Store } from '../apps/server/src/store.js';
import { hashObservation } from '../apps/server/src/data-service.js';
import { fixture, source, memory } from './helpers.js';

const timestamp = '2026-11-12T00:00:00Z';
function chat(id: string, conversationId?: string, content = 'synthetic'): ObservationInput {
  return parseImport(
    'chat-jsonl',
    JSON.stringify({ id, conversationId, role: 'user', content, timestamp }),
  ).observations[0]!;
}
function seedLegacy(
  store: Store,
  id = 'b:c',
  conversationId?: string,
  edited = false,
): Observation {
  const raw: ObservationInput = {
    externalId: conversationId ? `${conversationId}:${id}` : id,
    kind: 'chat',
    role: 'user',
    content: edited ? 'manually corrected' : 'synthetic',
    occurredAt: timestamp,
    metadata: conversationId ? { conversationId } : {},
  };
  const hash = hashObservation(raw);
  const value: Observation = {
    ...raw,
    id: 'legacy-observation',
    sourceId: source.id,
    contentHash: hash,
    analyzedHash: hash,
    edited,
    revision: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  store.put('observations', value.id, value);
  store.setImportKey(source.id, raw.externalId, value.id, hash);
  return value;
}

test('chat identities distinguish delimiter collisions and absent conversations without overwrites', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    const inputs = [
      chat('b:c', 'a', 'first'),
      chat('c', 'a:b', 'second'),
      chat('a:b:c', undefined, 'third'),
    ];
    assert.equal(new Set(inputs.map((item) => item.externalId)).size, 3);
    assert.deepEqual(
      await f.client.call('observations.import', { sourceId: source.id, observations: inputs }),
      { created: 3, updated: 0, skipped: 0 },
    );
    assert.deepEqual(
      await f.client.call('observations.import', { sourceId: source.id, observations: inputs }),
      { created: 0, updated: 0, skipped: 3 },
    );
    assert.deepEqual(
      new Set(f.store.list('observations').map((item) => item.content)),
      new Set(['first', 'second', 'third']),
    );
    const unicode = chat(' :你好 '.repeat(30), ' :会话 '.repeat(30));
    assert.ok(unicode.externalId.length <= 512);
    await f.client.call('observations.import', { sourceId: source.id, observations: [unicode] });
  } finally {
    f.store.close();
  }
});

test('legacy migration preserves record IDs, manual edits, evidence and mixed-version deduplication', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    const previous = seedLegacy(f.store, 'b:c', 'a', true);
    const fact = await f.client.call('memories.create', memory);
    f.store.put('memories', fact.id, { ...fact, evidenceIds: [previous.id] });
    const input = chat('b:c', 'a');
    assert.deepEqual(
      await f.client.call('observations.import', { sourceId: source.id, observations: [input] }),
      { created: 0, updated: 0, skipped: 1 },
    );
    const migrated = f.store.need('observations', previous.id);
    assert.equal(migrated.externalId, input.externalId);
    assert.equal(migrated.content, 'manually corrected');
    assert.equal(migrated.analyzedHash, previous.analyzedHash);
    assert.equal(f.store.need('memories', fact.id).evidenceStale, false);
    const { identity: _, ...legacyInput } = input;
    legacyInput.externalId = 'a:b:c';
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [legacyInput],
    });
    assert.equal(f.store.list('observations').length, 1);
    await f.client.call('observations.delete', { id: migrated.id, revision: migrated.revision });
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [input, legacyInput],
    });
    assert.equal(f.store.list('observations').length, 0);
    assert.equal(f.store.need('memories', fact.id).evidenceStale, true);
  } finally {
    f.store.close();
  }
});

test('a legacy live collision is disambiguated rather than adopted by the other conversation', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    seedLegacy(f.store, 'b:c', 'a');
    const result = await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [chat('c', 'a:b'), chat('b:c', 'a')],
    });
    assert.deepEqual(result, { created: 1, updated: 0, skipped: 1 });
    assert.equal(f.store.list('observations').length, 2);
    assert.equal(f.store.need('observations', 'legacy-observation').identity?.conversationId, 'a');
  } finally {
    f.store.close();
  }
});

test('legacy tombstones survive migration and source recreation without reviving aliases', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    f.store.setImportKey(source.id, 'a:b:c', null, 'deleted');
    const rows = [chat('b:c', 'a'), chat('c', 'a:b'), chat('a:b:c')];
    assert.deepEqual(
      await f.client.call('observations.import', { sourceId: source.id, observations: rows }),
      { created: 0, updated: 0, skipped: 3 },
    );
    await f.client.call('sources.delete', { id: source.id, revision: 1 });
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', { sourceId: source.id, observations: rows });
    assert.equal(f.store.list('observations').length, 0);
  } finally {
    f.store.close();
  }
});

test('a legacy raw ID resembling the new encoding cannot collide across key namespaces', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    const input = chat('one', 'conversation');
    const previous = seedLegacy(f.store, input.externalId);
    const result = await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [input, chat(input.externalId)],
    });
    assert.deepEqual(result, { created: 1, updated: 0, skipped: 1 });
    assert.equal(f.store.list('observations').length, 2);
    assert.equal(
      f.store.need('observations', previous.id).externalId,
      chatExternalId({ format: 'chat-jsonl', messageId: input.externalId }),
    );
  } finally {
    f.store.close();
  }
});

test('ambiguous manually edited legacy identity fails atomically and immutable identity rejects edits', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    seedLegacy(f.store, 'b:c', 'a', true);
    await assert.rejects(
      f.client.call('observations.import', {
        sourceId: source.id,
        observations: [chat('new'), chat('c', 'a:b')],
      }),
      { code: 'LEGACY_ID_AMBIGUOUS' },
    );
    assert.equal(f.store.list('observations').length, 1);
    await assert.rejects(
      f.service.dispatch({
        method: 'observations.update',
        params: {
          id: 'legacy-observation',
          revision: 3,
          kind: 'chat',
          role: 'user',
          content: 'edit',
          occurredAt: timestamp,
          metadata: {},
          identity: { format: 'chat-jsonl', messageId: 'hijacked' },
        },
      }),
    );
  } finally {
    f.store.close();
  }
});

test('schema version one migrates key namespaces transactionally and preserves tombstones on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-schema-'));
  const path = join(directory, 'legacy.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE import_keys (source_id TEXT NOT NULL, external_id TEXT NOT NULL, observation_id TEXT, hash TEXT NOT NULL, PRIMARY KEY(source_id,external_id));
      INSERT INTO import_keys VALUES ('source','same-id',NULL,'deleted'); PRAGMA user_version=1;`);
    db.close();
    let store = new Store(path);
    assert.deepEqual(
      { ...store.importKey('source', 'same-id') },
      { observationId: null, hash: 'deleted' },
    );
    store.setImportKey('source', 'same-id', 'v2-record', 'hash', 2);
    store.close();
    store = new Store(path);
    assert.deepEqual(
      { ...store.importKey('source', 'same-id') },
      { observationId: null, hash: 'deleted' },
    );
    assert.deepEqual(
      { ...store.importKey('source', 'same-id', 2) },
      { observationId: 'v2-record', hash: 'hash' },
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('legacy whole-ID trimming migrates whitespace identities without losing edits or record IDs', async () => {
  for (const [conversationId, messageId] of [
    [' room', 'm'],
    ['room', 'm '],
    ['a', ' '],
    [' ', 'm'],
    [undefined, ' m '],
  ] as const) {
    const f = fixture();
    try {
      await f.client.call('sources.create', source);
      const input = chat(messageId, conversationId);
      const legacy: ObservationInput = {
        ...input,
        externalId: (conversationId ? `${conversationId}:${messageId}` : messageId).trim(),
      };
      delete legacy.identity;
      await f.client.call('observations.import', { sourceId: source.id, observations: [legacy] });
      const previous = f.store.list('observations')[0]!;
      const result = await f.client.call('observations.import', {
        sourceId: source.id,
        observations: [input],
      });
      assert.deepEqual(result, { created: 0, updated: 0, skipped: 1 });
      const migrated = f.store.need('observations', previous.id);
      assert.equal(migrated.externalId, input.externalId);
      assert.deepEqual(migrated.identity, input.identity);
      await f.client.call('observations.import', { sourceId: source.id, observations: [legacy] });
      assert.equal(f.store.list('observations').length, 1);
      await f.client.call('observations.delete', { id: previous.id, revision: migrated.revision });
      await f.client.call('observations.import', {
        sourceId: source.id,
        observations: [legacy, input],
      });
      assert.equal(f.store.list('observations').length, 0);
    } finally {
      f.store.close();
    }
  }
});

test('new whitespace-distinct IDs remain distinct; ambiguous old clients cannot overwrite or revive them', async () => {
  const f = fixture();
  try {
    await f.client.call('sources.create', source);
    const inputs = [chat('m', 'room'), chat('m ', 'room')];
    await f.client.call('observations.import', { sourceId: source.id, observations: inputs });
    const legacy: ObservationInput = { ...inputs[0]!, externalId: 'room:m' };
    delete legacy.identity;
    await assert.rejects(
      f.client.call('observations.import', { sourceId: source.id, observations: [legacy] }),
      { code: 'LEGACY_ID_AMBIGUOUS' },
    );
    const removed = f.store.list('observations').find((item) => item.identity?.messageId === 'm ')!;
    await f.client.call('observations.delete', { id: removed.id, revision: removed.revision });
    const result = await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [legacy, inputs[0]!, inputs[1]!, chat('m  ', 'room')],
    });
    assert.deepEqual(result, { created: 1, updated: 0, skipped: 3 });
    assert.deepEqual(
      new Set(f.store.list('observations').map((item) => item.identity?.messageId)),
      new Set(['m', 'm  ']),
    );
  } finally {
    f.store.close();
  }
});

test('schema migration normalizes old model tags before strict response validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-tags-schema-'));
  const path = join(directory, 'legacy.sqlite');
  let store: Store | undefined;
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE import_keys (source_id TEXT NOT NULL, external_id TEXT NOT NULL, observation_id TEXT, hash TEXT NOT NULL, PRIMARY KEY(source_id,external_id));
      PRAGMA user_version=1;`);
    db.prepare('INSERT INTO records VALUES (?,?,?)').run(
      'memories',
      'legacy-memory',
      JSON.stringify({
        ...memory,
        id: 'legacy-memory',
        tags: [' ', ' work '],
        origin: 'ai',
        evidenceIds: [],
        evidenceStale: false,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    );
    db.close();
    store = new Store(path);
    assert.deepEqual(store.need('memories', 'legacy-memory').tags, ['work']);
    assert.equal(store.need('memories', 'legacy-memory').revision, 2);
    const { AssistantService } = await import('../apps/server/src/service.js');
    const snapshot = await new AssistantService(store).dispatch({
      method: 'snapshot.get',
      params: {},
    });
    assert.ok(snapshot);
  } finally {
    store?.close();
    await rm(directory, { recursive: true });
  }
});
