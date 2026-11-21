import { config } from 'dotenv';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readMcpConfig } from './config.js';

config({ path: process.env.MCP_ENV_FILE ?? '.env.mcp', quiet: true });
const settings = readMcpConfig();
const directory = resolve('.local');
const destination = resolve(directory, 'qiyi-mcp.toml');
const temporary = resolve(directory, `qiyi-mcp-${randomUUID()}.tmp`);
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  // A private snippet is reviewable and leaves the user's existing Codex configuration intact.
  const content = [
    '# Private MCP credential. Do not commit or paste into chats.',
    '[mcp_servers.qiyi-personal-assistant]',
    `url = ${JSON.stringify(settings.url)}`,
    `http_headers = { Authorization = "Bearer ${settings.token}" }`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    '',
  ].join('\n');
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await rename(temporary, destination);
  console.log(`已生成私有配置片段：${destination}`);
  console.log('将该片段合并到 Codex 配置中，保留已有其他服务；令牌未输出到终端。');
} finally {
  await rm(temporary, { force: true });
}
