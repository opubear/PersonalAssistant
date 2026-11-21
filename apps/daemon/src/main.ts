import { config } from 'dotenv';
import { clientFromEnv } from '@qiyi/client/node';
import { createAdapterRuntime, readAdapterConfig } from '@qiyi/adapters/node';

config({ path: process.env.ENV_FILE ?? '.env', quiet: true });
process.umask(0o077);
const runtime = createAdapterRuntime(
  clientFromEnv(),
  await readAdapterConfig(process.env.ADAPTER_CONFIG ?? './adapter.config.json'),
);
if (process.argv.includes('--once')) {
  await runtime.sync();
  console.log(JSON.stringify(runtime.status()));
} else {
  runtime.start((error) => console.error(new Date().toISOString(), error));
  console.log(`适配后台服务已启动：${runtime.config.deviceId}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await runtime.stop();
      process.exitCode = 0;
    });
}
