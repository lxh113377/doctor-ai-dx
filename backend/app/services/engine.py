"""诊断引擎——镜像 frontend/functions/lib/engine.js，两端行为一致。
临床状态抽取 → 证据检索(BM25) → LLM 结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级。
红线：红旗规则结果优先且不可被模型覆盖；非法 evidence_id 直接拒绝。
mode：live（LLM 生成）/ rule-fallback（规则降级，明确标注）。
"""
from .. import mock, rag, rules
from ..config import llm_available
from ..knowledge import KNOWLEDGE_BASE, SYMPTOM_TO_KB
from ..retriever import get_retriever
from . import fhir as fhir_svc
from . import llm as llm_svc

_BY_ID = {k["id"]: k for k in KNOWLEDGE_BASE}
_RETRIEVER = get_retriever()


class UnknownCase(Exception):
    pass


def _case(case_id: str) -> dict:
    c = next((x for x in mock.CASES if x["id"] == case_id), None)
    if not c:
        raise UnknownCase(f"unknown case: {case_id}")
    return c


def get_cases() -> list[dict]:
    return mock.CASES


# ---------- 临床状态抽取（确定性，不依赖 LLM） ----------
SLOT_LEXICON = {
    "疼痛性质": ["压榨", "针刺", "烧灼", "钝痛", "撕裂", "紧缩"],
    "放射部位": ["放射", "向左肩", "向后背", "向下颌", "牵涉"],
    "诱发缓解": ["劳累", "活动", "休息", "体位", "进食", "空腹", "夜间"],
    "伴随症状": ["冷汗", "出汗", "恶心", "呕吐", "气促", "呼吸困难", "心悸", "耳鸣", "咽痛", "咳嗽", "发热", "腹泻", "血尿"],
    "既往史": ["高血压", "糖尿病", "冠心病", "吸烟", "饮酒", "贫血", "手术", "过敏"],
    "起病时间": ["小时", "天", "周", "月", "年", "突发", "反复"],
}
# 线索探针单一源：探针清单即 SYMPTOM_TO_KB 的键，与 JS 端同源（防「命中线索却无证据映射」的词表漂移）
_SYMPTOM_PROBES = list(SYMPTOM_TO_KB.keys())


def _detect_symptoms(text: str) -> list[str]:
    return [p for p in _SYMPTOM_PROBES if p in text]


def _missing_slots(case: dict, answers: list[str]) -> list[str]:
    text = "；".join([case["chief"], *answers])
    return [slot for slot, kws in SLOT_LEXICON.items() if not any(k in text for k in kws)]


def extract_state(case_id: str, history: list[dict] | None = None) -> dict:
    history = history or []
    c = _case(case_id)
    answers = [m.get("content", "") for m in history if m.get("role") == "user"]
    full_text = "；".join([c["chief"], *answers])
    return {
        "case_id": case_id,
        "patient": {"name": c["name"], "age": c["age"], "gender": c["gender"], "chief": c["chief"]},
        "transcript": full_text,
        "symptoms": _detect_symptoms(full_text),
        "red_flags": rules.scan_flags(full_text),
        "red_flag_details": rules.scan_flag_details(full_text),
        "missing_slots": _missing_slots(c, answers),
        "rounds": len(answers),
        "done": len(answers) >= len(c["answers"]),
    }


# ---------- 问诊推进 ----------
def next_intake_question(case_id: str, history: list[dict] | None = None) -> dict:
    history = history or []
    c = _case(case_id)
    answered = [m for m in history if m.get("role") == "user"]
    idx = len(answered)
    state = extract_state(case_id, history)
    if idx < len(c["answers"]):
        item = c["answers"][idx]
        return {"reply": item["q"], "question": item["q"], "source": "intake-question",
                "chips": item["chips"], "done": False, "state": state, "mode": "rule"}
    live = _llm_followup(history, c)
    if live and live.get("question") and idx < len(c["answers"]) + 3:
        return {"reply": live["question"], "question": live["question"], "source": "intake-question-llm",
                "chips": live.get("chips", []), "done": False, "state": state, "mode": "live"}
    return {"reply": mock.INTAKE_DONE_REPLY, "source": "intake-done", "chips": [], "done": True,
            "state": state, "mode": "rule"}


