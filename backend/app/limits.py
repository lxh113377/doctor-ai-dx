"""API 滥用护栏（镜像 frontend/functions/lib/limits.js）——数值单一源 = frontend/tests/fixtures/request_limits.json。

为什么存在（对标实测）：同类项目对请求体一律有显式上界（ragflow `docker/nginx/nginx.conf` 设
`client_max_body_size 1024M`；OpenEMR 走 PHP/Apache 上传上限）。权威面（Cloudflare Pages）没有边缘
nginx，上界只能写在应用层；镜像面 FastAPI 此前同样零上限。三处数值由 `frontend/tests/limits_guard.mjs`
逐字段对账，任一处改动未同步即判红（与双端 OBSERVE_PATTERNS 同一手法）。

上限取值依据实测：本仓合法峰值 body 510 B / history 5 条 ⇒ 128x 余量，不是随手整数。
红线：只做入站边界，不参与诊断/红旗/引用判定。
"""
from __future__ import annotations

import json
from typing import Any

MAX_BODY_BYTES = 65536  # 64 KiB
MAX_HISTORY_ITEMS = 64
MAX_CONTENT_CHARS = 2000
MAX_DX_JSON_BYTES = 65536

STATUS_TOO_LARGE = 413
STATUS_BAD_JSON = 400

# 对外唯一文案（与 Functions 侧 `lib/limits.js` 同字）；细节只进日志的 msg 字段。
TOO_LARGE_PUBLIC_MESSAGE = "请求内容超出可处理范围，请精简问诊记录后重试"


class RequestTooLarge(Exception):
    """超限：对外只出医生可理解文案，细节留在 reason（服务端日志用）。

    对外文案取**模块常量**而不是 `str(exc)`：`str(exc)` 恰好是 CodeQL
    `py/stack-trace-exposure` 的污点形状（"异常对象进响应体"），留着它就会常驻一条
    error 级开放告警——而本项目自己承诺"错误响应不展示堆栈或内部路径"。改成常量后，
    这条承诺第一次有了可判红的出口（见 `tests/test_limits.py` 第 6 节 + 变异实测）。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(TOO_LARGE_PUBLIC_MESSAGE)
        self.reason = reason
        self.public_message = TOO_LARGE_PUBLIC_MESSAGE
        self.status = STATUS_TOO_LARGE


def byte_len(text: str | None) -> int:
    return len((text or "").encode("utf-8"))


def check_declared_size(content_length: str | None) -> None:
    """Content-Length 是第一道（可伪造），真实字节由 check_history / check_dx 的条数×字数量级兜住。"""
    try:
        declared = int(content_length) if content_length else 0
    except ValueError:
        return
    if declared > MAX_BODY_BYTES:
        raise RequestTooLarge(f"content-length {declared} > {MAX_BODY_BYTES}")


def _check_text(value: Any, where: str) -> None:
    if isinstance(value, str) and len(value) > MAX_CONTENT_CHARS:
        raise RequestTooLarge(f"{where} 长度 {len(value)} > {MAX_CONTENT_CHARS}")


def check_history(history: Any) -> None:
    if history is None:
        return
    if not isinstance(history, list):
        return  # 非数组交给引擎既有分支（保持双端 500 语义一致）
    if len(history) > MAX_HISTORY_ITEMS:
        raise RequestTooLarge(f"history 条数 {len(history)} > {MAX_HISTORY_ITEMS}")
    for i, item in enumerate(history):
        if isinstance(item, dict):
            _check_text(item.get("content"), f"history[{i}].content")


def check_dx(dx: Any) -> None:
    if dx is None:
        return
    if byte_len(json.dumps(dx, ensure_ascii=False)) > MAX_DX_JSON_BYTES:
        raise RequestTooLarge("dx 体积超上限")
    if isinstance(dx, dict):
        _check_text(dx.get("conclusion"), "dx.conclusion")
        evidence = dx.get("evidence")
        if isinstance(evidence, list):
            for i, ev in enumerate(evidence[:MAX_HISTORY_ITEMS]):
                if isinstance(ev, dict):
                    _check_text(ev.get("text"), f"dx.evidence[{i}].text")


