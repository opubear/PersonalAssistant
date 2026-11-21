# DocIndex — 栖忆 · 个人助手

按需通过地址读取正文；描述用一句话说明用途，不超过 80 字。相对地址以本索引所在目录为基准。
新增文档使用 `awt doc add`，已有文件使用 `awt doc index`；任务专属文档加 `--task <TaskID>`。参数见各命令 `--help`。

| 标题 | 地址 | 描述 |
|---|---|---|
| 运行入口 | `workspace:README.md` | 本机启动、功能范围、目录结构与配置入口 |
| 架构与数据规则 | `workspace:docs/architecture.md` | 部署边界、后端内置MCP、资料生命周期、并发与工具执行语义 |
| API 契约 | `workspace:docs/api.md` | 类型化 RPC 方法、字段限制与错误处理 |
| 适配器接入 | `workspace:docs/adapters.md` | Codex、聊天、App 事件与自定义工具的接入方式 |
| 部署与运行 | `workspace:docs/deployment.md` | HTTPS MCP代理、服务器、可选SSH网关、后台进程及备份恢复 |
| 验证记录 | `workspace:docs/verification.md` | 当前80项测试、生产HTTPS MCP验证及历史独立复审边界 |
| 共享包与持续集成 | `workspace:docs/packaging.md` | 独立ESM与类型交付、源码条件导出、消费者验证和CI工作流 |
| 修复与独立复审 | `workspace:docs/review.md` | 已修复缺陷、扩展与契约改进、Astra ultra复审和最终验证证据 |
| Codex HTTP MCP 与个人助手 Skill | `workspace:docs/codex-mcp.md` | 后端内置HTTPS MCP、独立令牌、Codex配置、Skill安装及旧版迁移 |
| MCP接入与独立复审 | `workspace:docs/mcp-review.md` | 历史本机MCP与SSH版本的Astra ultra复审及78项验证记录 |
