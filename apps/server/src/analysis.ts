import { randomUUID } from 'node:crypto';
import {
  AppError,
  memorySchema,
  type AnalysisRun,
  type Memory,
  type Observation,
} from '@qiyi/contracts';
import { Store } from './store.js';
import { now } from './data-service.js';
import { extractionSchema, type Extractor } from './extractor.js';

export class AnalysisService {
  private active: Promise<AnalysisRun> | undefined;
  constructor(
    private readonly store: Store,
    readonly extractor?: Extractor,
  ) {
    for (const run of store.list('analysis')) {
      if (run.status === 'running')
        store.put('analysis', run.id, {
          ...run,
          status: 'failed',
          error: '服务器重启中断分析；未处理的数据可重新分析。',
          updatedAt: now(),
        });
    }
  }

  pending(sourceId?: string, automatic = false): Observation[] {
    const enabled = new Set(
      this.store
        .list('sources')
        .filter(
          (source) =>
            source.enabled &&
            (!automatic || source.autoAnalyze) &&
            (!sourceId || source.id === sourceId),
        )
        .map((source) => source.id),
    );
    return this.store
      .list('observations')
      .reverse()
      .filter(
        (item) =>
          enabled.has(item.sourceId) &&
          item.role !== 'assistant' &&
          item.analyzedHash !== item.contentHash,
      );
  }

  get automaticPause(): string | null {
    return this.store.get('runtime', 'analysis')?.automaticAnalysisPause ?? null;
  }

  async run(sourceId?: string, automatic = false): Promise<AnalysisRun> {
    if (!this.extractor)
      throw new AppError(
        'AI_NOT_CONFIGURED',
        '请在服务器 .env 配置 MODEL_BASE_URL 和 MODEL_NAME',
        503,
      );
    if (this.active) throw new AppError('ANALYSIS_BUSY', '已有分析正在进行，请稍后查看结果', 409);
    if (automatic && this.automaticPause)
      throw new AppError(
        'AUTOMATIC_ANALYSIS_PAUSED',
        '自动分析已暂停，请先手动分析并排除错误',
        409,
      );
    const pending = this.pending(sourceId, automatic);
    const batch: Observation[] = [];
    let chars = 0;
    for (const item of pending) {
      const cost = JSON.stringify(item).length;
      if (batch.length >= 25 || chars + cost > 70_000) break;
      batch.push(item);
      chars += cost;
    }
    if (!batch.length)
      throw new AppError('NOTHING_TO_ANALYZE', '没有待分析的用户消息或使用事件', 409);
    this.active = this.analyze(batch);
    try {
      const result = await this.active;
      this.store.put('runtime', 'analysis', { automaticAnalysisPause: null });
      return result;
    } catch (error) {
      if (automatic)
        this.store.put('runtime', 'analysis', {
          automaticAnalysisPause:
            error instanceof AppError ? error.message : '模型请求或结果校验失败',
        });
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  async idle(): Promise<void> {
    await this.active?.catch(() => undefined);
  }

  private async analyze(batch: Observation[]): Promise<AnalysisRun> {
    const run: AnalysisRun = {
      id: randomUUID(),
      status: 'running',
      count: batch.length,
      proposed: 0,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.put('analysis', run.id, run);
    try {
      const output = extractionSchema.parse(await this.extractor!.extract(batch));
      return this.store.transaction(() => {
        const evidenceIds = new Set(batch.map((item) => item.id));
        if (output.memories.some((memory) => memory.evidenceIds.some((id) => !evidenceIds.has(id))))
          throw new AppError('MODEL_INVALID_EVIDENCE', '模型引用了批次之外的证据');
        for (const item of batch) {
          const current = this.store.get('observations', item.id);
          if (
            !current ||
            current.revision !== item.revision ||
            !this.store.get('sources', item.sourceId)?.enabled
          )
            throw new AppError(
              'ANALYSIS_STALE',
              '分析期间原始信息发生变化，本次提取已放弃，请重新分析',
              409,
            );
        }
        let proposed = 0;
        const fingerprints = new Set(this.store.list('memories').map(memoryFingerprint));
        for (const item of output.memories) {
          const memory = memorySchema.parse({
            ...item,
            id: randomUUID(),
            origin: 'ai',
            status: 'proposed',
            evidenceStale: false,
            revision: 1,
            createdAt: now(),
            updatedAt: now(),
          });
          const fingerprint = memoryFingerprint(memory);
          if (fingerprints.has(fingerprint)) continue;
          this.store.put('memories', memory.id, memory);
          fingerprints.add(fingerprint);
          proposed++;
        }
        for (const item of batch)
          this.store.put('observations', item.id, { ...item, analyzedHash: item.contentHash });
        return this.store.put('analysis', run.id, {
          ...run,
          proposed,
          status: 'succeeded',
          updatedAt: now(),
        });
      });
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : '模型请求或结果校验失败，请检查服务器日志后重试。';
      this.store.put('analysis', run.id, {
        ...run,
        status: 'failed',
        error: message,
        updatedAt: now(),
      });
      throw error;
    }
  }
}

function memoryFingerprint(memory: Pick<Memory, 'category' | 'title' | 'content'>): string {
  return JSON.stringify([
    memory.category,
    memory.title.trim().toLowerCase(),
    memory.content.trim().toLowerCase(),
  ]);
}
