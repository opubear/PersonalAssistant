import { readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** Build dependencies first; package manifests are the only workspace inventory. */
export async function packageWorkspaces() {
  const directories = await readdir(join(projectRoot, 'packages'), { withFileTypes: true });
  const pending = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async ({ name }) => {
        const directory = join(projectRoot, 'packages', name);
        const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        return { directory, manifest };
      }),
  );
  const names = new Set(pending.map(({ manifest }) => manifest.name));
  const ordered = [];
  const completed = new Set();
  while (pending.length) {
    const index = pending.findIndex(({ manifest }) =>
      Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).every(
        (name) => !names.has(name) || completed.has(name),
      ),
    );
    if (index < 0) throw new Error('Shared packages have a dependency cycle');
    const [workspace] = pending.splice(index, 1);
    ordered.push(workspace);
    completed.add(workspace.manifest.name);
  }
  return ordered;
}

export async function buildPackages() {
  for (const { directory, manifest } of await packageWorkspaces()) {
    await rm(join(directory, 'dist'), { recursive: true, force: true });
    console.log(`Building ${manifest.name}`);
    execFileSync(
      process.execPath,
      [
        join(projectRoot, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(directory, 'tsconfig.build.json'),
      ],
      { cwd: projectRoot, stdio: 'inherit' },
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPackages();
}
