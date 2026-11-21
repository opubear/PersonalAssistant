import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'dotenv';

const run = promisify(execFile);
const project = resolve('.');

test('MCP setup generates a private independent token once and preserves existing settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-mcp-setup-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await cp(join(project, 'scripts/setup-mcp.mjs'), join(directory, 'scripts/setup-mcp.mjs'));
    await cp(join(project, '.env.mcp.example'), join(directory, '.env.mcp.example'));
    const result = await run(process.execPath, [join(directory, 'scripts/setup-mcp.mjs')]);
    const path = join(directory, '.env.mcp');
    const initial = await readFile(path, 'utf8');
    const token = parse(initial).MCP_TOKEN;
    assert.match(token!, /^[a-f0-9]{64}$/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(!result.stdout.includes(token!));
    const edited = initial.replace('http://127.0.0.1:4310/mcp', 'https://assistant.example/mcp');
    await writeFile(path, edited);
    await run(process.execPath, [join(directory, 'scripts/setup-mcp.mjs')]);
    assert.equal(await readFile(path, 'utf8'), edited);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Skill installer creates the complete skill and never overwrites an existing installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-skill-install-'));
  const script = join(project, 'scripts/install-skill.mjs');
  try {
    await run(process.execPath, [script, '--target', directory]);
    const target = join(directory, 'qiyi-personal-assistant');
    assert.equal(
      await readFile(join(target, 'SKILL.md'), 'utf8'),
      await readFile(join(project, 'skills/qiyi-personal-assistant/SKILL.md'), 'utf8'),
    );
    await stat(join(target, 'agents/openai.yaml'));
    await writeFile(join(target, 'SKILL.md'), 'User-maintained instructions');
    await assert.rejects(run(process.execPath, [script, '--target', directory]), /目标已存在/);
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), 'User-maintained instructions');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Codex config export uses the explicit MCP file and keeps credentials off stdout and other configs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qiyi-codex-config-'));
  const token = 'synthetic-token-only-for-config-regression';
  try {
    const envPath = join(directory, 'custom.env');
    await writeFile(envPath, `MCP_TOKEN=${token}\nMCP_URL=https://assistant.example:8443/mcp\n`);
    await writeFile(join(directory, '.env'), 'DO_NOT_READ=private-sentinel');
    await writeFile(join(directory, 'config.toml'), '# user config\n');
    const { stdout, stderr } = await run(
      process.execPath,
      [
        '--conditions=qiyi-source',
        '--import',
        import.meta.resolve('tsx'),
        join(project, 'apps/server/src/mcp/configure-codex.ts'),
      ],
      { cwd: directory, env: { PATH: process.env.PATH, MCP_ENV_FILE: envPath } },
    );
    const target = join(directory, '.local/qiyi-mcp.toml');
    const content = await readFile(target, 'utf8');
    assert.ok(content.includes('https://assistant.example:8443/mcp'));
    assert.ok(content.includes(`Bearer ${token}`));
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
    assert.ok(!content.includes('private-sentinel'));
    assert.equal(await readFile(join(directory, 'config.toml'), 'utf8'), '# user config\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
