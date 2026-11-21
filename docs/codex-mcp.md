# 在 Codex 中使用个人助手 MCP

MCP 是后端的一部分，与管理 API 共用服务器进程。Codex 通过 HTTPS 直接连接 `/mcp`，工具在进程内调用业务服务，不经过 SSH，也不需要本机 MCP 常驻进程。

```text
Codex → HTTPS 反向代理 → 后端 /mcp → AssistantService → SQLite
```

四个工具保持原有边界：`get_personal_context` 查询已确认资料，`propose_preference` 提交待确认偏好，`list_action_tools` 列出设备工具，`create_pending_task` 创建待批准任务。MCP 不提供确认偏好、批准任务或任意 RPC 接口。

## 在服务器启用

在项目目录执行：

```sh
npm ci
npm run setup
npm run setup:mcp
```

`setup` 创建管理 API 的 `.env`；`setup:mcp` 根据 `.env.mcp.example` 创建权限为 `0600` 的 `.env.mcp`，生成独立随机 `MCP_TOKEN`。已有文件均不会覆盖。在服务器 `.env.mcp` 设置公共地址：

```dotenv
MCP_URL=https://assistant.example.com/mcp
MCP_TOKEN=由-setup:mcp-生成的独立随机令牌
```

保留实际生成的令牌，不要复制上述占位值。`MCP_TOKEN` 必须与完整管理权限的 `API_TOKEN` 不同。后端依次读取 `.env` 和 `.env.mcp`，已有进程环境变量优先；两个文件可分别通过 `ENV_FILE` 和 `MCP_ENV_FILE` 指定。如果统一使用进程环境或 `.env`，也可以在那里设置 `MCP_URL` 与 `MCP_TOKEN`。

两个 MCP 配置都未设置时，后端不提供 `/mcp`；只设置其中一个会启动失败。旧 `.env.mcp` 需要手动将 `MCP_PORT` 与 SSH 配置改为 `MCP_URL`，脚本不会自动覆盖或迁移密钥。

```sh
npm run build
npm run start:server
```

服务器默认监听 `127.0.0.1:4310`。生产环境通过 HTTPS 反向代理公开 MCP，后端端口保留在 loopback。`deploy/Caddyfile` 提供同机 Caddy 模板：将示例域名改为真实域名，与 `MCP_URL` 一致，再按服务器的 Caddy 安装方式加载。域名、DNS、TLS 和公网入口需要在部署环境中配置；模板不会自动部署这些资源。

