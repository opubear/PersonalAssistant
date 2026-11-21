import { config } from 'dotenv';
import { parseRpcRequest, rpcReplySchema } from '@qiyi/contracts';
import { HttpTransport } from '@qiyi/client';
import { required } from '@qiyi/client/node';

// A single JSON request per SSH process. stdout is exclusively the JSON response.
config({ path: process.env.ENV_FILE ?? '.env', quiet: true });
try {
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => {
    console.error('Gateway input timed out');
    process.exit(1);
  }, 10_000);
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk);
    if (size > 4 * 1024 * 1024) throw new Error('请求超过 4 MiB');
    chunks.push(Buffer.from(chunk));
  }
  clearTimeout(timeout);
  const request = parseRpcRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const port = Number(process.env.SERVER_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SERVER_PORT 无效');
  const transport = new HttpTransport(
    `http://127.0.0.1:${port}/rpc`,
    required(process.env, 'API_TOKEN'),
  );
  const reply = rpcReplySchema.parse(await transport.request(request.method, request.params));
  process.stdout.write(JSON.stringify(reply) + '\n');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gateway failed');
  process.exitCode = 1;
}
