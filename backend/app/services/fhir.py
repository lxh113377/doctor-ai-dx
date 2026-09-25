"""FHIR R4（light 子集）导出层 —— frontend/functions/lib/fhir.js 的 Python 镜像。

设计约束与 JS 端逐条对应（可实测）：
1. 纯函数：零网络、零随机、零时钟 → 双端输出可被 contract_parity 逐字段对账；
2. 只读派生视图：不参与决策链，红旗规则层 / 引用白名单 / 医生终审文案三条红线零触碰；
3. 术语绑定只使用 HL7 已发布工件中的 code，未核验编码一律只出 text、不编造 coding；
4. 自定义扩展统一走本仓命名空间，不声称符合官方 Profile。
"""
from .. import rag

CS = {
    "gender": "http://hl7.org/fhir/administrative-gender",
    "encounterStatus": "http://hl7.org/fhir/encounter-status",
    "actCode": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
    "clinical": "http://terminology.hl7.org/CodeSystem/condition-clinical",
    "verStatus": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
    "category": "http://terminology.hl7.org/CodeSystem/condition-category",
    "obsStatus": "http://hl7.org/fhir/observation-status",
    "reportStatus": "http://hl7.org/fhir/diagnostic-report-status",
    "bundleType": "http://hl7.org/fhir/bundle-type",
    "icd10": "http://hl7.org/fhir/sid/icd-10",
    "caseSource": "urn:doctor-ai-dx:case-id",
    "extBase": "https://github.com/lxh113377/doctor-ai-dx#fhir-light/",
}

GENDER_BY_TEXT = {"男": "male", "女": "female", "male": "male", "female": "female"}


def _s(value, limit):
    """JS String(x ?? "").slice(0, n) 的等价实现。"""
    return ("" if value is None else str(value))[:limit]


def _text_coding(text, code=None, system=None):
    out = {"text": _s(text, 200)}
    if code:
        out["coding"] = [{"system": system, "code": code, "display": _s(text, 200)}]
    return out


def _icd_codes(icd):
    if not isinstance(icd, str):
        return []
    return [c for c in (s.strip() for s in icd.split(";")) if c]


def _patient_entry(dx):
    state = dx.get("state") or {}
    p = state.get("patient") or {}
    case_id = state.get("case_id") or "unknown"
    res = {
        "resourceType": "Patient",
        "id": f"pat-{case_id}",
        "identifier": [{"system": CS["caseSource"], "value": _s(p.get("case_id") or case_id, 200)}],
        "extension": [
            {"url": f"{CS['extBase']}syntheticCase", "valueBoolean": True},
            {"url": f"{CS['extBase']}chiefComplaint",
             "valueString": _s(p.get("chief") or state.get("transcript") or "", 200)},
        ],
    }
    if p.get("name"):
        res["name"] = [{"text": _s(p["name"], 60)}]
    res["gender"] = GENDER_BY_TEXT.get(str(p.get("gender") or ""), "unknown")
    return res


def _encounter_entry(dx, patient_ref):
    flags = dx.get("flags") or []
    case_id = (dx.get("state") or {}).get("case_id") or "unknown"
    return {
        "resourceType": "Encounter",
        "id": f"enc-{case_id}",
        "status": "finished",
        "class": {"system": CS["actCode"], "code": "AMB", "display": "ambulatory"},
        "subject": patient_ref,
        "type": [_text_coding("基层门诊首诊")],
        "reasonCode": [_text_coding(f"红旗提示：{'、'.join(flags[:4])}" if flags else "常见病多发病首诊鉴别")],
        "reasonReference": [{"reference": "Observation/flag-summary"}] if flags else [],
    }


def _flag_observation(dx, patient_ref):
    details = dx.get("flag_details") or []
    flags = dx.get("flags") or []
    return {
        "resourceType": "Observation",
        "id": "flag-summary",
        "status": "final",
        "category": [{"coding": [{"system": CS["category"], "code": "encounter-diagnosis"}]}],
        "code": _text_coding("危险信号（红旗规则层，独立于大模型）", "red-flag", f"{CS['extBase']}code"),
        "subject": patient_ref,
        "valueCodeableConcept": _text_coding("；".join(flags[:6]) if flags else "未命中红旗"),
        "component": [
            {"code": _text_coding("红旗条目"),
             "valueString": _s(f"{d.get('name')}｜严重度 {d.get('severity')}｜{d.get('advice')}", 400)}
            for d in details[:8]
        ],
        "reference": [{"reference": "DiagnosticReport/dx-summary"}] if details else [],
    }


def _symptom_observations(dx, patient_ref):
    symptoms = (dx.get("state") or {}).get("symptoms") or []
    return [
        {"resourceType": "Observation", "id": f"symptom-{i + 1}", "status": "final",
         "code": _text_coding("症状/体征线索"), "subject": patient_ref, "valueString": _s(sym, 120)}
        for i, sym in enumerate(symptoms[:12])
    ]


