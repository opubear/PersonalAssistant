import { z } from 'zod';
import { observationInputSchema, chatExternalId, type ObservationInput } from '@qiyi/contracts';
import type { ParseResult } from './types.js';

const chatSchema = z.object({
  id: z.string().min(1).max(240),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  conversationId: z.string().max(240).optional(),
});
const appEventSchema = z.object({
  id: z.string().min(1).max(240),
  app: z.string().min(1).max(100),
  activity: z.string().min(1).max(2000),
  timestamp: z.iso.datetime({ offset: true }),
  durationSeconds: z.number().min(0).max(86400).optional(),
});
const objectSchema = z.record(z.string(), z.unknown());

/** Pure parsers: usable by the web importer, desktop hosts and background collectors. */
export function parseBuiltIn(
  format: 'codex' | 'chat-jsonl' | 'app-jsonl',
  input: string,
  namespace = 'import',
): ParseResult {
  if (new TextEncoder().encode(input).length > 20 * 1024 * 1024)
    throw new Error('文件超过 20 MiB，请拆分后导入');
  const records = input.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ value: JSON.parse(line) as unknown, line: index + 1 }];
    } catch {
      throw new Error(`第 ${index + 1} 行不是有效 JSON`);
    }
  });
  const observations: ObservationInput[] = [];
  let ignored = 0;
  let sessionId = namespace;
  const hasCanonicalMessages =
    format === 'codex' &&
    records.some(({ value }) => {
      const row = objectSchema.safeParse(value);
      if (!row.success) return false;
      const payload = objectSchema.safeParse(row.data.payload);
      return (
        row.data.type === 'response_item' &&
        payload.success &&
        payload.data.type === 'message' &&
        ['user', 'assistant'].includes(String(payload.data.role))
      );
    });

  for (const { value, line } of records) {
    try {
      if (format === 'chat-jsonl') {
        const item = chatSchema.parse(value);
        const identity = {
          format: 'chat-jsonl' as const,
          messageId: item.id,
          ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        };
        observations.push(
          observationInputSchema.parse({
            externalId: chatExternalId(identity),
            identity,
            kind: 'chat',
            role: item.role,
            content: item.content,
            occurredAt: item.timestamp,
            metadata: item.conversationId ? { conversationId: item.conversationId } : {},
          }),
        );
      } else if (format === 'app-jsonl') {
        const item = appEventSchema.parse(value);
        observations.push(
          observationInputSchema.parse({
            externalId: item.id,
            kind: 'app',
            role: 'event',
            occurredAt: item.timestamp,
            content: `${item.app}：${item.activity}${item.durationSeconds === undefined ? '' : `（${item.durationSeconds} 秒）`}`,
            metadata: {
              app: item.app,
              activity: item.activity,
              ...(item.durationSeconds === undefined
                ? {}
                : { durationSeconds: item.durationSeconds }),
            },
          }),
        );
      } else {
        const row = objectSchema.parse(value);
        const payload = objectSchema.parse(row.payload ?? {});
        if (row.type === 'session_meta' && typeof payload.id === 'string') sessionId = payload.id;
        const parsed = parseCodexMessage(row, payload, sessionId, line, hasCanonicalMessages);
        if (parsed) observations.push(parsed);
        else ignored++;
      }
    } catch (error) {
      throw new Error(
        `第 ${line} 行数据无效：${error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : String(error)}`,
        { cause: error },
      );
    }
  }
  return { observations, ignored };
}

function parseCodexMessage(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  sessionId: string,
  line: number,
  canonical: boolean,
): ObservationInput | undefined {
  let role: 'user' | 'assistant';
  let content: string;
  if (
    row.type === 'response_item' &&
    payload.type === 'message' &&
    (payload.role === 'user' || payload.role === 'assistant')
  ) {
    role = payload.role;
    if (payload.phase === 'analysis' || payload.channel === 'analysis') return;
    if (!Array.isArray(payload.content)) return;
    content = payload.content
      .flatMap((part) => {
        const parsed = objectSchema.safeParse(part);
        return parsed.success &&
          ['input_text', 'output_text', 'text'].includes(String(parsed.data.type)) &&
          typeof parsed.data.text === 'string'
          ? [parsed.data.text]
          : [];
      })
      .join('\n');
  } else if (
    !canonical &&
    row.type === 'event_msg' &&
    ['user_message', 'agent_message'].includes(String(payload.type))
  ) {
    role = payload.type === 'user_message' ? 'user' : 'assistant';
    content = typeof payload.message === 'string' ? payload.message : '';
  } else return;
  // Runtime scaffolding is emitted as user messages in some Codex log versions.
  if (
    !content.trim() ||
    /^(<environment_context>|<permissions instructions>|# AGENTS\.md instructions for)/.test(
      content.trim(),
    )
  )
    return;
  return observationInputSchema.parse({
    externalId: `${sessionId}:${typeof payload.id === 'string' ? payload.id : (row.ordinal ?? line)}`,
    kind: 'chat',
    role,
    content,
    occurredAt: row.timestamp,
    metadata: { conversationId: sessionId, format: 'codex-rollout' },
  });
}
