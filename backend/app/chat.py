"""对话面镜像实现（FastAPI 侧）。

与 `frontend/functions/lib/` 的 intent.js / pii.js / handoff.js / chat.js **同源同规则**：
意图表来自 `intents.py`（构建期产物，与 functions/lib/intents.js 同源），逻辑逐条镜像。

为什么要有镜像面：既有对账矩阵要求双端逐字段一致（contract_parity），对话面不例外。
但**持久化与后台是 Pages-only 能力**——D1 绑定只存在于 Cloudflare 侧，镜像面不复制一份 SQLite，
否则就出现两个真值。对账矩阵里这两行显式标注 Pages-only，理由写进 docs/ARCHITECTURE.md。
"""
from __future__ import annotations

import re
from typing import Any, cast

from .intents import INTENT_BY_ID, INTENTS

RED_FLAG_INTENT = "red_flag"
SERVICE_INTENT_IDS = ("refund", "order_query", "tech_support")
HUMAN_ASK_TERMS = ("人工", "转人工", "客服", "真人", "人工服务", "找客服", "叫客服", "人工客服")

MAX_TEXT = 2000
CHAT_MAX_TURNS = 32

# ---- 红旗：镜像面复用既有规则层，不另写一份（红线 1：规则层只有一处） ----
from .rules import scan_flag_details  # noqa: E402  （放最后以免与上面的常量定义交错）

# ---------------------------------------------------------------- 脱敏

def _mask_name_keep_first(m: str) -> str:
    """把末尾的 2-4 个汉字姓名掩成「首字 + 星号」。只处理显式自报形态，不做全文人名猜测。"""
    return re.sub(r"[一-龥]{2,4}$", lambda n: n.group(0)[0] + "*" * (len(n.group(0)) - 1), m)


_PII_PATTERNS: tuple[tuple[str, re.Pattern[str], Any], ...] = (
    ("id_card", re.compile(r"\d{17}[\dXx]|\d{15}"), lambda m: m[:2] + "*" * max(0, len(m) - 4) + m[-2:]),
    ("phone", re.compile(r"1[3-9]\d{9}"), lambda m: m[:3] + "****" + m[-4:]),
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]{2,}"), lambda m: m[0] + "***@" + m.split("@")[1]),
    (
        "address",
        re.compile(r"[一-龥]{2,8}(?:省|市|区|县)[一-龥0-9]{0,12}?(?:路|街|道|巷|号|栋|单元|室|楼)[一-龥0-9\-]{0,10}"),
        lambda m: re.sub(r"[一-龥0-9\-]+$", lambda t: "*" * len(t.group(0)), m),
    ),
    ("name", re.compile(r"姓名[:：]?\s*[一-龥]{2,4}"), _mask_name_keep_first),
    ("name", re.compile(r"(?:我叫|患者|病人)\s*[一-龥]{2,4}"), _mask_name_keep_first),
    ("name", re.compile(r"[一-龥]{1,2}(?:先生|女士|大夫|医生)"), lambda m: m[0] + "*" + m[-2:]),
)

MAX_PII_TEXT = 4000


def redact_pii(text: str) -> dict[str, Any]:
    """脱敏单段文本，返回 {"text", "hits"}；与前端 pii.js 同规则同顺序。"""
    src = str(text or "")[:MAX_PII_TEXT]
    hits: list[dict[str, Any]] = []
    for kind, pattern, mask in _PII_PATTERNS:
        count = 0

        def _sub(m: re.Match[str], _mask: Any = mask) -> str:
            nonlocal count
            count += 1
            return str(_mask(m.group(0)))

        out = pattern.sub(_sub, src)
        if count:
            hits.append({"type": kind, "count": count})
            src = out
    return {"text": src, "hits": hits}


# ---------------------------------------------------------------- 意图


def _to_confidence(score: float) -> float:
    if score <= 0:
        return 0.0
    return round(min(0.95, score / (score + 3)), 3)