def _llm_followup(history: list[dict], c: dict) -> dict | None:
    if not llm_available():
        return None
    transcript = "\n".join(
        (f"医生: {m.get('content','')}" if m.get("role") == "user" else f"助手: {m.get('content','')}")
        for m in history[-8:]
    )
    ctx = f"患者：{c['name']} {c['age']}岁 {c['gender']}，主诉：{c['chief']}\n已有问诊记录：\n{transcript}"
    try:
        data = llm_svc.chat_json([
            {"role": "system", "content": llm_svc.SYSTEM_BASE},
            {"role": "user", "content": f"{ctx}\n\n若还需补充追问，输出 JSON {{\"question\":\"...\",\"chips\":[\"...\"],\"done\":false}}；信息已足够则输出 {{\"done\":true}}。中文。"},
        ])
        if data.get("done") or not data.get("question"):
            return None
        return data
    except Exception:
        return None


# ---------- 辅助诊断 ----------
def build_diagnosis(case_id: str, history: list[dict] | None = None) -> dict:
    state = extract_state(case_id, history)
    evidence = _RETRIEVER.search(state["transcript"], 5)
    evidence_ids = [e["id"] for e in evidence]

    live = _llm_diagnosis(state, evidence)
    if live:
        out, mode, reason = live, "live", ""
    else:
        out, mode = _rule_diagnosis(state, evidence), "rule-fallback"
        reason = "LLM 超时/输出非法，已切换规则引擎" if llm_available() else "未配置 LLM Key，使用规则引擎"

    out = _validate_diagnosis(out, evidence_ids)
    out["flags"] = state["red_flags"]          # 红旗兜底：不可被模型覆盖
    out["flag_details"] = state["red_flag_details"]
    out["mode"] = mode
    out["fallback_reason"] = reason
    out["trace"] = {"evidence_ids": evidence_ids, "rounds": state["rounds"], "symptoms": state["symptoms"]}
    out["state"] = state
    out["fhir"] = fhir_svc.to_fhir_bundle(out)
    return out


def _validate_diagnosis(dx: dict, allowed_ids: list[str]) -> dict:
    def ok(eid):
        return isinstance(eid, str) and rag.has_evidence(eid)

    def fix(arr):
        return [x for x in (arr or []) if ok(x)]

    primary = []
    for p in (dx.get("primary") or [])[:4]:
        ev = fix(p.get("evidence_ids"))
        if not ev:
            ev = allowed_ids[:2]
        primary.append({
            "name": str(p.get("name") or "未命名诊断")[:60],
            "prob": p.get("prob") if p.get("prob") in ("高优先级", "需鉴别", "低可能") else "需鉴别",
            "strength": p.get("strength") if p.get("strength") in ("high", "mid", "low") else "mid",
            "reasons": [str(r)[:80] for r in (p.get("reasons") or [])[:4]],
            "evidence_ids": ev,
            "refs": [rag.kb_title(i) for i in ev],
        })
    dx["primary"] = primary
    if not dx["primary"]:
        dx["primary"] = [{"name": "信息不足，建议补充问诊", "prob": "需鉴别", "strength": "low",
                          "reasons": ["现有线索不足以形成鉴别诊断"], "evidence_ids": [], "refs": []}]

    diff = [{"name": str(d.get("name") or "")[:60], "note": str(d.get("note") or "")[:120],
             "evidence_ids": fix(d.get("evidence_ids"))} for d in (dx.get("differential") or [])[:6]]
    dx["differential"] = diff
    if len(diff) < 2 and len(allowed_ids) >= 2:
        used = {i for d in diff for i in d["evidence_ids"]}
        for eid in allowed_ids:
            if len(diff) >= 2:
                break
            if eid in used or not rag.has_evidence(eid):
                continue
            diff.append({"name": rag.kb_condition(eid) or rag.kb_title(eid),
                         "note": rag.kb_text(eid)[:60], "evidence_ids": [eid]})

    if len(dx["primary"]) < 2:
        first = dx["primary"][0]
        d0 = next((d for d in diff if d["name"] and d["name"] != first["name"]), None)
        if d0:
            dx["primary"].append({"name": f"{d0['name']}（需鉴别）", "prob": "需鉴别", "strength": "mid",
                                  "reasons": [d0["note"] or "与首要诊断共存线索，需进一步检查区分"],
                                  "evidence_ids": d0["evidence_ids"],
                                  "refs": [rag.kb_title(i) for i in d0["evidence_ids"]]})
        elif len(allowed_ids) >= 2:
            used = {i for p in dx["primary"] for i in p["evidence_ids"]}
            extra = next((i for i in allowed_ids if i not in used and rag.has_evidence(i)), None)
            if extra:
                dx["primary"].append({"name": f"{rag.kb_condition(extra)}（需鉴别）", "prob": "需鉴别", "strength": "mid",
                                      "reasons": ["与首要诊断共存线索，需进一步检查区分"],
                                      "evidence_ids": [extra], "refs": [rag.kb_title(extra)]})

    dx["evidence"] = [e for e in (dx.get("evidence") or []) if ok(e.get("id"))]
    return dx


