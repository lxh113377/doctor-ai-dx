"""CDS Hooks 2.0 适配层（镜像面）。

与权威面 `frontend/functions/lib/cds_hooks.js` 同形同序：卡片字段插入顺序、模板填充、截断口径都按
同一份规则实现，由 `frontend/tests/cds_guard.mjs` + `cds_hooks_guard.mjs` 逐字段对账（含双端 JSON 全等）。
立论、规范出处与三条产品红线在本层的落法见 JS 文件头注释，此处不重复第二份说明（同一事实只说一次）。
"""
import re
from typing import Any

from ..cds_services import (
    CDS_DETAIL_TEMPLATES,
    CDS_INDICATOR_MAP,
    CDS_OVERRIDE_REASONS,
    CDS_SERVICES,
    CDS_SOURCE,
    CDS_SUMMARY_TEMPLATES,
)
from ..limits import MAX_CONTENT_CHARS, MAX_HISTORY_ITEMS
from ..mock import CASES
from ..rules import match_scope_rule, scan_flag_details

# 规范原文（Card Attributes）：summary 是 `<140-character`，即 139 为可接受上界。
SUMMARY_MAX_CHARS = 139

_SERVICE_BY_ID: dict[str, dict[str, Any]] = {s["id"]: s for s in CDS_SERVICES}
_CASE_BY_ID: dict[str, dict[str, Any]] = {c["id"]: c for c in CASES}


class CdsInputError(ValueError):
    """规范 REQUIRED 字段缺失/类型不合/hook 不匹配。路由把它翻译成 422（与权威面 RequestBadShape 同码）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class CdsServiceNotFound(LookupError):
    """未知 service id。路由翻译成 404，文案由既有处理器给出 `not found: <path>`（与权威面同形）。"""


def _fill(tpl: str, vars: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        key = m.group(1)
        return str(vars[key]) if key in vars and vars[key] is not None else m.group(0)

    return re.sub(r"\{(\w+)\}", repl, tpl)


def discovery_document() -> dict[str, Any]:
    """GET /cds-services 响应体：只出规范声明的五个字段。"""
    return {
        "services": [
            {
                "hook": s["hook"],
                "title": s["title"],
                "description": s["description"],
                "id": s["id"],
                "usageRequirements": s["usageRequirements"],
            }
            for s in CDS_SERVICES
        ]
    }


def known_service_ids() -> list[str]:
    return [s["id"] for s in CDS_SERVICES]


def _make_card(summary_tpl: str, detail_tpl: str, vars: dict[str, Any], severity: str) -> dict[str, Any]:
    raw = _fill(summary_tpl, vars)
    return {
        "summary": raw if len(raw) <= SUMMARY_MAX_CHARS else raw[: SUMMARY_MAX_CHARS - 1] + "…",
        "indicator": CDS_INDICATOR_MAP.get(severity, "info"),
        "detail": _fill(detail_tpl, vars),
        "source": {"label": CDS_SOURCE["label"], "url": CDS_SOURCE["url"]},
        "overrideReasons": CDS_OVERRIDE_REASONS,
    }


def _build_text(context: dict[str, Any]) -> str:
    parts: list[str] = []
    pid = context.get("patientId")
    if isinstance(pid, str) and pid.strip():
        case = _CASE_BY_ID.get(pid)
        if case is None:
            raise CdsInputError(
                f"context.patientId {pid!r} 不在内置脱敏病例名册（只认 {'/'.join(_CASE_BY_ID)}）"
            )
        parts.append(case["chief"])
    syms = context.get("symptoms")
    if syms is not None:
        if not isinstance(syms, list):
            raise CdsInputError(f"context.symptoms 类型 {type(syms).__name__} ≠ array")
        if len(syms) > MAX_HISTORY_ITEMS:
            raise CdsInputError(f"context.symptoms 条数 {len(syms)} > {MAX_HISTORY_ITEMS}")
        for i, s in enumerate(syms):
            if not isinstance(s, str):
                raise CdsInputError(f"context.symptoms[{i}] 类型 {type(s).__name__} ≠ string")
            if len(s) > MAX_CONTENT_CHARS:
                raise CdsInputError(f"context.symptoms[{i}] 长度 {len(s)} > {MAX_CONTENT_CHARS}")
            # 只收非空白条目（与权威面同口径）：全空白会拼出分隔符残留串，把「没东西可判」说成「判过了」。
            if s.strip():
                parts.append(s)
    return "；".join(parts)


def invoke_service(service_id: str, body: dict[str, Any]) -> dict[str, Any]:
    svc = _SERVICE_BY_ID.get(service_id)
    if svc is None:
        raise CdsServiceNotFound(service_id)
    if body is None or isinstance(body, list):
        raise CdsInputError("CDS Hooks 请求体必须是 JSON 对象")
    for field in ("hook", "hookInstance"):
        val = body.get(field)
        if not isinstance(val, str) or not val.strip():
            raise CdsInputError(f"缺规范 REQUIRED 字段 {field}")
    context = body.get("context")
    if not isinstance(context, dict):
        raise CdsInputError("缺规范 REQUIRED 字段 context（或类型不是 object）")
    if body["hook"] != svc["hook"]:
        raise CdsInputError(
            f"hook={body['hook']} 与服务 {service_id} 在 discovery 中声明的 hook={svc['hook']} 不一致"
        )
    text = _build_text(context)
    if not text.strip():
        raise CdsInputError(
            "context 里没有任何可判读文字（symptoms 缺失或全空白，patientId 未给）；本服务不返回空卡冒充「已评估」"
        )

    if service_id == "red-flag-screen":
        return {
            "cards": [
                _make_card(
                    CDS_SUMMARY_TEMPLATES["red_flag"],
                    CDS_DETAIL_TEMPLATES["red_flag"],
                    {"name": h["name"], "severity": h["severity"], "advice": h["advice"]},
                    h["severity"],
                )
                for h in scan_flag_details(text)
            ]
        }
    if service_id == "scope-boundary":
        rule = match_scope_rule(text)
        if rule is None:
            return {"cards": []}
        return {
            "cards": [
                _make_card(
                    CDS_SUMMARY_TEMPLATES["scope"],
                    CDS_DETAIL_TEMPLATES["scope"],
                    {
                        "title": rule["title"],
                        "rationale": rule["rationale"],
                        "doctor_note": rule["doctor_note"],
                        "matched": "、".join(rule["matched"]),
                    },
                    "中",
                )
            ]
        }
    # 目录里有服务但没有对应的判定分支＝数据领先于实现，交给既有 5xx 处理器（不静默发空卡）。
    raise RuntimeError(f"cds service {service_id} 在目录中但没有实现分支")
