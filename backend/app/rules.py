"""危险信号规则引擎（红旗拦截层）——镜像 frontend/functions/lib/rules.js。
独立于 LLM：可解释、可单测，评审安全叙事核心。
设计：关键词须特异（防"出冷汗"等词单独误触发）；支持血压数值解析；命中即强制转诊。
"""
import re
import unicodedata
from typing import Any

from .red_flag_rules import BP_THRESHOLDS, COMBO_RULES, DANGER_RULES, NEGATION, POSITIVE_TERMS
from .scope_rules import SCOPE_META, SCOPE_RULES

# 两张规则表（连同否定词表 / 阳性例外词 / 血压阈值与脏读值域）外置到 data/red_flag_rules.json，
# 由 scripts/export_red_flags.mjs 生成 app/red_flag_rules.py（第三十一轮 #89）。
# 本文件只留判定逻辑：改规则改权威 JSON，禁手改生成物，
# 「权威 == JS == Py」三方全等由 frontend/tests/red_flag_table_guard.mjs 对账。

_HYPERTENSION_ADVICE = next(r["advice"] for r in DANGER_RULES if "高血压急症" in r["name"])

# ---------- 红旗表载入即校验（第三十轮 #83，镜像端与 rules.js 同语义）----------
# 红旗层是三条红线里唯一"数据即代码"的表；表坏＝危险信号漏报，或多条同名被去重分支静默合并成一条。
# 规格抄 peer：kheireddinedev00/Medico `triage/rules.py`（gh api 实测 size=13599B sha=19fc7fcc）——
# 不变量写在注释里、载入即 raise、错误信息点名违规项、无降级模式。
RED_FLAG_SEVERITIES = ["高", "中", "低"]


def _all_punct_or_blank(s: str) -> bool:
    """纯标点/符号/空白——分词层（第二十七轮）已把这类字符整体剔除，这样的关键词永不命中。"""
    return all(unicodedata.category(ch)[0] in ("P", "S", "Z") or ch.isspace() for ch in s)


def validate_red_flag_rules(danger: list | None = None, combo: list | None = None) -> list[str]:
    danger = DANGER_RULES if danger is None else danger
    combo = COMBO_RULES if combo is None else combo
    errs: list[str] = []
    owner: dict[str, str] = {}

    def terms(vals, at: str, where: str) -> None:
        if not isinstance(vals, list) or not vals:
            errs.append(f"{at}: {where} 须为非空数组")
            return
        for k in vals:
            if not isinstance(k, str) or not k.strip():
                errs.append(f"{at}: {where} 含空值或非字符串项 {k!r}")
                continue
            if len(k.strip()) < 2:
                errs.append(f"{at}: {where}「{k}」是裸单字（子串会横扫全文，第二十四轮假阳性同族）")
            elif _all_punct_or_blank(k.strip()):
                errs.append(f"{at}: {where}「{k}」是纯标点/空白（分词层已剔除标点 ⇒ 永不命中＝死规则）")

    def one(r, i: int, kind: str) -> None:
        if not isinstance(r, dict):
            errs.append(f"{kind}#{i}: 规则须为对象")
            return
        raw = r.get("name")
        nm = raw.strip() if isinstance(raw, str) else ""
        at = f"{kind}#{i}({nm or '?'})"
        if not nm:
            errs.append(f"{at}: name 缺失或为空")
        elif nm in owner:
            errs.append(f"{at}: name 与 {owner[nm]} 重复（同名会被去重分支静默合并＝少报一条危险信号）")
        else:
            owner[nm] = at
        if r.get("severity") not in RED_FLAG_SEVERITIES:
            errs.append(f"{at}: severity 只能是 {'/'.join(RED_FLAG_SEVERITIES)}，实测 {r.get('severity')!r}")
        adv = r.get("advice")
        if not isinstance(adv, str) or len(adv.strip()) < 10:
            errs.append(f"{at}: advice 缺失或短于 10 字（医生看不到处置＝等于没提示）")
        if kind == "DANGER":
            terms(r.get("keywords"), at, "keywords")
        else:
            groups = r.get("all")
            if not isinstance(groups, list) or len(groups) < 2:
                errs.append(f"{at}: 组合规则须 ≥2 组线索（单组等价于关键词规则，放这里只会掩盖分母）")
            else:
                for gi, g in enumerate(groups):
                    terms(g, f"{at}/组{gi + 1}", "线索")

    for i, r in enumerate(danger or []):
        one(r, i, "DANGER")
    for i, r in enumerate(combo or []):
        one(r, i, "COMBO")
    if len(danger or []) + len(combo or []) == 0:
        errs.append("红旗表整体为空（读空＝判据失效，不许当通过）")
    return errs