def _rule_diagnosis(state: dict, evidence: list[dict]) -> dict:
    cond_ids = [e["id"] for e in evidence]
    primary = [{
        "name": rag.kb_condition(i), "prob": "高优先级" if j == 0 else "需鉴别",
        "strength": "high" if j == 0 else "mid",
        "reasons": [state["transcript"][:40] + "…"], "evidence_ids": [i], "refs": [i],
    } for j, i in enumerate(cond_ids[:3]) if rag.has_evidence(i)]
    seen = set(cond_ids)
    symptom_ev = [e for e in rag.evidence_for_symptoms(state["symptoms"]) if e["id"] not in seen][:3]
    differential = [{"name": e["title"], "note": e["text"][:60], "evidence_ids": [e["id"]]} for e in symptom_ev]
    return {
        "flags": state["red_flags"],
        "flag_details": state["red_flag_details"],
        "primary": primary or [{"name": "待医生结合查体进一步鉴别", "prob": "需鉴别", "strength": "mid",
                                "reasons": [state["transcript"][:60]], "evidence_ids": [], "refs": []}],
        "differential": differential,
        "faq": [{"q": "为什么是规则降级模式？", "a": "本次未使用大模型生成（无 Key 或模型超时/输出非法），结论由红旗规则与知识库映射产生，已明确标注，请医生复核。"}],
        "evidence": evidence + symptom_ev,
    }


def _llm_diagnosis(state: dict, evidence: list[dict]) -> dict | None:
    if not llm_available():
        return None
    ev_block = "\n".join(f"- [{e['id']}] {e['title']}（{e['source']} {e['year']}）：{e['text']}" for e in evidence)
    flag_block = "已检出红旗：" + "；".join(state["red_flags"]) if state["red_flags"] else "未检出红旗"
    pt = state["patient"]
    prompt = f"""患者信息：{pt['name']} {pt['age']}岁 {pt['gender']}
临床状态：{state['transcript']}
{flag_block}
可引用证据（只能引用下列 id）：
{ev_block}

请输出严格 JSON（不要多余文字）：
{{"primary":[{{"name":"...","prob":"高优先级|需鉴别|低可能","strength":"high|mid|low","reasons":["..."],"evidence_ids":["kb-xxx"]}}],"differential":[{{"name":"...","note":"...","evidence_ids":["kb-xxx"]}}],"faq":[{{"q":"...","a":"..."}}]}}
约束：primary 至少 2 项（首项为最可能诊断，次项为需鉴别诊断）；differential 至少 2 项；每项 evidence_ids 只能从上述证据 id 中选取。"""
    try:
        data = llm_svc.chat_json([
            {"role": "system", "content": llm_svc.SYSTEM_BASE},
            {"role": "user", "content": prompt},
        ])
        if not isinstance(data.get("primary"), list) or not data["primary"]:
            return None
        data["evidence"] = evidence
        data["faq"] = data.get("faq", [])[:3] if isinstance(data.get("faq"), list) else []
        return data
    except Exception:
        return None


