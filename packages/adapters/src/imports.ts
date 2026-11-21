import { observationInputSchema, sourceKindSchema } from '@qiyi/contracts';
import { parseBuiltIn } from './parsers.js';
import type { ImportParser, ParseResult } from './types.js';

/** Host-owned registry: no global mutation, dynamic imports or executable configuration. */
export class ImportRegistry {
  private readonly parsers = new Map<string, ImportParser>();
  constructor(parsers: readonly ImportParser[]) {
    for (const parser of parsers) {
      sourceKindSchema.parse(parser.id);
      if (parser.id === 'manual' || this.parsers.has(parser.id))
        throw new Error(`重复或保留的导入格式：${parser.id}`);
      this.parsers.set(parser.id, parser);
    }
  }
  list(): { id: string; title: string }[] {
    return [...this.parsers.values()].map(({ id, title }) => ({ id, title }));
  }
  has(id: string): boolean {
    return this.parsers.has(id);
  }
  parse(id: string, input: string, namespace = 'import'): ParseResult {
    const parser = this.parsers.get(id);
    if (!parser) throw new Error(`当前宿主未注册导入格式：${id}`);
    if (new TextEncoder().encode(input).length > 20 * 1024 * 1024)
      throw new Error('文件超过 20 MiB，请拆分后导入');
    const result = parser.parse(input, namespace);
    if (!Number.isSafeInteger(result.ignored) || result.ignored < 0)
      throw new Error(`解析器 ${id} 返回无效的忽略数量`);
    return {
      observations: result.observations.map((item) => observationInputSchema.parse(item)),
      ignored: result.ignored,
    };
  }
}
export function createImportRegistry(additional: readonly ImportParser[] = []): ImportRegistry {
  return new ImportRegistry([
    ...(
      [
        ['codex', 'Codex 会话'],
        ['chat-jsonl', '通用聊天 JSONL'],
        ['app-jsonl', 'App 使用事件'],
      ] as const
    ).map(([id, title]) => ({
      id,
      title,
      parse: (input: string, namespace: string) => parseBuiltIn(id, input, namespace),
    })),
    ...additional,
  ]);
}
export const defaultImportRegistry = createImportRegistry();
export function parseImport(format: string, input: string, namespace = 'import'): ParseResult {
  return defaultImportRegistry.parse(format, input, namespace);
}
