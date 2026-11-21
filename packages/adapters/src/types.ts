import type { ObservationInput, ToolInfo } from '@qiyi/contracts';
import type { AssistantClient } from '@qiyi/client';

/** Explicit acknowledgment lets hosts isolate a rejected batch without advancing its cursor. */
export interface CollectionBatch {
  observations: ObservationInput[];
  label?: string;
  acknowledge(): void | Promise<void>;
}
export interface Collector {
  readonly sourceId: string;
  /** Source kind produced by this instance. Omit only for legacy, format-agnostic collectors. */
  readonly kind?: string;
  collect(): AsyncIterable<ObservationInput[] | CollectionBatch>;
}
export interface ActionAdapter {
  readonly info: ToolInfo;
  execute(
    input: Record<string, unknown>,
    context: { jobId: string; client: AssistantClient },
  ): Promise<string>;
}
export type ImportFormat = string;
export type ParseResult = { observations: ObservationInput[]; ignored: number };
export interface ImportParser {
  readonly id: string;
  readonly title: string;
  parse(input: string, namespace: string): ParseResult;
}