def assert_red_flag_tables(danger: list | None = None, combo: list | None = None) -> None:
    """载入即拒绝（无降级模式）。写成函数而非裸 if，是为了让镜像端测试能**直接驱动这条抛异常路径**
    ——覆盖它和验证它生效是同一件事，藏在模块顶层的一次性 if 里就只能靠改源码做变异实验。"""
    errs = validate_red_flag_rules(danger, combo)
    if errs:
        raise RuntimeError("红旗规则表非法，拒绝载入（无降级模式）：\n  - " + "\n  - ".join(errs))


assert_red_flag_tables()


def _bp_crisis(text: str) -> bool:
    m = re.search(r"(\d{2,3})\s*[/／]\s*(\d{2,3})", text)
    if not m:
        return False
    sys_, dia = int(m.group(1)), int(m.group(2))
    if (sys_ > BP_THRESHOLDS["plausible_max_systolic"] or dia > BP_THRESHOLDS["plausible_max_diastolic"]
            or sys_ < BP_THRESHOLDS["plausible_min_systolic"] or dia < BP_THRESHOLDS["plausible_min_diastolic"]):  # 脏读拒绝（与 rules.js 值域守卫对齐）
        return False
    return sys_ >= BP_THRESHOLDS["systolic_crisis"] or dia >= BP_THRESHOLDS["diastolic_crisis"]


# 否定修饰：中文临床文本用「无/没有/未/否认…」直接修饰症状词表达阴性。
# 既往按子串命中 ⇒ "无气促" 命中 "气促"，脓毒症红旗假阳性（第二十四轮由产品路径评测实测抓到）。
# 只收「明确阴性表述」：不收 "排除/不支持/不" —— "不能排除心前区闷痛" 若被抑制就是漏报，
# 而本层的失败代价不对称（漏报危险信号远重于多提示），故宁缺毋滥。与 rules.js 逐字同表。
_NEGATION_TOKENS: list[str] = list(NEGATION["tokens"])
_NEG_LOOKBEHIND = 4
# 形似否定实为阳性体征的词，必须先于否定判定放行，否则把「尿闭」当阴性 ⇒ 制造漏报。
# follow 是该词之后不得紧跟的字：否则 "无尿痛" 会先命中 "无尿" 这条阳性例外。
_POSITIVE_TERMS: list[dict[str, Any]] = POSITIVE_TERMS


def _has_positive_occurrence(text: str, kw: str) -> bool:
    """kw 在 text 中是否存在「未被否定」的一次出现（任一阳性出现即算命中，多出现取或）。"""
    k = kw.lower()
    if not k:
        return False
    positive = next((p for p in _POSITIVE_TERMS if p["term"] == k), None)
    start = 0
    while True:
        at = text.find(k, start)
        if at < 0:
            return False
        head = text[max(0, at - _NEG_LOOKBEHIND):at]
        tail = text[at + len(k):at + len(k) + 1]
        # 阳性例外词若被这些字紧跟，说明这次出现不是该体征（"无尿痛" 里的 "无尿"），该次出现作废继续找。
        disqualified = positive is not None and tail in positive["follow"]
        negated = disqualified or any(head.endswith(n) for n in _NEGATION_TOKENS)
        if not negated:
            return True
        start = at + len(k)


def _occurs_unnegated(text: str, kw: str, window: int) -> bool:
    """关键词是否存在「未被否定」的一次出现（范围层专用，语义与 JS 侧 occursUnnegated 逐字对齐）。

    基础词表沿用红旗层的紧邻判定（endswith），范围层追加线索用窗口内任意位置命中：
    中文动词会隔开否定词与关键词（「没做过CT」），只用紧邻挡不住。
    """
    k = str(kw).lower()
    if not k:
        return False
    extra = [str(x).lower() for x in SCOPE_META["negation_tokens_extra"]]
    t = text.lower()
    frm = 0
    while True:
        at = t.find(k, frm)
        if at < 0:
            return False
        head = t[max(0, at - window):at]
        negated = any(head.endswith(str(n).lower()) for n in _NEGATION_TOKENS) or any(n in head for n in extra)
        if not negated:
            return True
        frm = at + len(k)


