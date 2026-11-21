import { spawn } from 'node:child_process';
import { AppError, type RpcMethod } from '@qiyi/contracts';
import { AssistantClient, HttpTransport, type Transport } from './index.js';

export type SshOptions = {
  host: string;
  port?: number;
  command: string;
  identityFile?: string;
  executable?: string;
};

export function sshArguments(options: SshOptions): string[] {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(options.host))
    throw new Error('SSH_HOST 必须是 SSH 配置别名或 user@host');
  if (!options.command.trim() || /[\r\n\0]/.test(options.command))
    throw new Error('SSH_COMMAND 必须是非空单行命令');
  const port = options.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH_PORT 无效');
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-p',
    String(port),
    ...(options.identityFile ? ['-i', options.identityFile] : []),
    options.host,
    options.command,
  ];
}

/** Remote command is trusted local configuration; all request data travels over stdin. */
export class SshTransport implements Transport {
  private readonly args: string[];
  constructor(private readonly options: SshOptions) {
    this.args = sshArguments(options);
  }

  async request(method: RpcMethod, params: unknown): Promise<unknown> {
    return runJsonProcess(this.options.executable ?? 'ssh', this.args, { method, params });
  }
}

export function runJsonProcess(
  executable: string,
  args: string[],
  input: unknown,
  timeoutMs = 115_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== 'win32';
    const child = spawn(executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: processGroup,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: Error | undefined;
    const abort = (error: Error) => {
      failure ??= error;
      if (processGroup && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
        }
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => abort(new AppError('SSH_TIMEOUT', 'SSH 网关请求超时')),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) abort(new AppError('RESPONSE_TOO_LARGE', '网关响应超过 16 MiB'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.stdin.on('error', (error) => {
      failure ??= error;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0)
        return reject(new AppError('SSH_FAILED', `SSH 网关失败（${code}）：${stderr.trim()}`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (cause) {
        reject(new Error('网关未返回合法 JSON；请检查远端 stdout 是否混入登录提示', { cause }));
      }
    });
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}

export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): Transport {
  if (env.TRANSPORT === 'ssh')
    return new SshTransport({
      host: required(env, 'SSH_HOST'),
      command: required(env, 'SSH_COMMAND'),
      port: Number(env.SSH_PORT ?? '22'),
      identityFile: env.SSH_IDENTITY_FILE || undefined,
    });
  if (env.TRANSPORT && env.TRANSPORT !== 'http') throw new Error('TRANSPORT 只支持 http 或 ssh');
  const url = new URL(env.SERVER_URL ?? 'http://127.0.0.1:4310');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('HTTP 明文传输只允许本机地址；远端请使用 SSH 或 HTTPS');
  return new HttpTransport(new URL('/rpc', url).href, required(env, 'API_TOKEN'));
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): AssistantClient {
  return new AssistantClient(transportFromEnv(env));
}

export function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`缺少配置 ${key}`);
  return value;
}