def detect_intent(text: str) -> dict[str, Any]:
    """识别主入口。红旗闸门在第一步，命中即返回 red_flag，永不进客服分支（红线 1 的落点）。"""
    raw = str(text or "").lower()[:MAX_TEXT]

    flags = scan_flag_details(raw)
    if flags:
        return {
            "intent": RED_FLAG_INTENT,
            "confidence": 1.0,
            "matched": [f["name"] for f in flags],
            "negations": [],
            "flags": flags,
            "need_human": False,
        }

    need_human = any(t in raw for t in HUMAN_ASK_TERMS)
    negations: list[str] = []
    scored: list[tuple[str, float, list[str]]] = []
    for spec in cast("list[dict[str, Any]]", INTENTS):
        matched = [kw for kw in spec["keywords"] if kw.lower() in raw]
        if not matched:
            continue
        veto = [n for n in spec["negative_terms"] if n.lower() in raw]
        if veto:
            negations.extend(veto)
            continue
        scored.append((spec["id"], sum(len(k) ** 0.5 for k in matched), matched))

    scored.sort(key=lambda r: (-r[1], r[0]))
    if not scored:
        return {
            "intent": "out_of_scope",
            "confidence": 0.0,
            "matched": [],
            "negations": negations,
            "flags": [],
            "need_human": need_human,
        }
    intent_id, score, matched = scored[0]
    return {
        "intent": intent_id,
        "confidence": _to_confidence(score),
        "matched": matched,
        "negations": negations,
        "flags": [],
        "need_human": need_human,
    }


def should_retrieve_faq(intent: str) -> bool:
    """只有 reply_policy=route_dx（医疗问诊）才检索临床知识库：客服三类检索只会得到驴唇不对马嘴的引用。"""
    spec = cast("dict[str, Any] | None", INTENT_BY_ID.get(intent))
    if spec is None:
        return False
    return str(spec["reply_policy"]) == "route_dx"


# ---------------------------------------------------------------- 转人工

REASON_CODES = {
    "RED_FLAG": "RED_FLAG",
    "USER_REQUESTED": "USER_REQUESTED",
    "OUT_OF_SCOPE": "OUT_OF_SCOPE",
    "LOW_CONFIDENCE": "LOW_CONFIDENCE",
    "MISSING_SLOT": "MISSING_SLOT",
    "REPEATED_FAILURE": "REPEATED_FAILURE",
    "ABSTAIN": "ABSTAIN",
}

REASON_TEXT = {
    "RED_FLAG": "已识别到危险信号，优先按急诊与转诊提示处理",
    "USER_REQUESTED": "您要求人工服务，已为您转接",
    "OUT_OF_SCOPE": "该问题超出本系统可处理范围，已转人工客服",
    "LOW_CONFIDENCE": "连续多轮未能确认您的意图，已转人工客服",
    "MISSING_SLOT": "缺少查询所需的关键信息且未能补齐，已转人工客服",
    "REPEATED_FAILURE": "技术支持问题重复出现仍未解决，已转人工客服",
    "ABSTAIN": "现有知识库证据不足，未作判断，已转人工客服",
}

LOW_CONFIDENCE_TURNS = 3
REPEATED_FAILURE_TURNS = 2
SLOT_RE = re.compile(r"(\d{6,})|(?:编号|号码|单号|号)\s*[:：]?\s*[A-Za-z0-9-]{4,}")
SLOT_REQUIRED_POLICIES = {"service_refund", "service_order_query"}

COMPLIANCE_LINE = "本回复为 AI 辅助参考 · 医生终审，不能替代医生面诊。"


def decide_handoff(
    *,
    intent: str,
    confidence: float = 0.0,
    flags: list | None = None,
    need_human: bool = False,
    unresolved_turns: int = 0,
    missing_slot: bool = False,
    abstain: bool = False,
) -> dict[str, Any]:
    """转人工判定。纯函数、无 IO ⇒ 可单测、可穷举。与前端 handoff.js 逐条镜像。"""
    flags = list(flags or [])
    spec = cast("dict[str, Any] | None", INTENT_BY_ID.get(intent))

    def hit(code: str, digest: str = "") -> dict[str, Any]:
        return {
            "need_handoff": True,
            "reason_code": code,
            "reason_text": REASON_TEXT[code],
            "context_digest": digest,
        }

    # 1) 红旗永远第一位：哪怕用户同时在说「我要退费」，也先按急诊处理，不排队。
    if intent == RED_FLAG_INTENT or flags:
        first = cast("dict[str, Any] | None", flags[0]) if flags else None
        digest = str((first or {}).get("name", ""))[:80]
        return hit(REASON_CODES["RED_FLAG"], digest)
    # 2) 用户显式要人工。
    if need_human:
        return hit(REASON_CODES["USER_REQUESTED"])
    policy = spec["handoff_policy"] if spec else ""
    # 3) 总是转人工（超范围）。
    if policy == "always_handoff":
        return hit(REASON_CODES["OUT_OF_SCOPE"])
    # 4) 缺关键信息且用户不补。
    if policy == "escalate_if_missing_slot" and missing_slot:
        return hit(REASON_CODES["MISSING_SLOT"])
    # 5) 技术支持重复失败。
    if policy == "escalate_if_repeated" and unresolved_turns >= REPEATED_FAILURE_TURNS:
        return hit(REASON_CODES["REPEATED_FAILURE"])
    # 6) 证据不足弃权：医疗类不许硬答。
    if policy == "abstain_or_low_confidence" and abstain:
        return hit(REASON_CODES["ABSTAIN"])
    # 7) 连续低置信。
    floor = float(spec["confidence_floor"]) if spec else 0.3
    if unresolved_turns >= LOW_CONFIDENCE_TURNS and confidence < floor:
        return hit(REASON_CODES["LOW_CONFIDENCE"])
    return {"need_handoff": False, "reason_code": "", "reason_text": "", "context_digest": ""}
