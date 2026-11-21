import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export class CaptureClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private closing = false;
  readonly ended: Promise<void>;
  onEvent: (name: string, data: Record<string, unknown>) => void = () => {};
  onExit: (error: Error) => void = () => {};

  constructor(executable: string, directory: string, hotkey: boolean) {
    this.child = spawn(executable, ['--directory', directory, ...(hotkey ? [] : ['--no-hotkey'])], { cwd: directory, stdio: 'pipe', shell: false });
    this.ended = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (data: Buffer) => this.consume(data));
    this.child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.once('error', error => { this.fail(error); this.onExit(error); });
    this.child.once('close', code => {
      const error = new Error(`截图服务已退出（${code}）`);
      this.fail(error);
      if (!this.closing) this.onExit(error);
    });
  }
  request(method: string, params: unknown = {}): Promise<unknown> {
    if (this.closing || this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.reject(new Error('截图服务未连接'));
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  private consume(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const value = JSON.parse(line);
        if (typeof value.event === 'string') this.onEvent(value.event, value.data ?? {});
        else {
          const pending = this.pending.get(value.id);
          this.pending.delete(value.id);
          if (value.error) pending?.reject(new Error(value.error.message));
          else pending?.resolve(value.result);
        }
      } catch { this.fail(new Error('截图服务返回无效 JSON')); this.child.kill(); }
    }
    if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new Error('截图服务响应过大')); this.child.kill(); }
  }
  private fail(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  async close() {
    if (!this.closing) { this.closing = true; this.child.stdin.end(); }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 4500);
    await this.ended;
    clearTimeout(timer);
  }
}
