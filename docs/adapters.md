# 适配器接入

采集与执行是两类独立接口，定义在 `packages/adapters/src/types.ts`，由根入口导出。React 不负责目录扫描或进程执行；bridge 与 daemon 使用同一个 `AdapterRuntime`。其他 TS 前端可以直接复用纯解析器，也可以实现自己的宿主传输层。

## Codex 会话

在网页创建来源，格式选择“Codex 会话”，例如 ID 为 `my-codex`。然后按需把下列配置合并到本机 `adapter.config.json`：

```json
{
  "deviceId": "my-laptop",
  "pollIntervalMs": 30000,
  "outputDirectory": "./data/outputs",
  "collectors": [{ "sourceId": "my-codex", "format": "codex", "path": "~/.codex/sessions" }],
  "commands": []
}
```

重启 bridge/daemon 后开始采集。**路径就是允许扫描的范围**，首次会同步目录内全部可读取的 `.jsonl` 历史；建议先选择单个导出的会话文件或更小的目录，确认内容后再扩大。项目默认 `collectors: []`，未启用任何扫描。

解析器优先读取 `response_item` 的 user/assistant message；旧格式回退到 `event_msg.user_message / agent_message`。如果存在规范 message 记录，不再重复导入对应事件。系统/开发者指令、工具输入输出、reasoning 和已识别的运行时环境包装记录被跳过。仅保留可见文本，不导入图片、附件或加密字段。ID 来自会话 ID 与消息 ID / ordinal / 行号，重复扫描不会新增重复消息。

