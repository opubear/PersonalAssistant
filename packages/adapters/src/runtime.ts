import { AppError } from '@qiyi/contracts';
import type { AssistantClient } from '@qiyi/client';
import { uploadObservations } from './upload.js';
import type { ActionAdapter, Collector } from './types.js';

export type RuntimeConfig = { deviceId: string; deviceName?: string; pollIntervalMs: number };
export type ReportConflict = {
  jobId: string;
  success: boolean;
  output: string;
  code: string;
  message: string;
  detectedAt: string;
};
export type RuntimeRegistrations = {
  actions?: ActionAdapter[];
  collectors?: Collector[];
  onReportConflict?: (conflict: ReportConflict) => Promise<void>;
};
export type RuntimeStatus = {
  deviceId: string;
  running: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  collectors: { sourceId: string; format: string }[];
  tools: { id: string; title: string }[];
  reportConflicts: ReportConflict[];
};

/** Shared orchestration for the browser bridge and headless daemon. One cycle at a time. */
export class AdapterRuntime {
  private readonly collectors: Collector[];
  private readonly actions: Map<string, ActionAdapter>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private readonly reportConflicts: ReportConflict[] = [];
  private pendingReport:
    { id: string; claimToken: string; success: boolean; output: string } | undefined;

  constructor(
    private readonly client: AssistantClient,
    readonly config: RuntimeConfig,
    private readonly registrations: RuntimeRegistrations = {},
  ) {
    this.collectors = registrations.collectors ?? [];
    const registered = registrations.actions ?? [];
    this.actions = new Map(registered.map((action) => [action.info.id, action]));
    if (registered.length !== this.actions.size) throw new Error('存在重复的工具 ID');
  }

  status(): RuntimeStatus {
    return {
      deviceId: this.config.deviceId,
      running: Boolean(this.active),
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      collectors: this.collectors.map(({ sourceId, kind }) => ({
        sourceId,
        format: kind ?? 'custom',
      })),
      reportConflicts: this.reportConflicts.map((item) => ({ ...item })),
      tools: [...this.actions.values()].map(({ info: { id, title } }) => ({ id, title })),
    };
  }

  start(onError: (error: unknown) => void): void {
    if (this.timer) throw new Error('适配运行器已启动');
    const tick = () => {
      void this.sync().catch(onError);
    };
    this.timer = setInterval(tick, this.config.pollIntervalMs);
    tick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }

  async sync(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.cycle();
    try {
      await this.active;
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  private async cycle(): Promise<void> {
    await this.client.call('devices.register', {
      id: this.config.deviceId,
      name: this.config.deviceName ?? this.config.deviceId,
      tools: [...this.actions.values()].map((action) => action.info),
    });
    // Retrying a result must never execute the original side effect again.
    await this.flushReport();
    const sources = await this.client.call('sources.list', {});
    const failures: Error[] = [];
    for (const collector of this.collectors) {
      const source = sources.find((item) => item.id === collector.sourceId);
      if (!source) {
        failures.push(new Error(`请先创建来源 ${collector.sourceId}`));
        continue;
      }
      if (!source.enabled) continue;
      if (collector.kind && collector.kind !== source.kind) {
        failures.push(new Error(`来源 ${source.id} 的采集格式与服务器不一致`));
        continue;
      }
      try {
        for await (const batch of collector.collect()) {
          if (Array.isArray(batch)) {
            // Legacy collectors may advance their cursor on resume; close them on failure.
            await uploadObservations(this.client, collector.sourceId, batch);
            continue;
          }
          try {
            await uploadObservations(this.client, collector.sourceId, batch.observations);
            await batch.acknowledge();
          } catch (error) {
            // Per-record business rejection must not starve unrelated files. Network failures
            // end this collector's cycle instead of paying a timeout for every remaining file.
            if (
              !(error instanceof AppError) ||
              !['VALIDATION_ERROR', 'LEGACY_ID_AMBIGUOUS', 'INVALID_IMPORT_ID'].includes(error.code)
            )
              throw error;
            failures.push(
              new Error(`${batch.label ?? collector.sourceId}: ${error.message}`, { cause: error }),
            );
          }
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    await this.executeOne();
    if (failures.length)
      throw new AggregateError(failures, failures.map((error) => error.message).join('; '));
  }

  private async executeOne(): Promise<void> {
    const job = await this.client.call('jobs.claim', { deviceId: this.config.deviceId });
    if (!job) return;
    const action = this.actions.get(job.toolId);
    if (!action) throw new Error(`服务器分配了未注册工具 ${job.toolId}`);
    let success = true;
    let output: string;
    try {
      output = await action.execute(job.input, { jobId: job.id, client: this.client });
    } catch (error) {
      success = false;
      output = error instanceof Error ? error.message : String(error);
    }
    this.pendingReport = {
      id: job.id,
      claimToken: job.claimToken,
      success,
      output: output.slice(0, 32000),
    };
    await this.flushReport();
  }

  private async flushReport(): Promise<void> {
    const report = this.pendingReport;
    if (!report) return;
    try {
      await this.client.call('jobs.finish', report);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !['INVALID_JOB_STATE', 'NOT_FOUND', 'INVALID_CLAIM'].includes(error.code)
      )
        throw error;
      const conflict: ReportConflict = {
        jobId: report.id,
        success: report.success,
        output: report.output,
        code: error.code,
        message: error.message,
        detectedAt: new Date().toISOString(),
      };
      // The Node host archives this before we release the queue. Never discard on an I/O failure.
      await this.registrations.onReportConflict?.(conflict);
      this.reportConflicts.push(conflict);
      if (this.reportConflicts.length > 20) this.reportConflicts.shift();
    }
    this.pendingReport = undefined;
  }
}