# ---------- 检查建议 ----------
def _reuse_or_build(state: dict, history, provided_dx: dict | None) -> dict:
    """复用前端已生成的诊断结果（省一次 LLM 串行调用）；红旗一律以后端规则重算为准。"""
    if provided_dx and isinstance(provided_dx.get("primary"), list) and provided_dx["primary"]:
        dx = dict(provided_dx)
        dx["flags"] = state["red_flags"]
        dx["flag_details"] = state["red_flag_details"]
        ev = dx.get("evidence")
        valid = [e for e in ev if isinstance(e, dict) and isinstance(e.get("id"), str) and rag.has_evidence(e["id"])] if isinstance(ev, list) else []
        dx["evidence"] = valid if valid else _RETRIEVER.search(state["transcript"], 5)
        if not dx.get("trace"):
            dx["trace"] = {"evidence_ids": [e["id"] for e in dx["evidence"]],
                           "rounds": state["rounds"], "symptoms": state["symptoms"]}
        return dx
    return build_diagnosis(state["case_id"], history)


def build_workup(case_id: str, history: list[dict] | None = None, provided_dx: dict | None = None) -> dict:
    state = extract_state(case_id, history)
    dx = _reuse_or_build(state, history, provided_dx)
    first_name = dx["primary"][0].get("name", "") if dx.get("primary") else ""
    evidence = _RETRIEVER.search(state["transcript"] + " " + first_name, 5)
    live = _llm_workup(state, dx, evidence)
    if live:
        out, mode, reason = live, "live", ""
    else:
        out, mode = _rule_workup(state, dx), "rule-fallback"
        reason = "LLM 超时/输出非法，已切换规则引擎" if llm_available() else "未配置 LLM Key，使用规则引擎"
    out = _validate_workup(out)
    out["mode"] = mode
    out["fallback_reason"] = reason
    out["evidence_ids"] = [e["id"] for e in evidence]
    return out


def _validate_workup(w: dict) -> dict:
    for key in ("essential", "suggested", "optional"):
        w[key] = [{"item": str(it.get("item") or "")[:80], "why": str(it.get("why") or "")[:100],
                   "evidence_ids": [i for i in (it.get("evidence_ids") or []) if rag.has_evidence(i)]}
                  for it in (w.get(key) or [])[:6]]
        if not w[key]:
            w[key] = [{"item": "请医生结合完整临床资料决定", "why": "当前信息不足以给出该组明确建议", "evidence_ids": []}]
    return w


def _rule_workup(state: dict, dx: dict) -> dict:
    ev_list = dx.get("evidence") if isinstance(dx.get("evidence"), list) else []
    top = ev_list[0] if ev_list and isinstance(ev_list[0], dict) and isinstance(ev_list[0].get("id"), str) and rag.has_evidence(ev_list[0]["id"]) else None
    ev = [top["id"]] if top else []
    def base(item, why):
        return {"item": item, "why": why, "evidence_ids": ev}
    if state["red_flags"]:
        return {"essential": [base("即刻心电图 + 心肌损伤标志物", "红旗提示急危重症，优先排除"),
                              base("血氧/血压/意识监测", "评估血流动力学稳定性")],
                "suggested": [base("血常规/肾功能/电解质", "基础状态评估")],
                "optional": [base("上级医院影像（CTA/超声）", "由胸痛中心/上级完成")]}
    sym = "、".join(state["symptoms"]) or state["patient"]["chief"]
    return {"essential": [base("血常规 + CRP", "感染/贫血初筛"), base("针对主诉的定向检查", f"围绕：{sym}")],
            "suggested": [base("病原学/生化按需", "结合体征选择")],
            "optional": [base("专科评估或复查", "症状迁延时补充")]}


