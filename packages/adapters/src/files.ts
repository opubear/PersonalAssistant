import { opendir, readFile, lstat, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { defaultImportRegistry, type ImportRegistry } from './imports.js';
import type { Collector, CollectionBatch } from './types.js';
import type { ObservationInput } from '@qiyi/contracts';

/** Per-file failures remain visible without starving other files in the source. */
export class JsonlCollector implements Collector {
  private readonly fingerprints = new Map<string, string>();
  constructor(
    readonly sourceId: string,
    private readonly path: string,
    readonly kind: string,
    private readonly formats: ImportRegistry = defaultImportRegistry,
  ) {
    if (!formats.has(kind)) throw new Error(`当前宿主未注册导入格式：${kind}`);
  }
  async *collect(): AsyncIterable<CollectionBatch> {
    const failures: Error[] = [];
    for await (const path of filesAt(this.path, failures)) {
      let fingerprint: string;
      let observations: ObservationInput[];
      try {
        const metadata = await stat(path);
        fingerprint = `${metadata.mtimeMs}:${metadata.size}`;
        if (this.fingerprints.get(path) === fingerprint) continue;
        if (metadata.size > 20 * 1024 * 1024) throw new Error('日志文件超过 20 MiB');
        const raw = await readFile(path, 'utf8');
        const lastNewline = raw.lastIndexOf('\n');
        const completeLines = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : '';
        observations = this.formats.parse(
          this.kind,
          completeLines,
          basename(path, '.jsonl'),
        ).observations;
      } catch (error) {
        failures.push(fileError(path, error));
        continue;
      }
      yield {
        observations,
        label: path,
        // Advancing the iterator alone is not an acknowledgment of a successful upload.
        acknowledge: () => {
          this.fingerprints.set(path, fingerprint);
        },
      };
    }
    if (failures.length)
      throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  }
}
function fileError(path: string, cause: unknown): Error {
  return new Error(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}
async function* filesAt(path: string, failures: Error[], depth = 0): AsyncIterable<string> {
  try {
    if (depth > 12) throw new Error('日志目录嵌套超过 12 层');
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('采集目录或文件不能是符号链接');
    if (metadata.isFile()) {
      if (path.endsWith('.jsonl')) yield path;
      return;
    }
    for await (const entry of await opendir(path)) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* filesAt(join(path, entry.name), failures, depth + 1);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) yield join(path, entry.name);
    }
  } catch (error) {
    failures.push(fileError(path, error));
  }
}
