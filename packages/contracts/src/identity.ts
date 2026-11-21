import { z } from 'zod';

/** Immutable import identity; editable metadata never owns deduplication. */
export const chatIdentitySchema = z
  .object({
    format: z.literal('chat-jsonl'),
    conversationId: z.string().min(1).max(240).optional(),
    messageId: z.string().min(1).max(240),
  })
  .strict();
export type ChatIdentity = z.infer<typeof chatIdentitySchema>;

/** Length framing distinguishes separators, absent conversations and arbitrary Unicode. */
export function chatExternalId(identity: ChatIdentity): string {
  const conversation =
    identity.conversationId === undefined
      ? 'n'
      : `s${identity.conversationId.length}:${identity.conversationId}`;
  return `chat:v2:${conversation}:${identity.messageId.length}:${identity.messageId}:`;
}
export function legacyChatExternalId(identity: ChatIdentity): string {
  return (
    identity.conversationId
      ? `${identity.conversationId}:${identity.messageId}`
      : identity.messageId
  ).trim();
}
