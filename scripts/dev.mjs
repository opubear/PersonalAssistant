import { spawn } from 'node:child_process';

const processGroups = process.platform !== 'win32';
const children = ['dev:server', 'dev:bridge', 'dev:web'].map((script) =>
  spawn('npm', ['run', script], { stdio: 'inherit', detached: processGroups }),
);
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (processGroups && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    } else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