# ---------------------------------------------------------------- 话术与编排

_SERVICE_TEMPLATES = {
    "service_refund": [
        "挂号与缴费的退费、退号属于院内窗口业务，需要本人在场办理。",
        "请携带就诊凭证与缴费票据到挂号收费窗口办理退费；已就诊且无法退费的情形由窗口核实后判定。",
        "退款到账时间以支付渠道为准，本系统不代收也不代退费用。",
    ],
    "service_order_query": [
        "检查报告、处方与挂号单属于个人医疗记录，需凭本人身份在院内自助机或医生工作站查询。",
        "本系统不存储、也不代为展示你的报告内容，避免隐私泄露。",
        "报告出具时间以检验科/影像科实际出报告时间为准，部分项目需等待 1 至 3 个工作日。",
    ],
    "service_tech_support": [
        "页面打不开、登录异常等问题，请先尝试刷新页面并确认网络连接正常。",
        "浏览器建议使用 Chrome、Edge 等主流浏览器的较新版本。",
        "如问题重复出现，请记下发生时间与页面提示，我们将通过人工客服跟进。",
    ],
    "abstain_and_handoff": [
        "这个问题超出了本系统可处理的范围，我不会给出可能不准确的回答。",
        "已为您转接人工客服进一步协助。",
    ],
}


def synthesize(
    *, intent: str, flags: list | None = None, handoff_reason_text: str = "", faq: dict | None = None
) -> dict[str, Any]:
    """确定性话术。红旗路径逐字复述规则层建议，一条都不改写（红线 1）。"""
    flags = flags or []
    if intent == RED_FLAG_INTENT and flags:
        lines = [f"· {f['name']}：{f['advice']}" for f in flags]
        lines.append("请立即停止自行处理并前往急诊或联系 120；不要等待本系统进一步回复。")
        return {"text": "\n".join(lines) + "\n\n" + COMPLIANCE_LINE, "citations": []}
    if faq:
        return {"text": faq["text"] + "\n\n" + COMPLIANCE_LINE, "citations": faq.get("citations", [])}
    template = _SERVICE_TEMPLATES.get(intent)
    lines = list(template) if template else []
    if handoff_reason_text:
        lines.append(handoff_reason_text + "。")
    if not template and intent != "out_of_scope":
        lines = ["该问题我暂时无法给出可靠答复，已为您转接人工客服。"]
    return {"text": "\n".join(lines) + "\n\n" + COMPLIANCE_LINE, "citations": []}


def build_faq_answer(query: str, flags: list | None = None) -> dict[str, Any]:
    """FAQ 答案包，复用镜像面 rag.search / rag.answerability（不另设弃权阈值）。"""
    from . import rag  # noqa: PLC0415

    evidence = rag.search(str(query or ""), 4)
    verdict = rag.answerability(evidence, flags or [])
    citations = [
        {
            "evidence_id": e["id"],
            "title": e["title"],
            "source": e["source"],
            "year": e["year"],
            "section": e["section"],
        }
        for e in evidence
    ]
    if verdict["abstain"]:
        text = (
            "这个问题超出了本系统可处理的范围，已为您转接人工客服进一步协助。"
            if verdict["scope_status"] == "out-of-scope"
            else "现有知识库证据不足，我不对此作出判断。建议线下由执业医生面诊评估。"
        )
        return {"text": text, "citations": [], "abstain": True, "scope_status": verdict["scope_status"]}
    lines = [
        f"· {e['title']}（{e['source']}{(' ' + str(e['year'])) if e.get('year') else ''}）" for e in evidence[:3]
    ]
    return {
        "text": "\n".join(
            [
                "以下为可追溯到指南/共识的参考信息，仅供辅助参考，不能替代医生面诊：",
                *lines,
                "如症状加重或出现新的不适，请立即线下就诊。",
            ]
        ),
        "citations": citations,
        "abstain": False,
        "scope_status": verdict["scope_status"],
    }

