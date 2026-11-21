import { randomUUID } from 'node:crypto';
import { AppError, type ClaimedJob, type Job, type JobInput } from '@qiyi/contracts';
import { assertRevision, publicJob, Store } from './store.js';
import { now } from './data-service.js';

export class JobService {
  constructor(private readonly store: Store) {}

  private validateTarget(input: JobInput): void {
    const device = this.store.need('devices', input.deviceId);
    if (!device.tools.some((tool) => tool.id === input.toolId))
      throw new AppError('TOOL_NOT_AVAILABLE', '此设备未注册该工具');
  }

  create(input: JobInput): Job {
    this.validateTarget(input);
    const job: Job = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      revision: 1,
      result: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      startedAt: null,
    };
    this.store.put('jobs', job.id, job);
    return job;
  }

  update(id: string, revision: number, input: JobInput): Job {
    return this.store.transaction(() => {
      const job = this.store.need('jobs', id);
      assertRevision(job, revision);
      if (job.status !== 'pending')
        throw new AppError('JOB_NOT_EDITABLE', '只有待批准的任务可以修改');
      this.validateTarget(input);
      return publicJob(
        this.store.put('jobs', id, { ...job, ...input, revision: revision + 1, updatedAt: now() }),
      );
    });
  }

  decide(id: string, revision: number, decision: 'approve' | 'cancel'): Job {
    return this.store.transaction(() => {
      const job = this.store.need('jobs', id);
      assertRevision(job, revision);
      const allowed =
        decision === 'approve'
          ? job.status === 'pending'
          : ['pending', 'approved'].includes(job.status);
      if (!allowed) throw new AppError('INVALID_JOB_STATE', '任务状态已改变，不能执行此操作', 409);
      // Retiring a tool must not prevent cancelling work that can no longer run.
      if (decision === 'approve') this.validateTarget(job);
      return publicJob(
        this.store.put('jobs', id, {
          ...job,
          status: decision === 'approve' ? 'approved' : 'cancelled',
          revision: revision + 1,
          updatedAt: now(),
        }),
      );
    });
  }

  claim(deviceId: string): ClaimedJob | null {
    return this.store.transaction(() => {
      const device = this.store.need('devices', deviceId);
      this.expireRunning();
      const job = this.store
        .list('jobs')
        .reverse()
        .find(
          (item) =>
            item.status === 'approved' &&
            item.deviceId === deviceId &&
            device.tools.some((tool) => tool.id === item.toolId),
        );
      if (!job) return null;
      const claimed: ClaimedJob = {
        ...publicJob(job),
        claimToken: randomUUID(),
        status: 'running',
        revision: job.revision + 1,
        startedAt: now(),
        updatedAt: now(),
      };
      this.store.put('jobs', job.id, claimed);
      return claimed;
    });
  }

  finish(id: string, claimToken: string, success: boolean, output: string): Job {
    return this.store.transaction(() => {
      const job = this.store.need('jobs', id);
      if (job.claimToken !== claimToken) throw new AppError('INVALID_CLAIM', '执行令牌不匹配', 409);
      const status = success ? 'succeeded' : 'failed';
      if (job.status === status && (success ? job.result : job.error) === output)
        return publicJob(job);
      if (job.status !== 'running')
        throw new AppError('INVALID_JOB_STATE', '此任务已结束，不能再次回报', 409);
      return publicJob(
        this.store.put('jobs', id, {
          ...job,
          status,
          result: success ? output : null,
          error: success ? null : output,
          revision: job.revision + 1,
          updatedAt: now(),
        }),
      );
    });
  }

  remove(id: string, revision: number): void {
    this.store.transaction(() => {
      const job = this.store.need('jobs', id);
      assertRevision(job, revision);
      if (['running', 'approved'].includes(job.status))
        throw new AppError('JOB_ACTIVE', '请先取消排队任务；正在运行的任务不能删除');
      this.store.remove('jobs', id);
    });
  }

  /** Never retry an ambiguous side effect after a worker crash. */
  expireRunning(): void {
    const cutoff = Date.now() - 5 * 60_000;
    for (const job of this.store.list('jobs')) {
      if (job.status !== 'running' || !job.startedAt || Date.parse(job.startedAt) > cutoff)
        continue;
      this.store.put('jobs', job.id, {
        ...job,
        status: 'failed',
        error: '执行端超过五分钟未回报，执行结果未知；请核对本机后决定是否新建任务。',
        revision: job.revision + 1,
        updatedAt: now(),
      });
    }
  }
}
