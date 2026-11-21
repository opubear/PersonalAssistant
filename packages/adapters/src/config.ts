import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { z } from 'zod';
import { idSchema, sourceKindSchema } from '@qiyi/contracts';
import type { AssistantClient } from '@qiyi/client';
import { JsonlCollector } from './files.js';
import { builtInActions, commandAction, commandConfigSchema } from './actions.js';
import { defaultImportRegistry, type ImportRegistry } from './imports.js';
import { AdapterRuntime, type RuntimeRegistrations, type ReportConflict } from './runtime.js';

/** Node host configuration. Generic orchestration never reads paths or builds plugins. */
export const adapterConfigSchema = z
  .object({
    deviceId: idSchema,
    pollIntervalMs: z.number().int().min(5000).max(3600000).default(30000),
    outputDirectory: z.string().min(1),
    collectors: z
      .array(
        z
          .object({ sourceId: idSchema, format: sourceKindSchema, path: z.string().min(1) })
          .strict(),
      )
      .max(30),
    commands: z.array(commandConfigSchema).max(30).default([]),
  })
  .strict();
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export async function readAdapterConfig(path: string): Promise<AdapterConfig> {
  const config = adapterConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const base = dirname(resolve(path));
  const expand = (value: string) =>
    value.startsWith('~/')
      ? resolve(homedir(), value.slice(2))
      : isAbsolute(value)
        ? value
        : resolve(base, value);
  return {
    ...config,
    outputDirectory: expand(config.outputDirectory),
    collectors: config.collectors.map((item) => ({ ...item, path: expand(item.path) })),
  };
}

export function createAdapterRuntime(
  client: AssistantClient,
  input: AdapterConfig,
  extensions: RuntimeRegistrations & { formats?: ImportRegistry } = {},
): AdapterRuntime {
  const config = adapterConfigSchema.parse(input);
  const formats = extensions.formats ?? defaultImportRegistry;
  return new AdapterRuntime(
    client,
    { deviceId: config.deviceId, deviceName: hostname(), pollIntervalMs: config.pollIntervalMs },
    {
      collectors: [
        ...config.collectors.map(
          (item) => new JsonlCollector(item.sourceId, item.path, item.format, formats),
        ),
        ...(extensions.collectors ?? []),
      ],
      actions: [
        ...builtInActions(config.outputDirectory),
        ...config.commands.map(commandAction),
        ...(extensions.actions ?? []),
      ],
      onReportConflict: async (conflict) => {
        await archiveReportConflict(config.outputDirectory, conflict);
        await extensions.onReportConflict?.(conflict);
      },
    },
  );
}

async function archiveReportConflict(
  outputDirectory: string,
  conflict: ReportConflict,
): Promise<void> {
  idSchema.parse(conflict.jobId);
  const directory = join(outputDirectory, 'report-conflicts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // No claim token is archived. Retry replaces the same diagnostic, never executes a tool.
  await writeFile(join(directory, `${conflict.jobId}.json`), JSON.stringify(conflict, null, 2), {
    mode: 0o600,
  });
}
