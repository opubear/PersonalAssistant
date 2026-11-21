# 部署与运行

本次只在本机完成实现与验证，下面是部署模板，没有自动创建服务器、修改 SSH 配置或安装常驻服务。

Codex 通过 HTTPS 直接访问后端内置 `/mcp`，不经过本机 MCP 服务或 SSH 网关。后端加载可选 `.env.mcp`，使用独立 `MCP_TOKEN` 与公共 `MCP_URL`；同机 HTTPS 代理模板见 `deploy/Caddyfile`，只公开 `/mcp`。完整配置与旧版迁移见 [Codex MCP 与 Skill](codex-mcp.md)。本文的 SSH 网关仍适用于网页桥接与适配端。

## 服务器

在自己的 Linux 服务器上准备 Node.js 24、npm、一个专用用户 `qiyi` 和工程目录 `/opt/qiyi`。将源代码或构建产物放入该目录，确保进程用户可以读取 `.env` 和启用 MCP 时的 `.env.mcp`，并拥有 `data/` 的写权限。模板中的 `/usr/bin/node` 应改成服务器 Node 的实际绝对路径。

从工程目录执行：

```bash
npm ci
npm run build
npm run setup
mkdir -p data
npm run start:server
```

服务器 `.env` 至少包含：

```dotenv
API_TOKEN=由-setup-生成的随机密钥
SERVER_HOST=127.0.0.1
SERVER_PORT=4310
DATABASE_PATH=/opt/qiyi/data/assistant.sqlite
MODEL_BASE_URL=https://your-provider.example/v1
MODEL_NAME=your-model-id
MODEL_API_KEY=your-model-key
MODEL_JSON_MODE=true
```

没有配置模型时，资料管理、同步、导出和工具任务仍可运行。`API_TOKEN` 必须至少 32 字符，不接受 `.env.example` 的占位值。保持 `.env` 为 `0600`；只把配置交给拥有该个人空间访问权限的账号。

常驻服务模板在 `deploy/qiyi-server.service`。确认路径、用户和权限后可安装：

```bash
sudo install -m 0644 deploy/qiyi-server.service /etc/systemd/system/qiyi-server.service
sudo systemctl daemon-reload
sudo systemctl enable --now qiyi-server
sudo systemctl status qiyi-server
```

服务设置了文件系统写入范围；需预先创建 `/opt/qiyi/data` 并让 `qiyi` 用户可写。后端只部署一个进程，避免多进程分析调度。数据库不放在 NFS 上，远端访问通过应用 API。

## SSH 命令网关

在服务器上安装固定网关入口：

```bash
sudo install -d -m 0755 /opt/qiyi/bin
sudo install -m 0755 deploy/gateway.sh /opt/qiyi/bin/gateway
```

该脚本进入工程目录，启动 `dist/server/gateway.js`；读取服务器 `.env`，将 stdin JSON 转发到后端 loopback API，stdout 只返回 JSON。无需暴露 `4310` 或使用端口转发。后端必须已经运行。

建议为客户端创建专用 SSH 公钥，并在服务器 `authorized_keys` 中将**该公钥**限定为固定命令：

```text
restrict,command="/opt/qiyi/bin/gateway" ssh-ed25519 YOUR_PUBLIC_KEY qiyi-device
```

这允许该密钥调用个人空间 API，但不允许普通 shell、PTY 或端口转发。每个设备独立密钥，撤销设备访问时移除对应公钥。网关不会使用客户端传来的命令文本；所有请求数据都是 JSON stdin。

在本机 `~/.ssh/config` 配置别名（示意）：

```sshconfig
Host assistant-server
  HostName your-server.example
  User qiyi
  IdentityFile ~/.ssh/qiyi_device
```

先手工核对并信任服务器主机指纹，使其进入 known_hosts。工具固定使用 `StrictHostKeyChecking=yes` 和 `BatchMode=yes`，未验证主机或缺少免交互凭证会直接报错，不弹密码框或跳过主机检查。

本机 `.env` 改成：

```dotenv
TRANSPORT=ssh
SSH_HOST=assistant-server
SSH_PORT=22
SSH_COMMAND=/opt/qiyi/bin/gateway
BRIDGE_PORT=4311
ADAPTER_CONFIG=./adapter.config.json
```

客户端无需复制服务器 API_TOKEN 或模型密钥。`SSH_COMMAND` 是可信本机配置，应保持固定入口；不要在这里拼接用户输入。SSH 密钥密码由现有 ssh-agent/系统密钥管理器提供。

完成主机验证后可用最小请求检查网关：

