import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { CaptureClient } from './capture-client.js';
import { DesktopController } from './controller.js';

process.umask(0o077);
const { values } = parseArgs({ options: {
  directory: { type: 'string' }, 'capture-backend': { type: 'string' },
  'local-directory': { type: 'string' }, 'no-hotkey': { type: 'boolean', default: false },
} });
if (!values.directory || !values['capture-backend']) throw new Error('需要 --directory 与 --capture-backend');
const directory = resolve(values.directory);
mkdirSync(directory, { recursive: true });
const capture = new CaptureClient(resolve(values['capture-backend']), directory, !values['no-hotkey']);
let controller: DesktopController;
try { controller = new DesktopController(resolve(values['local-directory'] ?? join(directory, 'personal-local')), capture); }
catch (error) { await capture.close(); throw error; }
let closing: Promise<void> | undefined;
const active = new Map<string, Promise<void>>();
function emit(record: unknown) { process.stdout.write(JSON.stringify(record) + '\n'); }
capture.onEvent = (event, data) => emit({ event, data });
capture.onExit = error => { process.stderr.write(error.message + '\n'); void shutdown(1); };
async function shutdown(code = 0) {
  if (closing) return closing;
  closing = (async () => {
    process.stdin.pause();
    // Exit promptly after releasing the capture helper. Uncertain uploads keep
    // their durable operation ID and require a user-initiated retry next time.
    await capture.close();
    if (!active.size) controller.close();
    process.exit(code);
  })();
  return closing;
}
const request = z.object({ id: z.string().min(1), method: z.string(), params: z.unknown().default({}) }).strict();
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  let newline: number;
  while ((newline = buffer.indexOf(10)) >= 0) {
    const line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (closing) return;
    try {
      if (line.length > 2 * 1024 * 1024) throw new Error('请求过大');
      const input = request.parse(JSON.parse(line.toString('utf8')));
      if (input.method === 'shutdown') { emit({ id: input.id, result: {} }); void shutdown(); return; }
      if (active.has(input.id) || active.size >= 64) throw new Error('重复请求或等待请求过多');
      const work = controller.dispatch(input.method, input.params).then(
        result => emit({ id: input.id, result }),
        error => emit({ id: input.id, error: { message: error instanceof Error ? error.message : '操作失败' } }),
      ).finally(() => active.delete(input.id));
      active.set(input.id, work);
    } catch (error) { emit({ event: 'warning', data: { message: error instanceof Error ? error.message : '请求无效' } }); }
  }
  if (buffer.length > 2 * 1024 * 1024) void shutdown(1);
});
process.stdin.once('end', () => { void shutdown(); });
process.stdout.on('error', () => { void shutdown(); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void shutdown(); });
