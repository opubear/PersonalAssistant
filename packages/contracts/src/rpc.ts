import { z } from 'zod';
import {
  idSchema,
  profileInputSchema,
  profileSchema,
  memoryInputSchema,
  memorySchema,
  sourceInputSchema,
  sourceSchema,
  observationInputSchema,
  observationSchema,
  toolSchema,
  deviceSchema,
  jobInputSchema,
  jobSchema,
  claimedJobSchema,
  analysisRunSchema,
  snapshotSchema,
  importResultSchema,
  contextResultSchema,
  exportDataSchema,
} from './entities.js';
const text = (max: number) => z.string().trim().min(1).max(max);
const emptySchema = z.object({}).strict();
const versionedId = z.object({ id: idSchema, revision: z.number().int().positive() }).strict();
export const memoryAttachmentInputSchema = z.object({
  mimeType: z.enum(['image/png', 'image/jpeg', 'text/plain']),
  data: z.string().min(1).max(28 * 1024 * 1024),
}).strict();
const requests = {
  'snapshot.get': emptySchema,
  'profile.update': profileInputSchema.extend({ revision: z.number().int().positive() }),
  'memories.create': memoryInputSchema,
  'memories.get': z.object({ id: idSchema }).strict(),
  'memories.list': emptySchema,
  'memories.attachment': z.object({ id: idSchema }).strict(),
  'memories.upload': z.object({
    requestId: z.uuid(),
    memory: memoryInputSchema,
    attachment: memoryAttachmentInputSchema.optional(),
    previous: versionedId.optional(),
  }).strict(),
  'memories.propose': memoryInputSchema
    .pick({ title: true, content: true, tags: true })
    .extend({ requestId: z.uuid() }),
  'memories.update': memoryInputSchema.extend({
    id: idSchema,
    revision: z.number().int().positive(),
  }),
  'memories.delete': versionedId,
  'sources.create': sourceInputSchema.extend({ id: idSchema }),
  'sources.list': emptySchema,
  'sources.update': sourceInputSchema.extend({
    id: idSchema,
    revision: z.number().int().positive(),
  }),
  'sources.delete': versionedId,
  'observations.import': z
    .object({ sourceId: idSchema, observations: z.array(observationInputSchema).min(1).max(50) })
    .strict(),
  'observations.list': z
    .object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  'observations.get': z.object({ id: idSchema }).strict(),
  'observations.update': observationInputSchema
    .omit({ externalId: true, identity: true })
    .extend({ id: idSchema, revision: z.number().int().positive() }),
  'observations.delete': versionedId,
  'analysis.run': z.object({ sourceId: idSchema.optional() }).strict(),
  'analysis.delete': z.object({ id: idSchema }).strict(),
  'context.get': z
    .object({
      query: z.string().max(1000).default(''),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  'devices.register': z
    .object({ id: idSchema, name: text(100), tools: z.array(toolSchema).max(50) })
    .strict(),
  'devices.list': emptySchema,
  'devices.delete': z.object({ id: idSchema }).strict(),
  'jobs.create': jobInputSchema,
  'jobs.propose': jobInputSchema.extend({ requestId: z.uuid() }),
  'jobs.update': jobInputSchema.extend({ id: idSchema, revision: z.number().int().positive() }),
  'jobs.decide': versionedId.extend({ decision: z.enum(['approve', 'cancel']) }),
  'jobs.delete': versionedId,
  'jobs.claim': z.object({ deviceId: idSchema }).strict(),
  'jobs.finish': z
    .object({
      id: idSchema,
      claimToken: text(100),
      success: z.boolean(),
      output: z.string().max(32000),
    })
    .strict(),
  'data.export': emptySchema,
} as const;

const deleted = z.object({ deleted: z.literal(true) });
export const rpcResultSchemas = {
  'snapshot.get': snapshotSchema,
  'profile.update': profileSchema,
  'memories.create': memorySchema,
  'memories.get': memorySchema,
  'memories.list': z.array(memorySchema),
  'memories.attachment': memoryAttachmentInputSchema,
  'memories.upload': memorySchema,
  'memories.propose': memorySchema,
  'memories.update': memorySchema,
  'memories.delete': deleted,
  'sources.create': sourceSchema,
  'sources.list': z.array(sourceSchema),
  'sources.update': sourceSchema,
  'sources.delete': deleted,
  'observations.import': importResultSchema,
  'observations.list': z.object({
    items: z.array(observationSchema),
    total: z.number().int().nonnegative(),
  }),
  'observations.get': observationSchema,
  'observations.update': observationSchema,
  'observations.delete': deleted,
  'analysis.run': analysisRunSchema,
  'analysis.delete': deleted,
  'context.get': contextResultSchema,
  'devices.register': deviceSchema,
  'devices.list': z.array(deviceSchema),
  'devices.delete': deleted,
  'jobs.create': jobSchema,
  'jobs.propose': jobSchema,
  'jobs.update': jobSchema,
  'jobs.decide': jobSchema,
  'jobs.delete': deleted,
  'jobs.claim': claimedJobSchema.nullable(),
  'jobs.finish': jobSchema,
  'data.export': exportDataSchema,
} satisfies Record<keyof typeof requests, z.ZodType>;

export const rpcSchemas = requests;
export type RpcMethod = keyof typeof rpcSchemas;
export type RpcParams<M extends RpcMethod> = z.input<(typeof rpcSchemas)[M]>;
export type RpcParsedParams<M extends RpcMethod> = z.output<(typeof rpcSchemas)[M]>;
export type RpcResults = { [M in RpcMethod]: z.output<(typeof rpcResultSchemas)[M]> };
export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParsedParams<M>) => RpcResults[M] | Promise<RpcResults[M]>;
};
export type RpcRequest = { [M in RpcMethod]: { method: M; params: RpcParsedParams<M> } }[RpcMethod];
export const rpcEnvelopeSchema = z
  .object({ method: z.string(), params: z.unknown().default({}) })
  .strict();
export const rpcReplySchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type RpcReply = z.infer<typeof rpcReplySchema>;
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
export function parseRpcRequest(value: unknown): RpcRequest {
  const envelope = rpcEnvelopeSchema.parse(value);
  if (!Object.hasOwn(rpcSchemas, envelope.method))
    throw new AppError('METHOD_NOT_FOUND', '未知 API 方法', 404);
  const method = envelope.method as RpcMethod;
  // The schema is selected by method; TS cannot preserve the correlation through object lookup.
  return { method, params: rpcSchemas[method].parse(envelope.params) } as RpcRequest;
}
export function parseRpcResult<M extends RpcMethod>(method: M, value: unknown): RpcResults[M] {
  const parsed = rpcResultSchemas[method].safeParse(value);
  if (!parsed.success) {
    const error = new AppError('INVALID_RESPONSE', `API ${method} 返回了不兼容的数据`, 502);
    error.cause = parsed.error;
    throw error;
  }
  return parsed.data as RpcResults[M];
}
export async function invokeRpc<M extends RpcMethod>(
  handlers: RpcHandlers,
  method: M,
  params: RpcParsedParams<M>,
): Promise<RpcResults[M]> {
  return parseRpcResult(method, await handlers[method](params));
}
