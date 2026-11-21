# 截图与资料组件

这是个人助手内部组件。统一入口是项目根目录的 `Qiyi.app` 或 `start-desktop.command`，不再单独构建菜单栏产品。

## 源码与职责

```text
apps/capture/
  Package.swift
  Sources/
    QiyiCaptureCore/      截图调度、文件命名和保存
    QiyiMacOS/            聚焦窗口识别、权限、截图与全局快捷键
    QiyiAgents/           Codex、Pi、dsh 协议、进程与权限交互
    QiyiKnowledge/        原件保存、概述、选择资料和回答
    QiyiCaptureService/   长驻 JSONL 服务
    QiyiCaptureCLI/       macOS 单次截图和权限查询工具
  Tests/
  Resources/Info.plist
apps/desktop/
  src/                   本地记忆、明确上传和服务生命周期
  qt/                    Qt 窗口、JSONL 客户端和交互测试
```

平台无关的 Swift 模块不依赖 AppKit。Linux、Windows 目前可以接入资料和 Agent 协议，但原生窗口截图、权限与全局快捷键尚未实现或实测。

## 截图与文件

按 Control + Option + S 捕获按键时的聚焦窗口。也可以点击界面的三秒延迟截图按钮，再切换到目标窗口。无聚焦窗口、缺少权限或系统保护内容时报告错误，不会退回截取整个屏幕。

截图保存为 `data/capture/<时间>_<应用>_<ID>.png`，归档副本位于 `library/content/`。临时读图 Agent 的原始文字输出直接写入 `data/capture/library/summaries/<资料 UUID>.md`，之后提交 `library/index.json` 索引并发送 `libraryChanged` 通知界面刷新。原有 `*.agent.json` 截图处理回执继续保留；持久问答记录位于 `library/conversations/`。仅在用户操作时采集，不定时截图、不自动清理历史。

第一次截图需要为栖忆或栖忆截图服务授予辅助功能与屏幕录制权限。服务标识更新后，macOS 可能需要重新授权。界面提供权限入口和状态刷新。

## Agent 配置

| Agent | 默认程序 | 参数 |
| --- | --- | --- |
| Codex | `codex` | `["app-server"]` |
| Pi | `pi` | `["--mode", "rpc"]` |
| dsh | `dsh` | `["--profile", "acp"]` |

先在 Agent 自己的程序中完成登录和模型配置。Qt 设置分为「临时读图 Agent」与「持久问答 Agent」，各自选择程序和参数；参数直接传入子进程，不经过 shell。读图使用支持图片的模型；Agent 未声明图片能力时，图片操作明确失败，原件仍保留。

保存读图设置只写配置，不启动模型。后续每份截图、导入图片或文本分别启动一个临时会话，发送代码中固定的整理提示词与该份原件，输出落盘后结束。读图不接收持久对话、个人记忆或问答基础提示词；每张截图不会自动触发持久 Agent。单次读图失败会保留原件并标记失败，不结束持久会话，也不丢弃下一张截图。读图与问答各自排队，持久 Agent 正在回答或已停止时仍可生成概述。

读图设置单独保存到 `reader-settings.json`，持久问答设置保留在 `agent-settings.json`。旧安装首次升级会将已有的启动配置复制为独立读图配置，并清空其基础提示词；之后两者独立保存。新安装先保存读图设置，再截图或导入；没有配置时只保存资料，不调用模型。Codex 读图可单独设置 `reasoningEffort`，每轮通过 `turn/start.effort` 传入，可用等级由模型决定，不修改全局 Codex 配置。

「启动 Agent」只启动持久问答会话，「停止」也只停止问答。保存新的读图设置会取消尚未完成的读图任务，原件保留，后续新增任务使用新配置。关闭应用会停止问答、正在执行的临时 Agent 与排队任务；下次启动不自动处理旧的待概述资料。历史资料与对话文件不删除。

Agent 的权限请求显示为独立对话框，必须由用户明确提交。关闭表示取消，连接失败不视为允许。

## 检索与回答

原始内容先落盘，再由临时 Agent 生成概述。用户提问时，软件从概述文件读取内容，每批最多 30 条交给持久 Agent 规划阅读，最终最多保留 4 条相关资料。持久 Agent 默认依据概述回答；只有概述不足以回答问题，或用户明确要求核对原件时，才请求相应原文或图片。阅读规划中的原件 ID 必须是已选资料 ID 的子集，软件验证后才加载，回答区分概述与原始证据并标注资料 ID。

新概述文件缺失或损坏会明确报错，不以索引缓存冒充文件内容。旧版仅保存在 `index.json` 中的概述仍可读取；点击「重新生成概述」会通过新的临时 Agent 写入独立文件。

未整理的资料不参与检索；格式错误的 ID、缺失原件或模型失败会明确报告。原文不会被静默截断。单条文本最大 64 KiB，图片最大 20 MiB，当前接收 PNG/JPEG。

当前已确认的本地个人记忆由桌面后端提供给持久回答会话，不发送给临时读图会话。资料和记忆不会因此自动上传个人助手服务器；模型推理仍遵循各自 Agent 的服务配置。

## 构建和验证

从项目根目录执行：

```sh
./build-desktop.sh
./test-desktop.sh
```

公共 Swift 参数在 `scripts/native-common.sh`。构建输出统一进入 `.local/native` 和 `.local/qt`。macOS 应用内部的截图服务位于 `Contents/Helpers/QiyiCaptureService.app`。

单独调试服务时，执行构建产物 `qiyi-capture-service --directory <绝对资料目录> --no-hotkey`。stdin/stdout 为 JSONL，stderr 为诊断；关闭 stdin 会停止服务和 Agent。macOS 辅助 CLI `qiyi-capture-cli status` 只查询权限，`capture --output <目录>` 单次截图。
