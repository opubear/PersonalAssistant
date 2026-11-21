# HTTP MCP 与个人助手 Skill：交付与复审

> 历史记录：本文记录本机 MCP + SSH 版本的交付与独立复审。随后按用户要求迁移为后端内置 HTTPS MCP；当前组织与迁移步骤见 [Codex MCP](codex-mcp.md)，当前验证见 [验证记录](verification.md)。下面的 Astra 结论只适用于当时审查的版本。

日期：2026-11-12。用户要求本机 HTTP MCP 与 Codex Skill 通过 SSH 网关查询个人资料、提交待确认偏好、创建待批准任务，并在补充回归后使用 gpt-6-astra ultra 独立复审。

## 交付范围

调用链为 `Codex → 本机 /mcp → SshTransport → 远端命令网关 → 后端`。MCP 使用官方 TypeScript SDK 2.4，独立于前端、bridge 和 daemon；HTTP 只绑定 loopback，验证 Host/Origin、独立 Bearer 令牌和请求体限制。原有 SSH stdin/stdout 协议保持不变。

| MCP 工具             | 后端方法         | 业务边界                             |
| -------------------- | ---------------- | ------------------------------------ |
| get_personal_context | context.get      | 基本资料与已确认、证据有效的记忆     |
| propose_preference   | memories.propose | 首次创建待确认的偏好，origin=agent   |
| list_action_tools    | devices.list     | 设备、心跳及注册工具，无原始聊天记录 |
| create_pending_task  | jobs.propose     | 首次创建待批准任务，不批准或执行     |

两类写入以操作类型与 UUID requestId 持久化去重，同一请求返回当前记录，保留人工编辑和状态变化；不同输入复用 ID 或目标已经删除时明确失败。创建与回执使用同一事务，任务回执不泄露执行令牌。

Skill 适用于个性化任务、明确要求记住/纠正偏好，以及委派助手任务。它不将检索文本当作指令、不绕过 MCP 调用更高权限 API、不自动确认或批准；网络结果未知时只用原 ID 和输入作有界重试。

配置与安装入口为 `setup:mcp`、`codex:config`、`install:skill`、`start:mcp`。配置和私有 Codex 片段权限为 0600；已有配置或 Skill 不被安装流程覆盖。使用步骤见 [Codex 接入说明](codex-mcp.md)。

## 独立复审与处理

审查者使用全新上下文的 `gpt-6-astra`、`ultra` 级别；Git 尚无首个提交，审查覆盖新增模块及相关完整代码、契约、调用者与测试，没有以空 diff 缩小范围。

| 发现                                            | 处理与证据                                                                                            | 最终状态   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| P3：API 表格中的“同上”被新 propose 行改变了指向 | update 参数改为明确引用 memories.create / jobs.create                                                 | 已复核关闭 |
| P3：旧版 HTTP 断连后协议实例保留至 SSH 请求结束 | HTTP 交换关联 AbortController；断连和 preClose 触发清理；补两项真实 HTTP 回归，后端仍挂起时协议已关闭 | 已复核关闭 |

审查者独立运行初版新增 20 项回归，最终再次执行 MCP 11 项回归及原生命周期探针，全部通过。最终结论：无未决发现，没有确认到新增正确性、权限或契约问题。在途 SSH 写入仍可能完成，未知结果需用原 requestId 恢复。

## 最终验证

- 独立验证代理在排除真实配置、数据、node_modules 与全部 dist 的副本运行 `ENV_FILE=/dev/null npm ci` 和 `ENV_FILE=/dev/null npm run check`；同步最终复审修复后完整检查 **78/78 测试通过**，类型检查、应用及四个共享包构建、真实 tarball 消费验证通过。
- Node 24.18.0、npm 11.16.0；新增依赖后 `npm audit --omit=dev` 为 **0 告警**，最终修复未改变依赖。
- 官方 MCP 客户端对生产构建完成真实 loopback 初始化与工具发现。自动化回归还覆盖真实 SshTransport 子进程、受控 SSH 夹具、网关和后端的完整链路。
- 全新上下文的独立代理读取 Skill，实际调用隔离 HTTP MCP 的四个工具；数据库保留待确认候选与待批准任务。资料内的指令式测试文本未触发越权操作。
- 实际浏览器确认“Agent 提议 / 待确认”与任务“待批准”；截图为 `screenshots/mcp-pending-task.png`。合成测试服务已停止。

没有读取真实聊天、配置密钥或调用真实模型；没有连接真实 SSH 主机、修改全局 Codex 配置、安装常驻服务或触发云端 Actions。上述验证不替代目标机器上的 SSH 身份、网关部署与 Codex 配置接通。