def validate_scope_rules(list_: list | None = None, meta: dict | None = None) -> list[str]:
    """载入即校验（与 JS 侧 validateScopeRules 同一份规则集）：数据不合法就逐条报出，不留半条规则可用。"""
    rules_ = SCOPE_RULES if list_ is None else list_
    meta_ = SCOPE_META if meta is None else meta
    errs: list[str] = []
    if not isinstance(rules_, list) or not rules_:
        return ["规则表为空（零输入不得当作通过）"]
    win = meta_.get("negation_window_chars")
    if not isinstance(win, int) or win < 1:
        errs.append(f"negation_window_chars 非法：{win!r}")
    if not isinstance(meta_.get("negation_tokens_extra"), list):
        errs.append("negation_tokens_extra 必须是数组")
    seen: set = set()
    for i, r in enumerate(rules_):
        rid = r.get("id") if isinstance(r, dict) else None
        at = f"#{i}({rid})" if isinstance(rid, str) and rid else f"#{i}"
        if not isinstance(rid, str) or not re.fullmatch(r"[a-z][a-z0-9_]{2,}", rid):
            errs.append(f"{at}: id 须为 snake_case 且非空")
        if rid in seen:
            errs.append(f"{at}: id 重复")
        seen.add(rid)
        kw = r.get("keywords")
        if not isinstance(kw, list) or len(kw) < 2:
            errs.append(f"{at}: keywords 须为 ≥2 项的数组")
        else:
            for k in kw:
                if not isinstance(k, str) or len(k.strip()) < 2:
                    errs.append(f"{at}: 关键词「{k}」空或为裸单字（会子串横扫全文）")
        if not str(r.get("title") or "").strip():
            errs.append(f"{at}: title 为空")
        rat = r.get("rationale")
        if not isinstance(rat, str) or len(rat) < 20:
            errs.append(f"{at}: rationale 缺失或过短（临床取舍必须写清为什么不做）")
        if r.get("action") != "out-of-scope":
            errs.append(f"{at}: action 只能是 out-of-scope，实测 {r.get('action')!r}")
        note = r.get("doctor_note")
        if not isinstance(note, str) or not note.strip():
            errs.append(f"{at}: doctor_note 为空（医生看不到该找谁）")
    return errs


def match_scope_rule(text: str):
    """命中即返回该规则（含 rationale/doctor_note），未命中返回 None。规则顺序即优先级。"""
    window = int(SCOPE_META["negation_window_chars"])
    t = str(text or "")
    for r in SCOPE_RULES:
        matched = [k for k in r["keywords"] if _occurs_unnegated(t, k, window)]
        if matched:
            return {"id": r["id"], "title": r["title"], "matched": matched,
                    "rationale": r["rationale"], "doctor_note": r["doctor_note"]}
    return None


def _match_flag_rules(text: str) -> list[dict]:
    hits: list[dict] = []
    for r in DANGER_RULES:
        # 两侧小写归一（对齐 rules.js，d-二聚体不漏报）
        if any(_has_positive_occurrence(text, kw) for kw in r["keywords"]):
            hits.append({"name": r["name"], "severity": r["severity"], "advice": r["advice"]})
    # 组合规则：每个线索组至少命中一词才触发（表达"症状组合"临床逻辑，降低单非特异词误报）
    for r in COMBO_RULES:
        if all(any(_has_positive_occurrence(text, kw) for kw in group) for group in r["all"]):
            hits.append({"name": r["name"], "severity": r["severity"], "advice": r["advice"]})
    if _bp_crisis(text) and not any("高血压急症" in h["name"] for h in hits):
        hits.append({"name": "高血压急症红旗", "severity": "高", "advice": _HYPERTENSION_ADVICE})
    seen, out = set(), []
    for h in hits:
        if h["name"] not in seen:
            seen.add(h["name"])
            out.append(h)
    return out


def scan_flag_details(text: str) -> list[dict]:
    """结构化红旗明细（镜像 rules.js scanFlagDetails）：[{name, severity, advice}]。"""
    t = (text or "").lower()[:2000]
    if not t.strip():
        return []
    return _match_flag_rules(t)


def scan_flags(text: str) -> list[str]:
    """红旗字符串（既有契约，格式不变）。"""
    return [f"严重危险信号：{d['name']}。{d['advice']}" for d in scan_flag_details(text)]
