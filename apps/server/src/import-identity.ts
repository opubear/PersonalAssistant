import {
  AppError,
  chatExternalId,
  legacyChatExternalId,
  type ObservationInput,
  type Observation,
  type ChatIdentity,
} from '@qiyi/contracts';
import { Store, type ImportKey } from './store.js';

type PreparedImport = { input: ObservationInput; key: ImportKey | undefined; keyVersion: 1 | 2 };
const legacyConversation = (input: ObservationInput) =>
  typeof input.metadata.conversationId === 'string' && input.metadata.conversationId
    ? input.metadata.conversationId
    : undefined;
const ambiguous = () =>
  new AppError(
    'LEGACY_ID_AMBIGUOUS',
    '旧记录的聊天标识有歧义，请核对原始记录并使用新版采集器',
    409,
  );

/** New identities retain every character. Legacy matching alone uses the old whole-ID trim rule. */
export function prepareImport(
  store: Store,
  sourceId: string,
  sourceKind: string,
  input: ObservationInput,
): PreparedImport {
  if (!input.identity) {
    if (sourceKind === 'chat-jsonl' && input.kind === 'chat')
      return prepareLegacyImport(store, sourceId, input);
    return { input, key: store.importKey(sourceId, input.externalId), keyVersion: 1 };
  }
  if (input.externalId !== chatExternalId(input.identity))
    throw new AppError('INVALID_IMPORT_ID', '聊天标识与外部 ID 不一致');
  const current = store.importKey(sourceId, input.externalId, 2);
  if (current) return { input, key: current, keyVersion: 2 };
  const legacy = store.importKey(sourceId, legacyChatExternalId(input.identity), 1);
  if (!legacy) return { input, key: undefined, keyVersion: 2 };
  // Old tombstones lost the tuple, so suppress all possible legacy aliases conservatively.
  if (legacy.observationId === null) {
    store.setImportKey(sourceId, input.externalId, null, 'deleted', 2);
    return { input, key: legacy, keyVersion: 2 };
  }
  const previous = store.need('observations', legacy.observationId);
  const sameIdentity = previous.identity
    ? chatExternalId(previous.identity) === input.externalId
    : legacyConversation(previous) === input.identity.conversationId;
  if (!sameIdentity) {
    if (previous.edited && !previous.identity) throw ambiguous();
    return { input, key: undefined, keyVersion: 2 };
  }
  // Never invert a legacy ID: its trailing whitespace may already have been lost.
  store.put('observations', previous.id, {
    ...previous,
    identity: input.identity,
    externalId: input.externalId,
    revision: previous.revision + 1,
    updatedAt: new Date().toISOString(),
  });
  store.setImportKey(sourceId, input.externalId, previous.id, legacy.hash, 2);
  return { input, key: legacy, keyVersion: 2 };
}

function prepareLegacyImport(
  store: Store,
  sourceId: string,
  input: ObservationInput,
): PreparedImport {
  const key = store.importKey(sourceId, input.externalId, 1);
  // Namespace 3 is only for old clients: a v2 deletion must not suppress distinct new v2 IDs.
  const deletedAlias = store.importKey(sourceId, input.externalId, 3);
  if (deletedAlias || key?.observationId === null)
    return { input, key: deletedAlias ?? key, keyVersion: 1 };
  const conversation = legacyConversation(input);
  const matches = store
    .list('observations')
    .filter(
      (item): item is Observation & { identity: ChatIdentity } =>
        item.sourceId === sourceId &&
        !!item.identity &&
        legacyChatExternalId(item.identity) === input.externalId &&
        item.identity.conversationId === conversation,
    );
  if (matches.length > 1) throw ambiguous();
  const existing = matches[0];
  if (existing) {
    const canonicalKey = store.importKey(sourceId, existing.externalId, 2);
    if (!canonicalKey) throw new Error('已迁移记录缺少导入索引');
    return {
      input: { ...input, identity: existing.identity, externalId: existing.externalId },
      key: canonicalKey,
      keyVersion: 2,
    };
  }
  if (key?.observationId) {
    const previous = store.need('observations', key.observationId);
    if (previous.identity || legacyConversation(previous) !== conversation) throw ambiguous();
  }
  // Keep a new legacy input in its original namespace until a v2 rescan supplies the full tuple.
  return { input, key, keyVersion: 1 };
}
