"""双端错误码对账的 **py 侧取样器**（v1.19.0 第二十一轮；由 frontend/tests/error_parity_guard.mjs 调用）。

跑法：python tests/error_parity_dump.py（零网络、零密钥；单独跑便于人工复算）
契约：读 `frontend/tests/fixtures/error_parity.json`（唯一真值源），逐条打镜像面 status+message，
以 JSON 数组写 stdout。node 侧用同一份 fixture 打权威面，再逐条三方对账（期望／JS／Py）。
刻意不在此处断言：判据只有一处比较才不会"两端各写一遍、各自都自证通过"。
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE = os.path.join(REPO, "frontend", "tests", "fixtures", "error_parity.json")

from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)


def build_body(case: dict[str, Any]) -> tuple[str, str | None, Any]:
    """返回 (content_type, raw_text, json_body)。raw_text 非 None 时按原文发送（构造坏 JSON）。"""
    body = json.loads(json.dumps(case.get("json", {})))  # 深拷贝，避免改到 fixture 内存对象
    if case.get("repeat_items"):
        one = body["history"][0]
        body["history"] = [dict(one) for _ in range(int(case["repeat_items"]))]
    if case.get("repeat_content"):
        body["history"][0]["content"] = "腹" * int(case["repeat_content"])
    if case.get("raw") is not None:
        return "application/json", case["raw"], None
    return "application/json", None, body


def main() -> int:
    if not os.path.exists(FIXTURE):
        print(f"缺 fixture: {FIXTURE}", file=sys.stderr)
        return 2
    cases = json.load(open(FIXTURE, encoding="utf-8"))["cases"]
    out = []
    for case in cases:
        content_type, raw, body = build_body(case)
        headers = {"content-type": content_type}
        data = raw.encode("utf-8") if raw is not None else json.dumps(body).encode("utf-8")
        resp = client.request(case.get("method", "POST"), case["path"], content=data, headers=headers)
        try:
            message = resp.json().get("message")
        except Exception:  # noqa: BLE001
            message = None
        out.append({"name": case["name"], "status": resp.status_code, "message": message})
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
