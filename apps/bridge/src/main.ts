import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AssistantClient } from '@qiyi/client';
import { transportFromEnv } from '@qiyi/client/node';
import { createAdapterRuntime, readAdapterConfig } from '@qiyi/adapters/node';
import { createBridge } from './http.js';

config({ path: process.env.ENV_FILE ?? '.env', quiet: true });
process.umask(0o077);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.BRIDGE_PORT ?? 4311);
const transport = transportFromEnv();
const runtime = createAdapterRuntime(
  new AssistantClient(transport),
  await readAdapterConfig(process.env.ADAPTER_CONFIG ?? './adapter.config.json'),
);
const staticRoot = resolve('dist/web');
const app = await createBridge({
  port,
  transport,
  runtime,
  mode: process.env.TRANSPORT ?? 'http',
  staticRoot: existsSync(staticRoot) ? staticRoot : undefined,
  logger: true,
});
await app.listen({ port, host: '127.0.0.1' });
runtime.start((error) => app.log.error({ err: error }, 'Adapter cycle failed'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
