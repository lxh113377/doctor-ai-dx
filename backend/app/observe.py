"""可观测性——镜像 frontend/functions/lib/observe.js：请求标识 + 结构化日志 + 出站前脱敏。
约束：响应体仍只含医生可理解文案（不出现堆栈/内部路径/密钥）。
"""
import json
import re
import uuid

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{8,}", re.I),
]
# 患者可识别信息形态（与 JS 端 OBSERVE_PATTERNS.pii 逐条同序）：
# 负向断言防误伤——13 位毫秒时间戳内含满足 1[3-9]\d{9} 的 11 位子串，无边界会造成假脱敏。
PII_PATTERNS = [
    re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    re.compile(r"(?<![\dXx])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?![\dXx])"),
]
INTERNAL_PATTERNS = [
    re.compile(r"file://\S+"),
    re.compile(r"(?:[A-Za-z]:\\|/(?:home|Users|var|app)/)\S+"),
    re.compile(r"\bat\s+\S+\s+\([^)]*\)"),
]

OBSERVE_PATTERNS = {
    "secret": [p.pattern for p in SECRET_PATTERNS],
    "pii": [p.pattern for p in PII_PATTERNS],
    "internal": [p.pattern for p in INTERNAL_PATTERNS],
}

SLOW_MS = 8000


def new_request_id() -> str:
    return uuid.uuid4().hex[:8]


def redact(value, env_key: str | None = None) -> str:
    """写日志或回显前必须过这一关：截断 + 密钥/内部路径替换。"""
    text = str(value if value is not None else "")[:300]
    if env_key and len(env_key) >= 6:
        text = text.replace(env_key, "[已脱敏]")
    for pattern in SECRET_PATTERNS + PII_PATTERNS:
        text = pattern.sub("[已脱敏]", text)
    for pattern in INTERNAL_PATTERNS:
        text = pattern.sub("[内部路径]", text)
    return text


def log_event(level: str, **fields) -> None:
    line = json.dumps({"app": "doctor-ai-dx", "lvl": level, **fields}, ensure_ascii=False)
    print(line, flush=True)