def _condition_resources(dx):
    case_id = (dx.get("state") or {}).get("case_id") or "unknown"
    patient_ref = {"reference": f"Patient/pat-{case_id}"}
    base = {
        "resourceType": "Condition",
        "subject": patient_ref,
        "clinicalStatus": {"coding": [{"system": CS["clinical"], "code": "active"}]},
    }
    out = []
    for i, p in enumerate((dx.get("primary") or [])[:4]):
        codes = list(dict.fromkeys(
            c for eid in (p.get("evidence_ids") or []) for c in _icd_codes(rag.kb_icd(eid))))
        code = {"text": _s(p.get("name"), 60)}
        if codes:
            code["coding"] = [{"system": CS["icd10"], "code": c} for c in codes]
        out.append({**base, "id": f"cond-primary-{i + 1}",
                    "verificationStatus": {"coding": [{"system": CS["verStatus"], "code": "unconfirmed"}]},
                    "category": [{"coding": [{"system": CS["category"], "code": "encounter-diagnosis"}]}],
                    "code": code,
                    "note": [{"text": _s(f"优先级 {p.get('prob')}｜支持理由：{'；'.join((p.get('reasons') or [])[:2])}", 300)}],
                    "evidence": [{"detail": [{"reference": f"Observation/citation-{eid}"}]}
                                 for eid in (p.get("evidence_ids") or [])]})
    for i, d in enumerate((dx.get("differential") or [])[:6]):
        codes = list(dict.fromkeys(
            c for eid in (d.get("evidence_ids") or []) for c in _icd_codes(rag.kb_icd(eid))))
        code = {"text": _s(d.get("name"), 60)}
        if codes:
            code["coding"] = [{"system": CS["icd10"], "code": c} for c in codes]
        out.append({**base, "id": f"cond-differential-{i + 1}",
                    "verificationStatus": {"coding": [{"system": CS["verStatus"], "code": "unconfirmed"}]},
                    "category": [{"coding": [{"system": CS["category"], "code": "problem-list-item"}]}],
                    "code": code,
                    "note": [{"text": _s(d.get("note"), 300)}] if d.get("note") else [],
                    "evidence": [{"detail": [{"reference": f"Observation/citation-{eid}"}]}
                                 for eid in (d.get("evidence_ids") or [])]})
    return out


def _citation_observations(dx, patient_ref):
    seen, out = set(), []
    for e in dx.get("evidence") or []:
        eid = e.get("id")
        if eid in seen:
            continue
        seen.add(eid)
        year = e.get("year")
        source_year = f"{e.get('source')}{f'，{year}' if year else ''}"
        out.append({
            "resourceType": "Observation", "id": f"citation-{eid}", "status": "final",
            "code": _text_coding("指南/共识证据引用", "citation", f"{CS['extBase']}code"),
            "subject": patient_ref,
            "valueString": _s(f"{e.get('title')}（{source_year}）", 300),
            "method": _text_coding(e.get("section") or e.get("scope") or "检索命中片段"),
            "data": [{"text": _s(e.get("text"), 500)}],
        })
    return out


def _diagnostic_report(dx, patient_ref, result_refs):
    fallback = dx.get("mode") != "live"
    flags = dx.get("flags") or []
    parts = ["AI 辅助参考 · 医生终审：本资源为决策支持输出，不构成诊断结论，编码与分期由执业医生核定。"]
    if flags:
        parts.append(f"红旗规则层命中 {len(flags)} 项，须按建议优先处置/转诊。")
    if fallback:
        parts.append(f"本次为降级链路（{dx.get('fallback_reason') or 'rule-fallback'}），结果置信度低于 live。")
    present_form = [{"url": _s(e.get("url"), 500), "title": _s(e.get("title"), 200)}
                    for e in (dx.get("evidence") or [])
                    if isinstance(e.get("url"), str) and e["url"].startswith("http")][:10]
    report = {
        "resourceType": "DiagnosticReport", "id": "dx-summary",
        "status": "partial" if fallback else "final",
        "code": _text_coding("基层常见病多发病 AI 辅助鉴别诊断（FHIR-light）"),
        "subject": patient_ref,
        "resultsInterpreter": [{"display": "Doctor-AI-DX 辅助诊断链路"}],
        "conclusion": _s(" ".join(parts), 900),
        "result": result_refs,
        "extension": [
            {"url": f"{CS['extBase']}pipelineMode", "valueString": _s(dx.get("mode"), 60)},
            {"url": f"{CS['extBase']}redFlags", "valueString": _s("；".join(flags) or "none", 400)},
        ],
    }
    if present_form:
        report["presentForm"] = present_form
    return report


def to_fhir_bundle(dx):
    src = dx or {}
    src.setdefault("state", {"case_id": "unknown", "patient": {}, "symptoms": []})
    for key, default in (("primary", []), ("differential", []), ("evidence", []),
                         ("flags", []), ("flag_details", []), ("mode", "rule-fallback"),
                         ("fallback_reason", "")):
        src.setdefault(key, default)
    patient = _patient_entry(src)
    patient_ref = {"reference": f"Patient/{patient['id']}"}
    citations = _citation_observations(src, patient_ref)
    symptom_obs = _symptom_observations(src, patient_ref)
    flag_obs = _flag_observation(src, patient_ref)
    conditions = _condition_resources(src)
    result_refs = [{"reference": f"Observation/{r['id']}"} for r in [flag_obs, *symptom_obs, *citations]]
    report = _diagnostic_report(src, patient_ref, result_refs)
    case_id = (src.get("state") or {}).get("case_id") or "unknown"

    entries = [{"fullUrl": f"urn:doctor-ai-dx:{patient['id']}", "resource": patient},
               {"fullUrl": f"urn:doctor-ai-dx:enc-{case_id}", "resource": _encounter_entry(src, patient_ref)}]
    entries += [{"fullUrl": f"urn:doctor-ai-dx:{r['id']}", "resource": r} for r in conditions]
    entries += [{"fullUrl": f"urn:doctor-ai-dx:{r['id']}", "resource": r} for r in symptom_obs]
    entries.append({"fullUrl": "urn:doctor-ai-dx:flag-summary", "resource": flag_obs})
    entries += [{"fullUrl": f"urn:doctor-ai-dx:{r['id']}", "resource": r} for r in citations]
    entries.append({"fullUrl": "urn:doctor-ai-dx:dx-summary", "resource": report})

    return {
        "resourceType": "Bundle",
        "type": "collection",
        "identifier": {"system": CS["caseSource"], "value": f"bundle-{case_id}"},
        "entry": entries,
    }
