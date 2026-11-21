# API 契约

协议真源位于 `packages/contracts/src/entities.ts` 与 `rpc.ts`，由 `index.ts` 导出。请求经 Zod 校验后进入类型约束的 handler，结果在服务端和客户端都按相同结果 schema 校验。RPC 不是任意命令执行入口。

## 信封

后端：`POST /rpc`，`Authorization: Bearer <API_TOKEN>`，`Content-Type: application/json`。

本机浏览器：`POST /api/rpc`，不持有后端密钥。bridge 仅监听 `127.0.0.1`，校验 Host、Origin 和 JSON 内容类型，不允许任意跨站请求。

SSH：将同一个 JSON 对象写到网关 stdin，读 stdout 上的一份 JSON 响应。退出非零代表网关/网络失败，业务错误在 JSON 信封中表达。

```json
{ "method": "context.get", "params": { "query": "工作", "limit": 30 } }
```

```json
{ "ok": true, "data": { "markdown": "...", "memories": [] } }
```

```json
{
  "ok": false,
  "error": { "code": "CONFLICT", "message": "这条信息已在其他端更新，请刷新后重新编辑" }
}
```

快照、导出、列表包含真实数据，浏览器 API 响应设置 `Cache-Control: no-store`。仅 `/health` 无认证，只返回存活状态。

## 方法

| 方法                  | 参数要点                                                      | 结果                                                                 |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| `snapshot.get`        | `{}`                                                          | 资料、来源、最近 50 条记录、任务、设备、最近 30 次分析和系统配置状态 |
| `profile.update`      | name / bio / locale / timezone / revision                     | 个人基本信息                                                         |
| `memories.create`     | category / title / content / tags / confidence / status       | 新记忆                                                               |
| `memories.propose`    | requestId（UUID）/ title / content / tags                     | 新建待确认的 preference，origin=agent；同请求重试返回当前记录        |
| `memories.update`     | 同 memories.create，加 id / revision                          | 更新的记忆，表示用户已重新核对                                       |
| `memories.delete`     | id / revision                                                 | deleted                                                              |
| `sources.list`        | `{}`                                                          | 来源数组，供后台服务轻量查询                                         |
| `sources.create`      | id / name / kind / enabled / autoAnalyze                      | 来源                                                                 |
| `sources.update`      | 同上，加 revision                                             | 来源                                                                 |
| `sources.delete`      | id / revision                                                 | 删除来源及原始记录，关联记忆标记依据失效                             |
| `observations.import` | sourceId / observations[]                                     | created / updated / skipped                                          |
| `observations.list`   | offset（0 起）/ limit（1–100）                                | items / total                                                        |
| `observations.get`    | id                                                            | 完整原始记录                                                         |
| `observations.update` | id / revision / kind / role / content / occurredAt / metadata | 原始记录，设置人工编辑保护                                           |
| `observations.delete` | id / revision                                                 | deleted，保留防复活标记                                              |
| `analysis.run`        | 可选 sourceId                                                 | 当前批次分析记录；同步等待本批次结果                                 |
| `analysis.delete`     | id                                                            | 删除非运行中的分析记录，不影响记忆                                   |
| `context.get`         | query / limit（1–100）                                        | markdown / memories，仅确认且有效的资料                              |
| `devices.register`    | id / name / tools[]                                           | 刷新设备和可用工具                                                   |
| `devices.list`        | `{}`                                                          | 设备、工具及心跳；不包含个人原始记录                                 |
| `devices.delete`      | id                                                            | 无未完成任务时允许移除                                               |
| `jobs.create`         | deviceId / toolId / title / input                             | pending 任务                                                         |
| `jobs.propose`        | requestId（UUID）/ deviceId / toolId / title / input          | 首次创建 pending；同请求重试返回当前任务，不返回执行令牌             |
| `jobs.update`         | 同 jobs.create，加 id / revision                              | 只允许修改 pending 任务                                              |
| `jobs.decide`         | id / revision / decision: approve 或 cancel                   | 更新任务状态                                                         |
| `jobs.claim`          | deviceId                                                      | 一个带 claimToken 的任务，或 null                                    |
| `jobs.finish`         | id / claimToken / success / output                            | 已完成任务，同一回报可重发                                           |
| `jobs.delete`         | id / revision                                                 | 不能删除已排队或正在执行的任务                                       |
| `data.export`         | `{}`                                                          | version=1 的全部业务数据；不是可直接恢复数据库的备份                 |

