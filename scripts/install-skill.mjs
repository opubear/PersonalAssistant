import { cp, mkdir, lstat, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--target' || !args[1]))
  throw new Error('用法：npm run install:skill -- [--target <Skill父目录>]');
const root = args[1]
  ? resolve(args[1])
  : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
const target = join(root, 'qiyi-personal-assistant');
await mkdir(root, { recursive: true });
try {
  await lstat(target);
  throw new Error(`目标已存在，未覆盖：${target}。请先核对已有 Skill，再手动更新。`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Reserve the destination atomically; never merge over an existing user's skill.
await mkdir(target);
try {
  const source = new URL('../skills/qiyi-personal-assistant/', import.meta.url);
  for (const entry of await readdir(source))
    await cp(new URL(entry, source), join(target, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  console.log(`已安装个人助手 Skill：${target}。如未显示，请重新打开 Codex。`);
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
}
