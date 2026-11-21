import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
try {
  await writeFile(
    new URL('../.env', import.meta.url),
    template.replace('replace-with-at-least-32-random-characters', randomBytes(32).toString('hex')),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已创建 .env，随机 API 密钥已生成。AI 分析暂未配置。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env 已存在，保留现有配置。');
}
