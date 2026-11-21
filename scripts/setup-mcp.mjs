import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../.env.mcp.example', import.meta.url), 'utf8');
try {
  await writeFile(
    new URL('../.env.mcp', import.meta.url),
    template.replace('MCP_TOKEN=', `MCP_TOKEN=${randomBytes(32).toString('hex')}`),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '已创建 .env.mcp 与独立随机令牌。设置 MCP_URL 后启动后端 npm run start:server；远端使用 HTTPS。',
  );
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env.mcp 已存在，保留现有配置。');
}
