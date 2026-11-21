import { z } from 'zod';
import { chatIdentitySchema } from './identity.js';

export const sourceKindSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9._-]*$/);
const timestamp = z.iso.datetime({ offset: true });
const revision = z.number().int().positive();

export const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{N}_.:-]+$/u);
const recordFields = { id: idSchema, revision, createdAt: timestamp, updatedAt: timestamp };
const text = (max: number) => z.string().trim().min(1).max(max);
export const categorySchema = z.enum([
  'preference',
  'habit',
  'need',
  'goal',
  'background',
  'boundary',
]);
export const categoryLabels: Record<Category, string> = {
  preference: '偏好',
  habit: '习惯',
  need: '需求',
  goal: '目标',
  background: '背景',
  boundary: '边界',
};
export type Category = z.infer<typeof categorySchema>;

export const profileInputSchema = z
  .object({
    name: text(80),
    bio: z.string().max(2000),
    locale: text(40),
    timezone: text(80).refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, '无效时区'),
  })
  .strict();
export type ProfileInput = z.infer<typeof profileInputSchema>;
export const profileSchema = profileInputSchema.extend({ revision, updatedAt: timestamp }).strip();
export type Profile = z.infer<typeof profileSchema>;

export const memoryInputSchema = z
  .object({
    category: categorySchema,
    title: text(160),
    content: text(4000),
    summary: z.string().max(1200).optional(),
    tags: z.array(text(40)).max(12).default([]),
    confidence: z.number().min(0).max(1).default(1),
    status: z.enum(['proposed', 'confirmed', 'rejected']).default('confirmed'),
  })
  .strict();
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export const memorySchema = memoryInputSchema
  .extend({
    ...recordFields,
    tags: z.array(text(40)).max(12),
    confidence: z.number().min(0).max(1),
    status: z.enum(['proposed', 'confirmed', 'rejected']),
    origin: z.enum(['manual', 'ai', 'agent']),
    evidenceIds: z.array(idSchema),
    evidenceStale: z.boolean(),
    attachment: z.object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.enum(['image/png', 'image/jpeg', 'text/plain']),
      size: z.number().int().positive().max(20 * 1024 * 1024),
    }).optional(),
  })
  .strip();
export type Memory = z.infer<typeof memorySchema>;

export const sourceInputSchema = z
  .object({
    name: text(80),
    kind: sourceKindSchema,
    enabled: z.boolean(),
    autoAnalyze: z.boolean(),
  })
  .strict();
export type SourceInput = z.infer<typeof sourceInputSchema>;
export const sourceSchema = sourceInputSchema.extend(recordFields).strip();
export type Source = z.infer<typeof sourceSchema>;

export const observationInputSchema = z
  .object({
    externalId: text(512),
    identity: chatIdentitySchema.optional(),
    kind: z.enum(['chat', 'app', 'note']),
    role: z.enum(['user', 'assistant', 'event']),
    content: text(20000),
    occurredAt: z.iso.datetime({ offset: true }),
    metadata: z
      .record(z.string().max(80), z.union([z.string().max(1000), z.number().finite(), z.boolean()]))
      .refine(
        (value) => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 8000,
        '元数据最多 32 个字段、8000 字符',
      )
      .default({}),
  })
  .strict();
export type ObservationInput = z.infer<typeof observationInputSchema>;
export const observationSchema = observationInputSchema
  .extend({
    ...recordFields,
    sourceId: idSchema,
    contentHash: z.string(),
    analyzedHash: z.string().nullable(),
    metadata: observationInputSchema.shape.metadata.removeDefault(),
    edited: z.boolean(),
  })
  .strip();
export type Observation = z.infer<typeof observationSchema>;

export const toolSchema = z
  .object({
    id: idSchema,
    title: text(100),
    description: text(500),
    example: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolInfo = z.infer<typeof toolSchema>;
export const deviceSchema = z.object({
  id: idSchema,
  name: text(100),
  tools: z.array(toolSchema),
  lastSeenAt: timestamp,
});
export type Device = z.infer<typeof deviceSchema>;
export const jobInputSchema = z
  .object({
    deviceId: idSchema,
    toolId: idSchema,
    title: text(160),
    input: z
      .record(z.string(), z.unknown())
      .refine((value) => JSON.stringify(value).length <= 32000, '工具参数过大'),
  })
  .strict();
export type JobInput = z.infer<typeof jobInputSchema>;
export const jobSchema = jobInputSchema
  .extend({
    ...recordFields,
    status: z.enum(['pending', 'approved', 'running', 'succeeded', 'failed', 'cancelled']),
    result: z.string().nullable(),
    error: z.string().nullable(),
    startedAt: timestamp.nullable(),
  })
  .strip();
export const claimedJobSchema = jobSchema.extend({ claimToken: text(100) });
export type Job = z.infer<typeof jobSchema>;
export type ClaimedJob = z.infer<typeof claimedJobSchema>;
export const analysisRunSchema = z.object({
  id: idSchema,
  status: z.enum(['running', 'succeeded', 'failed']),
  count: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;
export const systemStatusSchema = z.object({
  automaticAnalysisPause: z.string().nullable(),
  aiConfigured: z.boolean(),
  model: z.string().nullable(),
  database: z.literal('sqlite'),
  version: z.string(),
});
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export const snapshotSchema = z.object({
  profile: profileSchema,
  memories: z.array(memorySchema),
  sources: z.array(sourceSchema),
  observations: z.array(observationSchema),
  observationCount: z.number().int().nonnegative(),
  pendingAnalysis: z.number().int().nonnegative(),
  jobs: z.array(jobSchema),
  devices: z.array(deviceSchema),
  analysisRuns: z.array(analysisRunSchema),
  system: systemStatusSchema,
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const importResultSchema = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ImportResult = z.infer<typeof importResultSchema>;
export const contextResultSchema = z.object({
  markdown: z.string(),
  memories: z.array(memorySchema),
});
export type ContextResult = z.infer<typeof contextResultSchema>;
export const exportDataSchema = z.object({
  version: z.literal(1),
  exportedAt: timestamp,
  profile: profileSchema,
  memories: z.array(memorySchema),
  sources: z.array(sourceSchema),
  observations: z.array(observationSchema),
  jobs: z.array(jobSchema),
  devices: z.array(deviceSchema),
  analysisRuns: z.array(analysisRunSchema),
});
export type ExportData = z.infer<typeof exportDataSchema>;
