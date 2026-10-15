"""trace_version.py — 决策指纹（第一百零九轮改进3）。镜像 frontend/functions/lib/trace_version.js。
trace.versions 三元组：app_version + kb_corpus_sha256 + rules_table_sha256，外加 retriever 与 engine_schema。
取数纪律：指纹**现算**（对构建期产物的 canonical JSON 做 sha256），不手抄——语料或规则表一改指纹即换。
双端同值由 frontend/tests/contract_parity.mjs（逐字段）与 trace_version_guard.mjs（指纹面）双向兜底。
"""
from __future__ import annotations

import hashlib
import json

from .. import knowledge as _kb
from .. import red_flag_rules as _rf
from ..retriever import DEFAULT_RETRIEVER
from ..version import APP_VERSION

ENGINE_SCHEMA = 1


def _canon(v) -> str:
    """递归 canonical 序列化（键全排序、紧凑分隔符）——与 trace_version.js 的 canon 同形。"""
    if isinstance(v, dict):
        return "{" + ",".join(
            json.dumps(str(k), ensure_ascii=False) + ":" + _canon(v[k]) for k in sorted(v, key=str)
        ) + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(_canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


_kb_sha: str | None = None
_rules_sha: str | None = None


def kb_corpus_sha256() -> str:
    global _kb_sha
    if _kb_sha is None:
        _kb_sha = _sha(_canon({"KNOWLEDGE_BASE": _kb.KNOWLEDGE_BASE, "SYMPTOM_TO_KB": _kb.SYMPTOM_TO_KB, "SYNONYMS": _kb.SYNONYMS}))
    return _kb_sha


def rules_table_sha256() -> str:
    global _rules_sha
    if _rules_sha is None:
        _rules_sha = _sha(_canon({
            "BP_THRESHOLDS": _rf.BP_THRESHOLDS,
            "COMBO_RULES": _rf.COMBO_RULES,
            "DANGER_RULES": _rf.DANGER_RULES,
            "NEGATION": _rf.NEGATION,
            "POSITIVE_TERMS": _rf.POSITIVE_TERMS,
            "RED_FLAG_SCHEMA": _rf.RED_FLAG_SCHEMA,
            "REFERRAL_DEPARTMENTS": _rf.REFERRAL_DEPARTMENTS,
        }))
    return _rules_sha


def trace_versions() -> dict:
    return {
        "app_version": APP_VERSION,
        "engine_schema": ENGINE_SCHEMA,
        "kb_corpus_sha256": kb_corpus_sha256(),
        "retriever": DEFAULT_RETRIEVER,
        "rules_table_sha256": rules_table_sha256(),
    }