当前适配器针对本机核对过的 rollout JSONL 结构，并不是承诺稳定的官方日志协议。Codex 的版本或存储方式变化可能需要更新解析器；只存在数据库分页历史、没有可用 rollout 文件的会话不会由此适配器读取。官方 App Server 提供只读的 `thread/list`、`thread/turns/list`、`thread/items/list` 等接口，可作为后续额外 Collector 的接入点；首版没有启动或连接用户的 App Server。[官方说明](https://learn.chatgpt.com/docs/app-server#threads)

## 其他聊天 Agent

让其他 Agent 导出每行一条消息的 JSONL，再创建 `chat-jsonl` 来源：

```json
{"id":"m-1","conversationId":"chat-1","role":"user","content":"我偏好短答案。","timestamp":"2026-11-12T09:00:00+08:00"}
{"id":"m-2","conversationId":"chat-1","role":"assistant","content":"明白。","timestamp":"2026-11-12T09:00:05+08:00"}
```

`conversationId` 可选；解析器用无歧义的长度编码生成 `externalId`，并保存不可编辑的 `identity`。不同会话、分隔符以及有无会话都能区分；新 ID 中的空白逐字符保留。未提供会话时，`id` 必须在整个来源内唯一。用户、助手的角色明确保存，首版提取仅将用户消息和事件发送给模型，避免把助手建议当作用户事实。

## App 使用事件

App、插件或你编写的小脚本可把使用信息写入 JSONL：

```json
{
  "id": "event-42",
  "app": "Reader",
  "activity": "阅读技术文章",
  "durationSeconds": 1800,
  "timestamp": "2026-11-12T21:00:00+08:00"
}
```

对应来源格式为 `app-jsonl`。这是通用事件接入格式，不会主动读取系统使用记录、浏览器历史或屏幕。原始 App 自身的权限获取与事件收集由该 App 的适配器负责，输出此格式即可复用上传与分析。

每条 JSONL 必须合法；后台读取器暂不处理末尾没有换行符的行，等待写入完成。超过 20 MiB 的文件或超过记录上限的内容会明确报错，不静默截断。文件读取/解析失败以及明确的永久记录拒绝会按文件隔离并汇总含路径的错误；同目录的健康文件、其他来源和工具任务继续处理。网络或服务整体故障结束当前采集器的一轮处理，避免逐文件等待网络超时。失败文件不确认，下次轮询重试。

## 自定义 Collector

```ts
import type { Collector } from '@qiyi/adapters';

const collector: Collector = {
  sourceId: 'my-app',
  kind: 'my-app-events',
  async *collect() {
    yield [
      {
        externalId: 'app-event-unique-id',
        kind: 'app',
        role: 'event',
        content: '记录一个明确的使用事件',
        occurredAt: new Date().toISOString(),
        metadata: { app: 'MyApp' },
      },
    ];
  },
};
```

在服务器创建 `kind: 'my-app-events'` 的来源，再在宿主明确注册实例：

```ts
import { AdapterRuntime } from '@qiyi/adapters';

const runtime = new AdapterRuntime(
  client,
  { deviceId: 'my-laptop', pollIntervalMs: 30000 },
  { collectors: [collector], actions: [] },
);
runtime.start(console.error);
// 退出时 await runtime.stop();
```

核心运行器不读文件、不构造内置工具，也不依赖 Node；注册信息、格式匹配和状态来自实际实例。`kind` 是自定义格式标识，服务端接受标准 Observation，无需修改枚举。旧的无 `kind` 采集器仍可执行，状态显示 `custom`，但建议明确声明格式。可直接调用 `uploadObservations` 完成分批上传；外部 ID 必须稳定。

数组批次适合无游标的简单采集器；若需要确认游标、按文件失败隔离，返回 `CollectionBatch`：

```ts
async function* collect() {
  yield {
    observations: records,
    label: '来源文件或批次的说明',
    acknowledge: async () => {
      // 只有整个批次被服务器接受后，才保存下一次读取的游标。
    },
  };
}
```

`JsonlCollector` 使用这种显式确认：遍历到下个文件不会自动确认上个文件。直接消费它时，上传成功后调用 `await batch.acknowledge()`；上传失败时不调用。数组形式的旧采集器在上传失败时会被关闭，避免它在恢复迭代时错误推进游标。

目录采集的文件指纹只在一次上传被服务端接受并显式确认之后更新。进程重启会重新扫描；服务端去重、人工编辑保护和删除标记仍然有效。需要“本地原始文件删除后仍可离线补传”的场景，应另外实现持久化队列 Collector。

## 新文件格式与 Node 宿主

`ImportRegistry` 是宿主持有的不可变注册表，不执行配置中的任意代码。`createImportRegistry([parser])` 在内置格式上添加实现；重复、保留或未知格式明确报错，输出统一校验：

```ts
import { createImportRegistry } from '@qiyi/adapters';
import { createAdapterRuntime, readAdapterConfig } from '@qiyi/adapters/node';

const formats = createImportRegistry([
  {
    id: 'my-app-events',
    title: '我的应用',
    parse(input, namespace) {
      return { observations: parseMyApp(input, namespace), ignored: 0 };
    },
  },
]);
const runtime = createAdapterRuntime(client, await readAdapterConfig('./adapter.config.json'), {
  formats,
  collectors: [collector],
  actions: [action],
});
```

Node 工厂组装配置中的目录采集器、内置工具和固定命令，再加上传入的扩展。同一工具 ID 重复会失败，不静默覆盖。新增文件格式可在 JSONL 目录配置的 `format` 中使用注册 ID，无需修改核心配置 schema。

网页可创建和管理任意格式来源；未知本机解析器的来源仍显示记录和格式标识，文件导入按钮显示“由适配器上传”。需要浏览器内预览自定义格式时，在该前端宿主注册同一纯解析器。服务器不下载或执行解析器代码。

第一版的 `new AdapterRuntime(client, fullConfig, actions, collectors)` 装配方式已调整：读取 Node 配置使用 `createAdapterRuntime`；直接注入实例使用上面的核心构造方式。配置文件格式和 bridge/daemon 启动命令保持兼容。

## 工具执行接口

```ts
import type { ActionAdapter } from '@qiyi/adapters';

const action: ActionAdapter = {
  info: {
    id: 'app.do-work',
    title: '应用任务',
    description: '明确说明会发生的操作',
    example: { text: 'example' },
  },
  async execute(input, { jobId, client }) {
    // 先校验 input，再调用指定 App 的 API；用 jobId 作为幂等键。
    // 可以调用 client.call('context.get', ...) 获得已确认资料。
    return '操作结果或输出文件路径';
  },
};
```

执行器只接受它自己注册过的工具。服务端批准任务不能添加新的可执行程序。扩展工具必须自行校验参数、处理超时、控制副作用，并在可能的情况下将 `jobId` 作为外部系统的幂等键。

## 固定命令适配器

配置文件可声明一个本机命令：

```json
{
  "id": "text.count",
  "title": "统计文本长度",
  "description": "运行固定的本机脚本，返回字符数量。",
  "executable": "/absolute/path/to/node",
  "args": ["/absolute/path/to/personal-assistant/examples/tool.mjs"],
  "example": { "text": "你好" }
}
```

将该项加入 `commands` 数组并重启运行器。参数数组是本机配置，任务输入不会插入命令行或 shell。脚本从 stdin 读取 `{"jobId":"...","input":{...}}`，stdout 输出一个合法 JSON 值；日志写 stderr。退出非零、超过 60 秒、输出超限或非 JSON 都会使任务失败。Unix 上超时会结束此命令的进程组，避免遗留子进程。

内置 `notes.create` 与 `profile.export` 使用任务 ID 生成文件名，不接受任意输出路径。扩展命令本身仍属于可信本机程序，这个库不是操作系统沙箱。

## 结果回报与诊断

工具执行后的回报若遇到网络错误会保留并重试，不重新执行工具。若服务器已结束/删除该任务或拒绝认领令牌，Node 工厂先将不含令牌的结果写入 `outputDirectory/report-conflicts/<jobId>.json`，然后恢复采集与后续任务。写入诊断失败时继续保留待回报结果。网页显示本进程最近 20 项冲突提示；重启后历史诊断仍在文件中。自定义宿主可通过 `onReportConflict` 保存自己的诊断，纯运行器没有默认文件系统。