```bash
ssh -T assistant-server /opt/qiyi/bin/gateway <<'JSON'
{"method":"sources.list","params":{}}
JSON
```

应返回 `{"ok":true,"data":[...]}`，不是交互 shell。如果 stdout 出现欢迎语或 shell 日志，请把这些内容移到 stderr，否则会破坏 JSON 协议。

## 本机前端与无界面运行

```bash
npm run build
npm run start:bridge
```

访问 [http://127.0.0.1:4311](http://127.0.0.1:4311)，静态前端由 bridge 提供。它只监听本机，浏览器不持有 SSH 私钥。React 源码与后端完全分离，但浏览器宿主必须能通过 bridge 调用 SSH；把静态文件直接放到任意公共网站并不能访问用户本机 SSH。

不需要界面时：

```bash
npm run start:daemon
# 或一次同步
node dist/daemon/main.js --once
```

默认每 30 秒同步配置来源、注册本机工具并执行一个已批准任务。调度串行，不重叠执行。没有新数据时依靠文件指纹跳过解析；进程重启会重新扫描，服务端进行幂等去重。

同一机器通常只开 bridge 或 daemon 之一。切换时停止旧进程；多台设备要使用不同 `deviceId`。如果需要在已有 daemon 运行时临时开 bridge，使用相同数据来源仍能去重、同一任务仍只能被一个进程认领，但会产生重复扫描和设备心跳，因此不作为推荐运行方式。

`deploy/qiyi-agent.service` 是 Linux 用户服务模板，需替换路径后放入 `~/.config/systemd/user/`，再通过 `systemctl --user` 启用。

`deploy/com.qiyi.agent.plist` 是 macOS LaunchAgent 模板。将所有 `/ABSOLUTE/PATH/TO/...` 替换为真实路径，先创建 `data/`，确认命令可在无交互环境运行后，再安装到 `~/Library/LaunchAgents/`。需要使用实际 Node 绝对路径，因为 launchd 不加载交互 shell 的 nvm 初始化；SSH agent/密钥访问也需在该环境可用。本次没有自动安装它们。

## 自动分析失败处理

自动分析第一次失败后会在数据库中记录暂停原因，停止自动重试；服务器重启也保留暂停状态，避免反复请求付费模型。界面「信息来源」会显示原因。修复模型配置或数据问题后，手动点击一次“分析信息”；该批次成功后自动分析恢复。

手动分析失败不会丢失输入，也不会写入半批候选资料；可以修复后重试。来源暂停不撤回已经发往模型的请求，但会阻止其结果落库。

## 数据备份与恢复

`data.export` 提供可阅读的业务 JSON，包含原始记录；**它不是完整备份**，不含导入防复活标记和运行控制状态，也没有直接 JSON 恢复入口。

完整备份最简单的方式是停止后端、确认进程退出后，复制整个 `data/` 目录。若不能停机，用 SQLite 原生在线备份功能（例如 SQLite CLI `.backup`），不要在写入中只复制主数据库而漏掉 WAL。

恢复时停止后端，把完整 SQLite 备份恢复到 `DATABASE_PATH`，调整用户和 `0600` 文件权限再启动。单用户凭证保存在独立 `.env`，也需要在自己的安全备份中维护。删除记录不会同步清除既有备份；轮换与清理备份应遵从你自己的保留策略。

## 排查

| 现象                 | 检查                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| 页面连接失败         | 后端与 bridge 是否都启动；开发端口是否冲突；运行目录是否项目根                |
| SSH_FAILED           | SSH 别名、端口、known_hosts、ssh-agent、固定网关权限；先手工执行上述最小请求  |
| AI_NOT_CONFIGURED    | 服务器 MODEL_BASE_URL 与 MODEL_NAME 是否同时配置，是否重启后端                |
| MODEL_HTTP_ERROR     | API key、基础地址、模型是否支持该接口；模型 URL 不含 `/chat/completions` 后缀 |
| MODEL_INVALID_SCHEMA | 模型未遵守格式；原始数据保持待分析，可更换模型或修正配置                      |
| 本机没有采集         | 来源存在且启用；sourceId 与格式匹配；目录明确配置且可读；JSONL 末尾有换行     |
| 任务一直等待执行     | 对应 deviceId 的运行器是否在线；工具是否仍在白名单；是否已批准                |
| 任务结果未知         | 先核对 App/输出文件，避免直接重建造成重复副作用                               |

当前没有真实远端服务器或商业模型凭证的端到端测试。TLS、SSH 身份管理、备份位置和服务账户需按实际部署环境配置。
