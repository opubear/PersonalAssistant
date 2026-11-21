import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { memorySchema } from '@qiyi/contracts';
import { CompatibleExtractor, type Extraction } from '../apps/server/src/extractor.js';
import { fixture, memory, observation, source } from './helpers.js';

const candidate = {
  category: 'habit' as const,
  title: 'Reading:fiction',
  content: 'at night',
  tags: ['reading'],
  confidence: 0.8,
};

test('blank AI tags fail the whole batch without poisoning snapshots or marking evidence analyzed', async () => {
  const f = fixture({
    model: 'blank-tag-test',
    async extract(items) {
      return {
        memories: [
          { ...candidate, evidenceIds: [items[0]!.id] },
          { ...candidate, title: 'Invalid tags', tags: [' '], evidenceIds: [items[0]!.id] },
        ],
      };
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    await assert.rejects(f.client.call('analysis.run', {}), z.ZodError);
    assert.equal(f.store.list('memories').length, 0);
    assert.equal(f.store.list('observations')[0]!.analyzedHash, null);
    const snapshot = await f.client.call('snapshot.get', {});
    assert.equal(snapshot.pendingAnalysis, 1);
    assert.equal(snapshot.memories.length, 0);
    assert.equal(snapshot.analysisRuns[0]!.status, 'failed');
    assert.equal(snapshot.analysisRuns[0]!.proposed, 0);
  } finally {
    f.store.close();
  }
});

test('compatible extractors keep MODEL_INVALID_SCHEMA semantics for blank tags', async () => {
  const extractor = new CompatibleExtractor(
    { baseUrl: 'https://example.invalid/v1', model: 'synthetic' },
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  memories: [{ ...candidate, tags: ['\t\n'], evidenceIds: ['record-one'] }],
                }),
              },
            },
          ],
        }),
      ),
  );
  await assert.rejects(extractor.extract([]), { code: 'MODEL_INVALID_SCHEMA' });
});

test('AI text and tag normalization matches persisted memory and response contracts', async () => {
  const f = fixture({
    model: 'trim-test',
    async extract(items) {
      return {
        memories: [
          {
            ...candidate,
            title: ' Reading:fiction ',
            content: '\nat night\t',
            tags: [' reading ', '\n沟通\t'],
            evidenceIds: [items[0]!.id],
          },
        ],
      };
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    const run = await f.client.call('analysis.run', {});
    assert.equal(run.proposed, 1);
    const stored = f.store.list('memories')[0]!;
    assert.equal(stored.title, 'Reading:fiction');
    assert.equal(stored.content, 'at night');
    assert.deepEqual(stored.tags, ['reading', '沟通']);
    assert.deepEqual(memorySchema.parse(stored), stored);
    assert.deepEqual((await f.client.call('snapshot.get', {})).memories, [stored]);
    assert.equal(
      f.store.list('observations')[0]!.analyzedHash,
      f.store.list('observations')[0]!.contentHash,
    );
  } finally {
    f.store.close();
  }
});

function collidingCandidates(evidenceId: string): Extraction {
  return {
    memories: [
      { ...candidate, evidenceIds: [evidenceId] },
      {
        ...candidate,
        title: 'Reading',
        content: 'fiction:at night',
        evidenceIds: [evidenceId],
      },
      {
        ...candidate,
        title: ' READING:FICTION ',
        content: ' AT NIGHT ',
        evidenceIds: [evidenceId],
      },
    ],
  };
}

test('same-batch deduplication preserves distinct title/content tuples containing delimiters', async () => {
  const f = fixture({
    model: 'fingerprint-test',
    async extract(items) {
      return collidingCandidates(items[0]!.id);
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    const run = await f.client.call('analysis.run', {});
    assert.equal(run.proposed, 2);
    const pairs = f.store
      .list('memories')
      .map(({ title, content }) => [title, content])
      .sort();
    assert.deepEqual(pairs, [
      ['Reading', 'fiction:at night'],
      ['Reading:fiction', 'at night'],
    ]);
  } finally {
    f.store.close();
  }
});

test('existing memories only suppress the same normalized tuple, not ambiguous delimiter matches', async () => {
  const f = fixture({
    model: 'existing-fingerprint-test',
    async extract(items) {
      return collidingCandidates(items[0]!.id);
    },
  });
  try {
    await f.client.call('sources.create', source);
    await f.client.call('observations.import', {
      sourceId: source.id,
      observations: [observation()],
    });
    const existing = await f.client.call('memories.create', { ...memory, ...candidate });
    const run = await f.client.call('analysis.run', {});
    assert.equal(run.proposed, 1);
    const memories = f.store.list('memories');
    assert.equal(memories.length, 2);
    assert.deepEqual(f.store.need('memories', existing.id), existing);
    assert.ok(
      memories.some(
        (item) =>
          item.title === 'Reading' && item.content === 'fiction:at night' && item.origin === 'ai',
      ),
    );
  } finally {
    f.store.close();
  }
});
