# 栖忆 Qt 桌面前端

本目录是个人助手的 C++17 / Qt 6 Widgets 前端，包含截图与资料问答、本地记忆、服务器记忆和显式上传预览。界面通过独立桌面后端管理数据，不直接写资料库。

## 构建和启动

从个人助手根目录运行 `./build-desktop.sh` 和 `./start-desktop.command`；Linux 使用 `./start-desktop.sh`。构建产物位于项目 `.local/`，macOS 主应用为根目录 `Qiyi.app`。不依赖其他工程目录。

源码使用 CMake 和 Qt 6 Widgets；测试额外使用 Qt Test、Network 和 Python。Swift 截图服务来自本项目 `apps/capture`，Node 桌面后端来自 `apps/desktop/src`。

默认截图与资料目录是 `data/capture`，个人记忆目录是 `data/desktop`。`--data-dir`、`--local-dir` 可覆盖这两个位置；`--backend` 与重复的 `--backend-arg` 用于调试替代后端；`--no-hotkey` 禁用快捷键注册。

完整使用说明见 [桌面前端](../../../docs/desktop.md)。

## 后端接口

Qt 使用 `QProcess` 启动本项目的 Node 桌面后端；Node 再管理 Swift 截图服务。以下为截图服务协议，桌面后端同时提供本地记忆与手动上传接口。
stdout 只用于 JSONL，stderr 用于诊断。每行一个 UTF-8 JSON 对象，用 LF 分隔。
输入输出中的资料、模型回复和路径都是数据，前端按纯文本显示；不会把模型回复作为 HTML 执行。

请求与响应示例：

```json
{"id":"1","method":"library/addText","params":{"text":"需要整理的原文"}}
{"id":"1","result":{"id":"资料编号","state":"pending"}}
{"event":"libraryChanged","data":{}}
```

响应为 `{"id":...,"result":...}` 或 `{"id":...,"error":{"message":...}}`。
响应不保证顺序，按 id 配对。事件为 `{"event":...,"data":...}`。

| 方法 | 参数 | 作用 |
| --- | --- | --- |
| `initialize` | 无 | 协议版本、目录、设置和权限状态 |
| `permissions/status` | 无 | 读取截图权限和快捷键状态 |
| `permissions/request` | `kind: accessibility / screenCapture` | macOS 授权入口 |
| `capture` | 无 | 截取调用时聚焦窗口、归档并排队分析 |
| `library/list` | 无 | 列出资料元数据 |
| `library/content` | `id` | 获取校验后的原文或图片路径 |
| `library/addText` | `text` | 原文落盘，读图已配置时自动排队生成概述 |
| `library/addImage` | `path` | 导入 PNG/JPEG，后续同上 |
| `library/summarize` | `id`、可选 `force` | 临时 Agent 生成概述，`force` 允许重新生成 |
| `reader/configure` | `configuration` | 独立保存读图设置，不启动模型 |
| `agent/start` | `configuration` | 保存问答设置并启动持久会话 |
| `agent/stop` | 无 | 仅停止持久问答，保留读图任务与资料 |
| `chat/ask` | `text` | 检索、阅读原文后回复，返回来源列表 |
| `interaction/respond` | `id`, `kind`, 可选 `value` | 转交用户的明确回应 |
| `shutdown` | 无 | 停止会话并退出；关闭 stdin 同样触发退出 |

`configuration` 包含 `provider`、`executable`、`arguments` 字符串数组、`basePrompt` 与可选的 `reasoningEffort`（Codex）。持久问答保存在 `agent-settings.json`；读图单独保存在 `reader-settings.json`，其 `basePrompt` 固定为空，实际使用内置整理提示词。初始化返回独立的 `reader` 状态与配置。`library/content` 在有独立概述文件时返回 `summaryPath`。
事件包括 `agentState`、`readerStatus`、`status`、`progress`、`warning`、`libraryChanged`、`captured`、`screenshotResult`、`interaction` 和 `interactionCancelled`。截图只通过临时 Agent 写入概述文件并通知刷新，不自动进入持久会话。

交互事件提供原始选项 ID。客户端应等待用户选择，然后回复 `kind: choice` / `text` 和对应 `value`，
或 `kind: cancelled`。客户端不得把连接失败、关闭窗口或尚未选择当成允许/拒绝决定。
后端验证选项 ID，并在所属会话结束时通知前端关闭过期交互框。

## 验证

从个人助手项目根目录运行 `./test-desktop.sh`：

- 运行已有 Swift 测试。
- 启动真实 Swift 服务，用临时资料目录验证持久性、索引、对话和权限交互。
- Qt Test 实际点击保存、选择资料、筛选和 agent 权限对话框，并验证界面与后端通信。
- 状态栏测试覆盖后端与 Agent 状态、恢复最小化或隐藏的窗口、启动失败提示，以及从菜单退出时的服务清理。
- agent 使用测试专用的本地 Pi 协议模拟器；不上传截图、不调用模型服务，也不修改用户账号配置。

当前测试没有验证真实桌面截图权限、在线模型效果或 Linux/Windows 原生运行。
