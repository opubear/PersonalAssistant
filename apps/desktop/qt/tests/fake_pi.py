"""Deterministic offline agent used only by the integration tests."""
import json
import sys
import os
from pathlib import Path


def option(name):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def trace(event, **data):
    path = option("--trace")
    if path:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps({"pid": os.getpid(), "event": event, **data}, ensure_ascii=False) + "\n")


def emit(record):
    print(json.dumps(record, ensure_ascii=False), flush=True)


def finish(text):
    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
    emit({"type": "agent_settled", "aborted": False})


waiting = False
waiting_for_reader = False
trace("started")
for line in sys.stdin.buffer:
    record = json.loads(line)
    kind = record.get("type")
    if kind == "get_state":
        emit({"id": record["id"], "type": "response", "success": True})
    elif kind == "prompt":
        emit({"id": record["id"], "type": "response", "success": True, "data": {"disposition": "started"}})
        prompt = record["message"]
        trace("prompt", message=prompt, images=record.get("images", []))
        is_reader = "你负责为用户资料生成检索概述" in prompt or "你负责为用户截图生成检索概述" in prompt
        fail_marker = option("--fail-once-file")
        if is_reader and fail_marker and not Path(fail_marker).exists():
            Path(fail_marker).touch()
            emit({"type": "message_end", "message": {"role": "assistant", "errorMessage": "测试读图失败", "content": []}})
            emit({"type": "agent_settled", "aborted": False})
        elif is_reader and "--hold-reader" in sys.argv:
            waiting = True
            waiting_for_reader = True
            emit({"type": "extension_ui_request", "id": "reader-approval", "method": "select", "title": "读图测试等待", "options": ["允许本次", "拒绝本次"]})
        elif is_reader:
            finish("资料概述：测试交付日期和原文标记。")
        elif "概述目录：" in prompt:
            catalog = json.loads(prompt.split("概述目录：", 1)[1])
            ids = [entry["id"] for entry in catalog[:4]]
            finish(json.dumps({"ids": ids, "readOriginalIds": [] if "概述即可" in prompt else ids}))
        elif "要求审批" in prompt:
            waiting = True
            emit({"type": "extension_ui_request", "id": "test-approval", "method": "select", "title": "测试操作", "options": ["允许本次", "拒绝本次"]})
        else:
            finish("已读取原文：SOURCE_MARKER" if "SOURCE_MARKER" in prompt else "没有引用原文。")
    elif kind == "extension_ui_response" and waiting:
        waiting = False
        finish("临时读图概述已完成。" if waiting_for_reader else "用户选择：" + record.get("value", "取消"))
trace("stopped")
