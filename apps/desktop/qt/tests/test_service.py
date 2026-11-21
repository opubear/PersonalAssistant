"""Runs the real Swift service and a local fake agent; no model account needed."""
import json
import base64
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest


class Service:
    def __init__(self, directory):
        self.process = subprocess.Popen([os.environ["QIYI_TEST_BACKEND"], "--directory", str(directory), "--no-hotkey"],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.records = queue.Queue()
        self.saved = []
        self.counter = 0

        def reader():
            for line in self.process.stdout:
                self.records.put(json.loads(line))
        self.reader = threading.Thread(target=reader, daemon=True)
        self.reader.start()

    def send(self, method, params=None):
        self.counter += 1
        request_id = str(self.counter)
        record = {"id": request_id, "method": method, "params": params or {}}
        self.process.stdin.write((json.dumps(record) + "\n").encode())
        self.process.stdin.flush()
        return request_id

    def wait(self, predicate, timeout=8):
        for index, record in enumerate(self.saved):
            if predicate(record):
                return self.saved.pop(index)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            record = self.records.get(timeout=max(.01, deadline - time.monotonic()))
            if predicate(record):
                return record
            self.saved.append(record)
        raise TimeoutError("Service did not reply")

    def request(self, method, params=None):
        request_id = self.send(method, params)
        record = self.wait(lambda item: item.get("id") == request_id)
        if "error" in record:
            raise RuntimeError(record["error"]["message"])
        return record["result"]

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
                raise
        self.process.stdout.close()
        self.reader.join(timeout=1)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.service = Service(self.directory.name)

    def tearDown(self):
        self.service.close()
        self.directory.cleanup()

    def start_agent(self):
        self.configure_reader()
        return self.service.request("agent/start", {"configuration": self.configuration()})

    def configuration(self, *extra):
        return {
            "provider": "pi", "executable": sys.executable,
            "arguments": ["-u", str(Path(__file__).with_name("fake_pi.py")), *extra], "basePrompt": "用中文回答。"}

    def configure_reader(self, *extra):
        return self.service.request("reader/configure", {"configuration": self.configuration(*extra)})

    def add_image(self):
        image = Path(self.directory.name) / "synthetic.png"
        image.write_bytes(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII="))
        return self.service.request("library/addImage", {"path": str(image)})

    def test_reopen_retains_text_without_an_agent(self):
        self.assertEqual(self.service.request("initialize")["protocolVersion"], 1)
        item = self.service.request("library/addText", {"text": "持久文本\n第二行"})
        self.service.close()
        self.service = Service(self.directory.name)
        records = self.service.request("library/list")
        self.assertEqual(records[0]["id"], item["id"])
        self.assertEqual(self.service.request("library/content", {"id": item["id"]})["text"], "持久文本\n第二行")

    def test_bad_settings_do_not_block_library_access_or_get_overwritten(self):
        settings = Path(self.directory.name) / "agent-settings.json"
        settings.write_text("invalid", encoding="utf-8")
        self.assertEqual(self.service.request("initialize")["configuration"]["provider"], "codex")
        self.service.request("library/addText", {"text": "仍可保存资料"})
        self.assertEqual(settings.read_text(), "invalid")

    def test_summary_selection_original_and_answer_round_trip(self):
        self.start_agent()
        item = self.service.request("library/addText", {"text": "交付日期为 11 月 20 日。SOURCE_MARKER"})
        self.service.request("library/summarize", {"id": item["id"]})
        records = self.service.request("library/list")
        self.assertEqual(records[0]["state"], "ready")
        answer = self.service.request("chat/ask", {"text": "交付日期是什么？"})
        self.assertEqual(answer["sources"][0]["id"], item["id"])
        self.assertIn("SOURCE_MARKER", answer["response"])
        self.assertTrue((Path(self.directory.name) / "library/conversations" / (answer["id"] + ".json")).exists())
        self.service.request("agent/stop")

    def test_each_image_uses_one_disposable_agent_without_starting_a_conversation(self):
        trace = Path(self.directory.name) / "reader-trace.jsonl"
        state = self.configure_reader("--trace", str(trace))
        self.assertEqual(state["configuration"]["basePrompt"], "")
        self.assertFalse(trace.exists(), "Saving reader settings must not launch a model")
        for _ in range(2):
            item = self.add_image()
            self.service.request("library/summarize", {"id": item["id"]})
            content = self.service.request("library/content", {"id": item["id"]})
            self.assertEqual(Path(content["summaryPath"]).read_text(), content["item"]["summary"])
        records = [json.loads(line) for line in trace.read_text().splitlines()]
        starts = [entry for entry in records if entry["event"] == "started"]
        prompts = [entry for entry in records if entry["event"] == "prompt"]
        self.assertEqual(len(starts), 2)
        self.assertEqual(len({entry["pid"] for entry in starts}), 2)
        self.assertEqual(len(prompts), 2)
        self.assertEqual(prompts[0]["message"], prompts[1]["message"])
        self.assertNotIn("用中文回答。", prompts[0]["message"])
        self.assertEqual([len(entry["images"]) for entry in prompts], [1, 1])
        with self.assertRaisesRegex(RuntimeError, "请先启动"):
            self.service.request("chat/ask", {"text": "没有持久 Agent"})
        self.service.wait(lambda item: item.get("event") == "readerStatus" and "文件已保存" in item["data"]["message"])

    def test_stopping_conversation_does_not_cancel_a_reader_interaction(self):
        self.configure_reader("--hold-reader")
        item = self.add_image()
        interaction = self.service.wait(lambda item: item.get("event") == "interaction")
        self.service.request("agent/start", {"configuration": self.configuration()})
        self.service.request("agent/stop")
        self.service.request("interaction/respond", {"id": interaction["data"]["id"], "kind": "choice", "value": "允许本次"})
        self.service.request("library/summarize", {"id": item["id"]})
        self.assertEqual(self.service.request("library/list")[0]["state"], "ready")

    def test_reader_configuration_does_not_cancel_a_conversation_interaction(self):
        self.start_agent()
        question = self.service.send("chat/ask", {"text": "要求审批"})
        interaction = self.service.wait(lambda item: item.get("event") == "interaction")
        self.configure_reader()
        self.service.request("interaction/respond", {"id": interaction["data"]["id"], "kind": "choice", "value": "拒绝本次"})
        response = self.service.wait(lambda item: item.get("id") == question)
        self.assertEqual(response["result"]["response"], "用户选择：拒绝本次")

    def test_reader_failure_does_not_end_conversation_or_prevent_the_next_image(self):
        self.start_agent()
        marker = Path(self.directory.name) / "reader-failed-once"
        self.configure_reader("--fail-once-file", str(marker))
        first = self.add_image()
        self.service.wait(lambda item: item.get("event") == "warning" and "概述未完成" in item["data"]["message"])
        self.assertEqual(self.service.request("library/content", {"id": first["id"]})["item"]["state"], "failed")
        second = self.add_image()
        self.service.request("library/summarize", {"id": second["id"]})
        self.assertEqual(self.service.request("library/content", {"id": second["id"]})["item"]["state"], "ready")
        answer = self.service.request("chat/ask", {"text": "概述即可"})
        self.assertIn("没有引用原文", answer["response"])

    def test_reader_settings_survive_a_restart_independently_of_conversation_settings(self):
        reader = self.configure_reader("--trace", str(Path(self.directory.name) / "separate-reader.jsonl"))
        self.service.request("agent/start", {"configuration": self.configuration()})
        self.service.close()
        self.service = Service(self.directory.name)
        state = self.service.request("initialize")
        self.assertEqual(state["reader"]["configuration"], reader["configuration"])
        self.assertNotEqual(state["reader"]["configuration"]["arguments"], state["configuration"]["arguments"])

    @unittest.skipUnless(os.name == "posix", "Process liveness check uses POSIX signal 0")
    def test_shutdown_stops_both_active_agent_processes(self):
        root = Path(self.directory.name)
        reader_trace, main_trace = root / "reader.jsonl", root / "main.jsonl"
        self.configure_reader("--hold-reader", "--trace", str(reader_trace))
        self.service.request("agent/start", {"configuration": self.configuration("--trace", str(main_trace))})
        self.add_image()
        self.service.wait(lambda item: item.get("event") == "interaction")
        pids = [json.loads(path.read_text().splitlines()[0])["pid"] for path in [reader_trace, main_trace]]
        self.service.close()
        for pid in pids:
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_interaction_waits_for_explicit_answer_and_service_stays_responsive(self):
        self.start_agent()
        question = self.service.send("chat/ask", {"text": "要求审批"})
        event = self.service.wait(lambda item: item.get("event") == "interaction")
        self.assertEqual(event["data"]["choices"][1]["id"], "拒绝本次")
        self.assertEqual(self.service.request("library/list"), [])
        self.assertFalse(any(item.get("id") == question for item in self.service.saved))
        self.service.request("interaction/respond", {"id": event["data"]["id"], "kind": "choice", "value": "拒绝本次"})
        answer = self.service.wait(lambda item: item.get("id") == question)
        self.assertEqual(answer["result"]["response"], "用户选择：拒绝本次")

    def test_invalid_request_reports_error_without_losing_data(self):
        self.service.request("library/addText", {"text": "已保存"})
        with self.assertRaises(RuntimeError):
            self.service.request("unknown/method")
        with self.assertRaises(RuntimeError):
            self.service.request("library/content", {"id": "../../outside"})
        self.assertEqual(len(self.service.request("library/list")), 1)


if __name__ == "__main__":
    unittest.main()
