import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { config } from 'dotenv';

config({ path: process.env.ENV_FILE ?? '.env', quiet: true });
export default defineConfig({
  root: resolve('apps/web'),
  resolve: { conditions: ['qiyi-source', 'module', 'browser', 'development|production'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 4311}`,
        changeOrigin: true,
        timeout: 120000,
        proxyTimeout: 120000,
      },
    },
  },
  build: { outDir: resolve('dist/web'), emptyOutDir: true },
});
