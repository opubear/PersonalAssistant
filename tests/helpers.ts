import { AssistantClient } from '@qiyi/client';
import { AssistantService } from '../apps/server/src/service.js';
import { Store } from '../apps/server/src/store.js';
import type { Extractor } from '../apps/server/src/extractor.js';
import type { ObservationInput } from '@qiyi/contracts';

export function fixture(extractor?: Extractor) {
  const store = new Store(':memory:');
  const service = new AssistantService(store, extractor);
  const client = new AssistantClient({
    request: async (method, params) => ({
      ok: true,
      data: await service.dispatch({ method, params }),
    }),
  });
  return { store, service, client };
}
export const observation = (
  externalId = 'message-1',
  content = '我更喜欢简短、直接的回答。',
): ObservationInput => ({
  externalId,
  content,
  occurredAt: '2026-11-12T08:00:00.000Z',
  role: 'user',
  kind: 'chat',
  metadata: {},
});
export const source = {
  id: 'chat',
  name: '测试对话',
  kind: 'chat-jsonl' as const,
  enabled: true,
  autoAnalyze: false,
};
export const memory = {
  title: '回答简洁',
  content: '回答先给结论，尽量简洁。',
  category: 'preference' as const,
  tags: ['沟通'],
  confidence: 0.9,
  status: 'confirmed' as const,
};