原始记录输入：

```json
{
  "externalId": "conversation-1:message-42",
  "kind": "chat",
  "role": "user",
  "content": "我希望回答先给出结论。",
  "occurredAt": "2026-11-12T09:00:00+08:00",
  "metadata": { "conversationId": "conversation-1" }
}
```

上例是兼容的旧输入格式。新聊天导入请使用 `@qiyi/adapters` 的解析器生成 `identity` 和 `externalId`，或调用 `@qiyi/contracts` 的 `chatExternalId({ format: 'chat-jsonl', conversationId, messageId })`。不要手工拼接分隔符。服务端验证标识一致性；旧格式保留兼容处理。

分类：`preference / habit / need / goal / background / boundary`。
记忆状态：`proposed / confirmed / rejected`。
记忆来源：`manual / ai / agent`。客户端与后端需要同步更新以识别 Agent 提议。
内置来源格式：`codex / chat-jsonl / app-jsonl / manual`。可扩展格式标识最长 80 字符，匹配 `[a-z][a-z0-9._-]*`，解析能力由宿主注册表提供。

## 限制与错误

- 请求体 4 MiB；一个导入 RPC 最多 50 条，SDK 默认每 25 条发送。
- externalId 最长 512 字符；聊天 identity 的 conversationId/messageId 各最长 240 字符，identity 与 externalId 均不可通过编辑接口更改。
- 一条原始记录最多 20,000 字符，元数据最多 32 个字段和 8,000 字符；浏览器和文件采集器单文件最多 20 MiB。
- AI 单批最多 25 条、约 70,000 字符，85 秒模型超时；网关与传输留有额外超时余量。
- SSH stdout 最多 16 MiB，stderr 只保留末尾 2,000 字符。大量数据应分批读取；完整数据库使用备份流程。
- 工具输入 JSON 最多 32,000 字符，结果最多 32,000 字符。
- ID、类型、状态和日期严格校验；未知方法返回 `METHOD_NOT_FOUND`。
- 常见错误：`UNAUTHORIZED`、`VALIDATION_ERROR`、`CONFLICT`、`SOURCE_DISABLED`、`AI_NOT_CONFIGURED`、`ANALYSIS_BUSY`、`NOTHING_TO_ANALYZE`、`ANALYSIS_STALE`、`MODEL_INVALID_EVIDENCE`、`INVALID_JOB_STATE`、`SSH_FAILED`、`INVALID_RESPONSE`、`INVALID_IMPORT_ID`、`LEGACY_ID_AMBIGUOUS`。

一批导入在事务内全部成功或全部回滚；多个 SDK 批次之间不是全文件事务，中途失败后可重复导入同一文件以补齐剩余记录。

`memories.propose` 与 `jobs.propose` 按操作类型和 `requestId` 保存持久化回执；同一 ID 的输入内容改变返回 `IDEMPOTENCY_CONFLICT`，对应记录已删除返回 `PROPOSAL_DELETED`。重试返回目标当前状态，不重置人工编辑或审批结果。创建与回执在同一事务提交；完整 SQLite 备份保留回执，`data.export` 不包含它们。

本机 MCP 仅开放四个窄工具，不转发任意 RPC，也不提供确认偏好、批准或认领任务的工具。其 HTTP Bearer 令牌与服务器 `API_TOKEN` 独立。配置和工具参数见 [Codex 接入](codex-mcp.md)。

## TypeScript 客户端

```ts
import { AssistantClient, HttpTransport } from '@qiyi/client';
import { SshTransport } from '@qiyi/client/node';

const client = new AssistantClient(
  new SshTransport({
    host: 'assistant-server',
    command: '/opt/qiyi/bin/gateway',
  }),
);
const context = await client.call('context.get', { query: '沟通', limit: 20 });
console.log(context.markdown);
```

默认包入口是 ESM JavaScript 与 `.d.ts`，可通过 tarball 安装到独立宿主；工作区开发使用 `qiyi-source` 条件直接加载源码。构建和隔离消费检查见 [共享包与 CI](packaging.md)。尚未发布到 npm。
