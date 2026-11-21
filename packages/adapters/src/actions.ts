import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runJsonProcess } from '@qiyi/client/node';
import { idSchema } from '@qiyi/contracts';
import type { ActionAdapter } from './index.js';

async function writeOnce(directory: string, filename: string, content: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if ((await readFile(path, 'utf8')) !== content)
      throw new Error('同一任务对应的输出文件已存在且内容不同，停止覆盖');
  }
  return path;
}

export function builtInActions(directory: string): ActionAdapter[] {
  return [
    {
      info: {
        id: 'notes.create',
        title: '保存本地笔记',
        description: '在配置的输出目录写入 Markdown 笔记；文件名由任务 ID 决定。',
        example: { title: '本周计划', content: '每天留出一小时阅读。' },
      },
      async execute(input, { jobId }) {
        idSchema.parse(jobId);
        const note = z
          .object({ title: z.string().trim().min(1).max(160), content: z.string().max(20000) })
          .strict()
          .parse(input);
        const path = await writeOnce(
          directory,
          `${jobId}.md`,
          `# ${note.title}\n\n${note.content}\n`,
        );
        return `笔记已保存：${path}`;
      },
    },
    {
      info: {
        id: 'profile.export',
        title: '导出个性化上下文',
        description: '将已确认的个人资料保存为本机 Markdown，供其他 Agent 使用。',
        example: { query: '', limit: 30 },
      },
      async execute(input, { jobId, client }) {
        idSchema.parse(jobId);
        const params = z
          .object({
            query: z.string().max(1000).default(''),
            limit: z.number().int().min(1).max(100).default(30),
          })
          .strict()
          .parse(input);
        const context = await client.call('context.get', params);
        const path = await writeOnce(directory, `${jobId}-context.md`, context.markdown);
        return `个性化上下文已保存：${path}`;
      },
    },
  ];
}

export const commandConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.-]+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    example: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CommandConfig = z.infer<typeof commandConfigSchema>;

export function commandAction(config: CommandConfig): ActionAdapter {
  return {
    info: {
      id: config.id,
      title: config.title,
      description: config.description,
      example: config.example,
    },
    async execute(input, { jobId }) {
      const result = await runJsonProcess(config.executable, config.args, { jobId, input }, 60_000);
      const output = JSON.stringify(result);
      if (output.length > 32000)
        throw new Error('工具返回超过 32000 字符，请让工具返回摘要或文件路径');
      return output;
    },
  };
}
