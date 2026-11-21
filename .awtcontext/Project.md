# 栖忆 · 个人助手

面向个人多设备的记忆与服务助手。从明确选择的 AI 会话和 App 使用事件提取偏好、习惯、需求等资料，保留来源证据，允许用户手工维护，并通过上下文与批准后的工具任务提供个性化服务。

真实工程是当前 .awtcontext 的父目录。技术栈为 TypeScript、React、Fastify、SQLite，采用 npm workspaces。后端部署服务器并内置 HTTPS MCP 入口供 Codex 直连；本机前端通过 bridge 和 SSH 命令网关调用 API；共享适配库也可独立作为 daemon 运行。

阅读入口为 README.md；架构、协议、适配与部署文档通过 GlobalDoc/DocIndex.md 索引。AWT 运行状态使用外部存储，不提交到业务工程。
