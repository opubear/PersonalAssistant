import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { buildPackages } from './build-packages.mjs';
import { rm } from 'node:fs/promises';

await buildPackages();
// Remove retired entry points as well as rebuilding current ones.
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: {
    'server/main': 'apps/server/src/main.ts',
    'server/gateway': 'apps/server/src/gateway.ts',
    'bridge/main': 'apps/bridge/src/main.ts',
    'daemon/main': 'apps/daemon/src/main.ts',
    'desktop/main': 'apps/desktop/src/main.ts',
    'server/configure-codex': 'apps/server/src/mcp/configure-codex.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  conditions: ['qiyi-source'],
  external: ['fastify', '@fastify/static', 'dotenv', 'zod', '@modelcontextprotocol/server'],
  sourcemap: true,
});
await buildWeb({ configFile: 'apps/web/vite.config.ts' });
