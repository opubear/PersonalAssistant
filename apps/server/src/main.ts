import { config } from 'dotenv';
import { z } from 'zod';
import { Store } from './store.js';
import { AssistantService } from './service.js';
import { extractorFromEnv } from './extractor.js';
import { createServer } from './http.js';
import { required } from '@qiyi/client/node';
import { optionalMcpConfig } from './mcp/config.js';

config({ path: process.env.ENV_FILE ?? '.env', quiet: true });
config({ path: process.env.MCP_ENV_FILE ?? '.env.mcp', quiet: true });
process.umask(0o077);
const mcp = optionalMcpConfig();
const store = new Store(process.env.DATABASE_PATH ?? './data/assistant.sqlite');
const service = new AssistantService(store, extractorFromEnv(process.env));
const app = createServer(service, required(process.env, 'API_TOKEN'), true, mcp);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.SERVER_PORT ?? 4310);

const timer = setInterval(() => {
  if (
    !service.analysis.extractor ||
    service.analysis.automaticPause ||
    !service.analysis.pending(undefined, true).length
  )
    return;
  void service.analysis.run(undefined, true).catch((error) => {
    if (error.code !== 'ANALYSIS_BUSY') app.log.error({ err: error }, 'Automatic analysis failed');
  });
}, 30_000);
app.addHook('onClose', async () => {
  clearInterval(timer);
  await service.analysis.idle();
  store.close();
});
await app.listen({ port, host: process.env.SERVER_HOST ?? '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
