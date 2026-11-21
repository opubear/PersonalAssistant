import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AssistantClient, HttpTransport } from '@qiyi/client';
import { AppError } from '@qiyi/contracts';
import type { Remote } from './publications.js';

const settings = z.object({ url: z.url(), token: z.string().min(32) }).strict();

/** Separate credentials from server/collector configuration; loading never connects. */
export class ServerConnection {
  private config?: z.infer<typeof settings>;
  private configurationError?: string;
  readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, 'server-connection.json');
    if (existsSync(this.path)) {
      try { this.config = this.validate(JSON.parse(readFileSync(this.path, 'utf8'))); }
      catch { this.configurationError = '服务器配置无效，请重新设置；原配置文件未修改。'; }
    }
  }
  private validate(input: unknown) {
    const config = settings.parse(input);
    const url = new URL(config.url);
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
      throw new AppError('INVALID_SERVER', '请填写服务器基础地址，不带路径、查询参数或账号');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      throw new AppError('INVALID_SERVER', '远程服务器必须使用 HTTPS，本机可使用 HTTP');
    return { ...config, url: url.origin };
  }
  status() { return { configured: Boolean(this.config), url: this.config?.url ?? '', hasToken: Boolean(this.config?.token), error: this.configurationError }; }
  save(url: string, token: string) {
    const existing = this.config;
    const normalized = new URL(url).origin;
    const config = this.validate({ url, token: token || (normalized === existing?.url ? existing.token : '') });
    writeFileSync(this.path + '.tmp', JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(this.path + '.tmp', this.path);
    this.config = config;
    this.configurationError = undefined;
    return this.status();
  }
  clear() { rmSync(this.path, { force: true }); this.config = undefined; this.configurationError = undefined; }
  remote(): Remote {
    if (!this.config) throw new AppError('SERVER_NOT_CONFIGURED', '请先配置个人助手服务器；本地功能不受影响');
    const { url, token } = this.config;
    return { client: new AssistantClient(new HttpTransport(url + '/rpc', token)), label: url,
      identity: createHash('sha256').update(url + '\0' + token).digest('hex') };
  }
}