模板只代理精确的 `/mcp` 路径，其余路径返回 404，避免通过这个域名暴露具有完整管理能力的 `/rpc`。代理需要保留公共 `Host` 与 `Authorization`；不要把 Host 重写为 `127.0.0.1`，不要剥离 `/mcp`。后端校验公共 Host，有 Origin 时要求匹配公共 HTTPS origin；不使用 `X-Forwarded-Host` 绕过此校验。Caddy 默认保留请求头，参见官方 [reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 与 [handle](https://caddyserver.com/docs/caddyfile/directives/handle) 文档。

本机开发可将 `MCP_URL` 设置为 `http://127.0.0.1:4310/mcp`，通过 `npm run dev:server` 启动；无需 HTTPS 代理。修改后端端口时应同步修改该 URL。远端明文 HTTP 地址会被配置校验拒绝。

## 配置 Codex

OpenAI 官方文档确认 Codex 支持 Streamable HTTP、Bearer 令牌和 `config.toml` 中的 `url`、`bearer_token_env_var`、`http_headers` 配置，见 [Codex MCP](https://developers.openai.com/codex/mcp)。配置以同一个 `qiyi-personal-assistant` 名称关联 Skill。

如果 Codex 的启动环境已有服务器配置的同一个 `MCP_TOKEN`，可使用：

```toml
[mcp_servers.qiyi-personal-assistant]
url = "https://assistant.example.com/mcp"
bearer_token_env_var = "MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

桌面 Codex 不一定继承终端环境变量。项目也提供包含静态鉴权头的私有配置生成器：在 Codex 所在电脑的项目目录中准备 `.env.mcp`，只填写服务器的 `MCP_URL` 与同一个 `MCP_TOKEN`；保持文件权限为 `0600`。不要在客户端另生成不同令牌后直接使用。

```sh
npm ci
npm run build
npm run codex:config
```

生成器只读取 `MCP_ENV_FILE` 指定的文件或 `.env.mcp`，不读取项目 `.env`，不需要 SSH 或管理 API 凭证。输出 `.local/qiyi-mcp.toml` 权限为 `0600`，含远端 URL 和静态 Bearer `http_headers.Authorization`。将其中的服务配置合并到 Codex `config.toml`，保留其他设置，不要用片段覆盖整个文件。脚本不会修改全局 Codex 配置，也不会打印令牌。

`.env.mcp` 与私有 TOML 都含凭证，不应提交版本库或贴进聊天。轮换令牌时同步更新服务器与 Codex 配置，并重启后端、重新连接 MCP。

## 安装 Skill

项目内 Skill 位于 `skills/qiyi-personal-assistant`：

```sh
npm run install:skill
# 或指定 Skill 的父目录
npm run install:skill -- --target /path/to/skills
```

默认目标是 `${CODEX_HOME:-~/.codex}/skills/qiyi-personal-assistant`。安装脚本不会覆盖已有 Skill；已有安装需要先核对个人修改，再手动更新。

`agents/openai.yaml` 通过 `qiyi-personal-assistant` 声明 MCP 依赖，不再固定本机 URL；连接地址由 Codex 配置维护。Skill 保持隐式调用开启，仅在个性化请求、明确记住或纠正偏好、或委派个人助手任务时适用。Skill 自身不会启动进程或修改连接配置。

## 本机适配端与使用示例

MCP 远端化后，本机采集与工具执行仍由 bridge 或 daemon 承担。需要网页时运行 `npm run start:bridge`，它已包含运行器；无需网页时运行 `npm run start:daemon`，同一设备通常选择其一。它们使用自己的传输配置，现有 SSH 接入仍可使用，与 Codex 的 HTTPS MCP 链路独立。

1. “按我平时的写作偏好改写这封邮件。”查询相关、已确认的个人资料。
2. “记住：技术方案先用中文给结论，再补实现细节。”创建待确认偏好，在网页“我的资料”中审核；已有冲突资料由用户编辑或删除。
3. “把会议记录整理成笔记，交给个人助手处理。”先列出真实设备工具，再创建待批准任务。用户在“自动行动”检查参数并批准；对应设备运行器在线后执行。

设备注册不代表当前在线。两种写入都使用 UUID `requestId` 去重；重试必须保留原 ID 与参数，返回记录当前状态，不会覆盖人工修改或复活已删除的记录。

## 从本机 MCP 版本迁移

1. 更新服务器代码并重新构建，在服务器设置 `.env.mcp` 的 `MCP_URL` 与独立令牌，重启后端。
2. 配置 HTTPS 代理和真实域名，确保外部仅访问 `/mcp`。
3. 将 Codex 原 `http://127.0.0.1:4312/mcp` 地址更新为远端 URL，并使用服务器对应令牌。
4. 更新已安装 Skill 的文件。停止旧本机 MCP 进程及其自启配置；新版已移除 `dev:mcp`、`start:mcp` 和 `apps/mcp` 入口。

本机 bridge/daemon 的采集与执行服务按需继续运行。

## 状态与排查

- 连接失败：检查后端进程、HTTPS 代理、证书与域名是否可达。
- 404：检查后端是否设置完整 MCP 配置，并确认代理保留 `/mcp`。
- 401：检查 Codex 与服务器的 `MCP_TOKEN` 是否一致，代理是否保留 Authorization。
- 403：检查公共 Host 与 `MCP_URL` 一致；有 Origin 时必须匹配公共 origin。
- 配置校验失败：检查远端是否使用 HTTPS、路径是否精确为 `/mcp`，且无账号、查询参数或片段。
- 偏好或任务已创建但未生效：分别在网页确认或批准，并确认对应运行器在线。

实现与回归测试使用隔离合成数据。真实服务器、域名和 TLS 证书仍需按实际环境配置；本说明不代表已经完成公网部署。