def _llm_workup(state: dict, dx: dict, evidence: list[dict]) -> dict | None:
    if not llm_available():
        return None
    ev_block = "\n".join(f"- [{e['id']}] {e['title']}" for e in evidence)
    names = "；".join(p["name"] for p in dx["primary"])
    prompt = f"临床状态：{state['transcript']}\n疑似诊断：{names}\n证据：\n{ev_block}\n\n输出严格 JSON：{{\"essential\":[{{\"item\":\"...\",\"why\":\"...\",\"evidence_ids\":[\"kb-xxx\"]}}],\"suggested\":[...],\"optional\":[...]}}"
    try:
        d = llm_svc.chat_json([
            {"role": "system", "content": llm_svc.SYSTEM_BASE},
            {"role": "user", "content": prompt},
        ])
        if not (d.get("essential") or d.get("suggested") or d.get("optional")):
            return None
        return d
    except Exception:
        return None


# ---------- SOAP 病历报告 ----------
def build_report(case_id: str, history: list[dict] | None = None, provided_dx: dict | None = None) -> dict:
    state = extract_state(case_id, history)
    dx = _reuse_or_build(state, history, provided_dx)
    c = _case(case_id)
    vitals = "，".join(f"{v['key']} {v['value']}" for v in c["vitals"])
    live = _llm_report(state, dx, vitals)
    if live:
        out, mode, reason = live, "live", ""
    else:
        names = "；".join(p["name"] for p in dx["primary"])
        out = {
            "soap": {
                "subjective": f"{state['patient']['name']}，{state['patient']['age']}岁 {state['patient']['gender']}。{state['transcript']}",
                "objective": f"{vitals}；余查体待完善。",
                "assessment": names + ("。红旗：" + "；".join(dx["flags"]) if dx["flags"] else ""),
                "plan": "按急危重症路径处置并尽快转诊；完善心电图/标志物等必查项。" if dx["flags"]
                        else "按鉴别诊断方向完善检查；对症处理并告知复诊指征。",
            },
            "conclusion": dx["primary"][0]["name"] if dx["primary"] else "待医生终审",
            "disclaimer": "本报告由 AI 辅助生成，仅作接诊参考。诊断与处置决策必须由具有执业资质的医生结合全部检查结果最终确定。",
        }
        mode = "rule-fallback"
        reason = "LLM 超时/输出非法，已切换规则模板" if llm_available() else "未配置 LLM Key，使用规则模板"
    out["mode"] = mode
    out["fallback_reason"] = reason
    out["evidence_ids"] = dx.get("trace", {}).get("evidence_ids", [])
    return out


def _llm_report(state: dict, dx: dict, vitals: str) -> dict | None:
    if not llm_available():
        return None
    names = "；".join(p["name"] for p in dx["primary"])
    flags = "；".join(dx["flags"]) or "无"
    prompt = f"临床状态：{state['transcript']}\n生命体征：{vitals}\n疑似诊断：{names}\n红旗：{flags}\n\n输出严格 JSON：{{\"soap\":{{\"subjective\":\"...\",\"objective\":\"...\",\"assessment\":\"...\",\"plan\":\"...\"}},\"conclusion\":\"...\",\"disclaimer\":\"...\"}}"
    try:
        d = llm_svc.chat_json([
            {"role": "system", "content": llm_svc.SYSTEM_BASE},
            {"role": "user", "content": prompt},
        ])
        if not d.get("soap") or not d["soap"].get("subjective"):
            return None
        if not d.get("disclaimer"):
            d["disclaimer"] = "本报告由 AI 辅助生成，仅作接诊参考，最终诊断由执业医生确定。"
        return d
    except Exception:
        return None
