import { z } from 'zod';

export const mcpTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export type McpConfig = { token: string; url: string };

export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export function parseMcpUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && !isLoopbackHttp(url)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/mcp'
  )
    throw new Error('MCP_URL 必须为 HTTPS /mcp 地址，无账号、查询参数或片段；仅本机开发允许 HTTP');
  return url.href;
}

/** Shared by the backend listener and the private Codex configuration exporter. */
export function readMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  if (!env.MCP_TOKEN?.trim()) throw new Error('缺少配置 MCP_TOKEN');
  if (!env.MCP_URL?.trim())
    throw new Error('缺少配置 MCP_URL；请将旧版 MCP_PORT/SSH 配置迁移为服务器 /mcp 地址');
  return {
    token: mcpTokenSchema.parse(env.MCP_TOKEN.trim()),
    url: parseMcpUrl(env.MCP_URL.trim()),
  };
}

export function optionalMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig | undefined {
  if (!env.MCP_TOKEN?.trim() && !env.MCP_URL?.trim()) return undefined;
  return readMcpConfig(env);
}