def handle_chat(payload: dict[str, Any]) -> dict[str, Any]:
    """镜像面编排。与前端 chat.js 同序：红旗 → 意图 → FAQ → 转人工 → 话术。

    持久化是 Pages-only：镜像面不复制一份存储，否则出现两个真值，故 persisted 恒为 False 并给出原因。
    """
    from .version import APP_VERSION

    raw = str(payload.get("text") or "").strip()
    if not raw:
        raise ValueError("请求参数不完整，请刷新后重试")
    if len(raw) > MAX_TEXT:
        raise ValueError("请求参数不完整，请刷新后重试")
    history = payload.get("history") or []
    if not isinstance(history, list):
        raise ValueError("请求参数不完整，请刷新后重试")
    turns = len(history) // 2
    if turns > CHAT_MAX_TURNS:
        raise ValueError("请求内容超出可处理范围，请精简问诊记录后重试")

    det = detect_intent(raw)
    faq = build_faq_answer(raw, det["flags"]) if should_retrieve_faq(det["intent"]) else None

    spec = cast("dict[str, Any] | None", INTENT_BY_ID.get(det["intent"]))
    policy = spec["reply_policy"] if spec else ""
    prior = " ".join(str(h.get("content") or "") for h in history if isinstance(h, dict) and h.get("role") == "user")
    missing_slot = policy in SLOT_REQUIRED_POLICIES and not (SLOT_RE.search(raw) or SLOT_RE.search(prior))

    handoff = decide_handoff(
        intent=det["intent"],
        confidence=det["confidence"],
        flags=det["flags"],
        need_human=det["need_human"],
        unresolved_turns=turns,
        missing_slot=missing_slot,
        abstain=bool(faq and faq["abstain"]),
    )
    answer = synthesize(
        intent=det["intent"],
        flags=det["flags"],
        handoff_reason_text=handoff["reason_text"] if handoff["need_handoff"] else "",
        faq=faq,
    )

    red_flag = None
    if det["intent"] == RED_FLAG_INTENT and det["flags"]:
        first = det["flags"][0]
        red_flag = {"name": first["name"], "severity": first["severity"], "advice": first["advice"]}

    handoff_out = None
    if handoff["need_handoff"]:
        cid = str(payload.get("conversation_id") or "local")
        handoff_out = {
            "reason_code": handoff["reason_code"],
            "reason_text": handoff["reason_text"],
            "ticket_id": f"HO-{cid[-6:]}-{handoff['reason_code']}",
        }

    return {
        "conversation_id": payload.get("conversation_id"),
        "intent": det["intent"],
        "confidence": det["confidence"],
        "answer": answer,
        "red_flag": red_flag,
        "handoff": handoff_out,
        "abstain": bool(faq and faq["abstain"]),
        "mode": "deterministic",
        "answer_source": "deterministic",
        "persisted": False,
        "persist_reason": "镜像面不持久化（会话存储是 Cloudflare D1 的 Pages-only 能力，见 ARCHITECTURE 对账矩阵）",
        "version": APP_VERSION,
    }


# ---------------------------------------------------------------- 后台鉴权（镜像面）


def authorize_admin(expected: str | None, got: str | None) -> tuple[bool, int, str]:
    """与 admin_auth.js 同口径：没配令牌一律拒绝（503），不因为「没配」就放行。

    返回 (ok, status, message)。令牌比对走恒定时间比较，避免按前缀早退泄露长度。
    """
    expected = str(expected or "").strip()
    if not expected:
        return False, 503, "管理后台未启用：服务器未配置 ADMIN_TOKEN"
    got = str(got or "").strip()
    if not got:
        return False, 401, "未提供管理令牌"
    diff = len(got) ^ len(expected)
    for i in range(max(len(got), len(expected))):
        diff |= (ord(got[i]) if i < len(got) else 0) ^ (ord(expected[i]) if i < len(expected) else 0)
    if diff != 0:
        return False, 403, "管理令牌不正确"
    return True, 200, ""