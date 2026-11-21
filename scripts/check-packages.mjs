import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { packageWorkspaces, projectRoot } from './build-packages.mjs';

const exec = promisify(execFile);
const workspaces = await packageWorkspaces();
const temporary = await mkdtemp(join(tmpdir(), 'qiyi-package-consumer-'));
const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
const version = (name) => {
  const value = lock.packages[`node_modules/${name}`]?.version;
  if (!value) throw new Error(`Missing locked dependency ${name}`);
  return value;
};

async function run(command, args, cwd = temporary) {
  try {
    return await exec(command, args, {
      cwd,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        // Never inherit a development source condition or NODE_PATH into the consumer.
        NODE_OPTIONS: '',
        NODE_PATH: '',
        npm_config_cache: join(tmpdir(), 'qiyi-package-npm-cache'),
      },
    });
  } catch (error) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${error.stdout ?? ''}${error.stderr ?? ''}`,
      {
        cause: error,
      },
    );
  }
}

/** Check each package independently so another package's hoisted dependency cannot hide an omission. */
async function checkDependencyDeclarations({ directory, manifest }) {
  const entryPoints = Object.values(manifest.exports).map((entry) =>
    join(directory, entry.default),
  );
  const result = await build({
    entryPoints,
    outdir: join(temporary, 'dependency-inspection'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const declared = { ...manifest.dependencies, ...manifest.peerDependencies };
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imported of output.imports.filter((entry) => entry.external)) {
      if (isBuiltin(imported.path)) continue;
      const name = imported.path.startsWith('@')
        ? imported.path.split('/').slice(0, 2).join('/')
        : imported.path.split('/')[0];
      assert.ok(declared[name], `${manifest.name} imports undeclared dependency ${name}`);
    }
  }
}

try {
  const dependencies = {};
  for (const workspace of workspaces) {
    await checkDependencyDeclarations(workspace);
    const packed = await run(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
      workspace.directory,
    );
    const [archive] = JSON.parse(packed.stdout);
    assert.ok(archive.files.some(({ path }) => path === 'dist/index.js'));
    assert.ok(archive.files.some(({ path }) => path === 'dist/index.d.ts'));
    assert.ok(
      archive.files.every(({ path }) => path === 'package.json' || path.startsWith('dist/')),
    );
    assert.ok(archive.files.every(({ path }) => !path.endsWith('.ts') || path.endsWith('.d.ts')));
    dependencies[workspace.manifest.name] = `file:${join(temporary, archive.filename)}`;
  }
  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify(
      {
        name: 'qiyi-isolated-consumer',
        private: true,
        type: 'module',
        dependencies: { ...dependencies, fastify: version('fastify') },
        devDependencies: { '@types/node': version('@types/node') },
        // Keep external versions reproducible without introducing direct zod dependencies.
        overrides: { zod: version('zod') },
      },
      null,
      2,
    ),
  );
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);

  await writeFile(
    join(temporary, 'node.mjs'),
    `
import assert from 'node:assert/strict';
import { AppError } from '@qiyi/contracts';
import { AssistantClient, HttpTransport } from '@qiyi/client';
import { SshTransport } from '@qiyi/client/node';
import { parseImport } from '@qiyi/adapters';
import { AdapterRuntime, JsonlCollector } from '@qiyi/adapters/node';
import { installErrors } from '@qiyi/http-support';
const client = new AssistantClient({ request: async () => ({ ok: true, data: [] }) });
assert.deepEqual(await client.call('sources.list', {}), []);
const failed = new AssistantClient({ request: async () => ({ ok: false, error: { code: 'TEST', message: 'expected' } }) });
await assert.rejects(failed.call('sources.list', {}), (error) => error instanceof AppError && error.code === 'TEST');
assert.equal(parseImport('chat-jsonl', JSON.stringify({ id: 'one', role: 'user', content: 'synthetic', timestamp: '2026-11-12T00:00:00Z' })).observations.length, 1);
for (const entry of [HttpTransport, SshTransport, AdapterRuntime, JsonlCollector, installErrors]) assert.equal(typeof entry, 'function');
console.log('Packed Node ESM entries and shared error identity passed');
`,
  );
  const nodeResult = await run(process.execPath, ['node.mjs']);
  process.stdout.write(nodeResult.stdout);

  await writeFile(
    join(temporary, 'consumer.mts'),
    `
import { AssistantClient } from '@qiyi/client';
import { SshTransport, type SshOptions } from '@qiyi/client/node';
import type { RpcResults, ObservationInput } from '@qiyi/contracts';
import type { Collector, ActionAdapter } from '@qiyi/adapters';
import { AdapterRuntime, JsonlCollector } from '@qiyi/adapters/node';
import { installErrors } from '@qiyi/http-support';
import Fastify from 'fastify';
const options: SshOptions = { host: 'example', command: 'gateway' };
const client = new AssistantClient(new SshTransport(options));
const sources: Promise<RpcResults['sources.list']> = client.call('sources.list', {});
const collector: Collector = new JsonlCollector('source', '/synthetic-only', 'chat-jsonl');
declare const runtime: AdapterRuntime;
declare const action: ActionAdapter;
declare const record: ObservationInput;
void [sources, collector, runtime.status(), action.info, record.content];
installErrors(Fastify());
// @ts-expect-error An unknown RPC method must not become any after packaging.
void client.call('unknown.method', {});
// @ts-expect-error Runtime request fields remain typed in an independent consumer.
void client.call('profile.update', { name: 42 });
`,
  );
  const compilerOptions = {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    typeRoots: ['./node_modules/@types'],
    types: ['node'],
  };
  await writeFile(
    join(temporary, 'tsconfig.json'),
    JSON.stringify({ compilerOptions, files: ['consumer.mts'] }),
  );
  const tsc = join(projectRoot, 'node_modules/typescript/bin/tsc');
  await run(process.execPath, [tsc, '-p', 'tsconfig.json']);

  await writeFile(
    join(temporary, 'browser.ts'),
    `
import { AssistantClient, HttpTransport } from '@qiyi/client';
import { parseImport, uploadObservations, type Collector } from '@qiyi/adapters';
import { observationInputSchema } from '@qiyi/contracts';
export { AssistantClient, HttpTransport, parseImport, uploadObservations, observationInputSchema };
export type { Collector };
`,
  );
  await writeFile(
    join(temporary, 'tsconfig.browser.json'),
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023', 'DOM'],
        types: [],
      },
      files: ['browser.ts'],
    }),
  );
  await run(process.execPath, [tsc, '-p', 'tsconfig.browser.json']);
  await build({
    absWorkingDir: temporary,
    entryPoints: ['browser.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  for (const entry of ['@qiyi/client/node', '@qiyi/adapters/node', '@qiyi/http-support']) {
    await assert.rejects(
      build({
        absWorkingDir: temporary,
        stdin: { contents: `import '${entry}';`, resolveDir: temporary },
        bundle: true,
        platform: 'browser',
        write: false,
        logLevel: 'silent',
      }),
      `Browser imports must reject ${entry}`,
    );
  }
  console.log('Packed NodeNext types, browser-only types and browser bundle passed');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
