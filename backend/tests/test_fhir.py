"""FHIR-light 导出的后端侧门禁。镜像 frontend/tests/fhir_guard.mjs 的判据子集。
覆盖：API 透出、Bundle 结构、零时钟确定性、ICD 不编造、红线文案、双端术语集清单一致。
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.services import engine, fhir  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


def resources(bundle):
    return [e["resource"] for e in bundle["entry"]]


# 逐例回表：与 JS 侧 fhir_guard 共用同一份评测集（31 例，零密钥 ⇒ 确定性 rule 路径）。
SUITE = json.loads((Path(__file__).resolve().parents[2] / "frontend" / "tests"
                    / "fixtures" / "eval_cases.json").read_text(encoding="utf-8"))["cases"]
ALL_DX = [engine.build_diagnosis(c.get("case_id") or "c1",
                                 [{"role": "user", "content": a} for a in c["answers"]]) for c in SUITE]


def cond_ver_ok(dx, res):
    """R4 condition-ver-status 分档断言：首要＝provisional／鉴别＝differential／弃权＝unconfirmed。"""
    for c in res:
        if c["resourceType"] != "Condition":
            continue
        got = c["verificationStatus"]["coding"][0]["code"]
        exp = "unconfirmed" if dx.get("abstain") else ("provisional" if c["id"].startswith("cond-primary") else "differential")
        if got != exp:
            return False
    return True


CLOCK_RE = re.compile(r'"(timestamp|issued|effective|metaLastUpdated)"\s*:')

client = TestClient(app)
r = client.post("/api/dx/c1", json={"case_id": "c1", "history": [{"role": "user", "content": "压榨样胸痛伴冷汗，放射至左肩"}]})
check("POST /api/dx/c1 返回 200", r.status_code == 200, str(r.status_code) + " " + r.text[:160])
api_bundle = r.json()["data"].get("fhir") or {}
check("API 响应透出 fhir Bundle（Pydantic 未吞字段）", api_bundle.get("resourceType") == "Bundle",
      str(api_bundle)[:120])

dx = engine.build_diagnosis("c1", [{"role": "user", "content": "压榨样胸痛伴冷汗，放射至左肩"}])
bundle = dx["fhir"]
res = resources(bundle)

check("Bundle.type = collection（已核验 bundle-type 码集）", bundle["type"] == "collection")
check("五类资源齐备", {"Patient", "Encounter", "Condition", "Observation", "DiagnosticReport"}
      <= {x["resourceType"] for x in res})
check("Condition 验证状态按 R4 值集分档（首要＝provisional／鉴别＝differential／弃权＝unconfirmed）——逐例回表",
      all(cond_ver_ok(dx2, resources(dx2["fhir"])) for dx2 in ALL_DX),
      "｜".join(f"{d['primary'][0]['name'][:8]}:{sorted({c['verificationStatus']['coding'][0]['code'] for c in resources(d['fhir']) if c['resourceType'] == 'Condition'})}" for d in ALL_DX[:2]))
BAD_VERDICT = [f"{c['id']}={c['verificationStatus']['coding'][0]['code']}"
               for d in ALL_DX for c in resources(d["fhir"])
               if c["resourceType"] == "Condition" and c["verificationStatus"]["coding"][0]["code"] in ("confirmed", "refuted")]
check("红线：任何一例 Condition 都不得被写成 confirmed/refuted（AI 不声称确诊或已排除）",
      not BAD_VERDICT, ",".join(BAD_VERDICT[:4]))
ABSTAIN_DX = [d for d in ALL_DX if d.get("abstain")]
check(f"弃权例（实测 {len(ABSTAIN_DX)} 例）的 Condition 一律 unconfirmed（R4 无 unknown；分母 0 不得记通过）",
      len(ABSTAIN_DX) > 0 and all(
          c["verificationStatus"]["coding"][0]["code"] == "unconfirmed"
          for d in ABSTAIN_DX for c in resources(d["fhir"]) if c["resourceType"] == "Condition"),
      ",".join(str(d.get("state", {}).get("case_id")) for d in ABSTAIN_DX) or "弃权分母为 0＝没测到，不许记绿")
CODES_SEEN = {c["verificationStatus"]["coding"][0]["code"]
              for d in ALL_DX for c in resources(d["fhir"]) if c["resourceType"] == "Condition"}
check("分档确实在产出（出现过的码 ≥2 且含 provisional/differential，只有一种＝等于没分）",
      len(CODES_SEEN) >= 2 and {"provisional", "differential"} <= CODES_SEEN, ",".join(sorted(CODES_SEEN)))

check("红旗命中被独立承载（规则层不被模型覆盖）", bool(dx["flags"]) and any(
    x["id"] == "flag-summary" and x["component"] for x in res))

ids = {f"{x['resourceType']}/{x['id']}" for x in res}
dangling = [v for v in re.findall(r'"reference"\s*:\s*"([^"]+)"', json.dumps(bundle)) if v not in ids]
check("无悬挂 reference", not dangling, ", ".join(dangling[:3]))

check("导出零时钟字段（双端可对账）", not CLOCK_RE.search(json.dumps(bundle, ensure_ascii=False)))
check("同一输入两次导出逐字节相同", json.dumps(engine.build_diagnosis("c1", [{"role": "user", "content": "压榨样胸痛伴冷汗，放射至左肩"}])["fhir"], sort_keys=True) == json.dumps(bundle, sort_keys=True))

report = next(x for x in res if x["resourceType"] == "DiagnosticReport")
check("红线：结论含「医生终审」", "医生终审" in report["conclusion"])
check("无 LLM Key 时报告状态如实标 partial", report["status"] == "partial")

dx_live = dict(dx, mode="live", fallback_reason="")
check("live 链路报告状态为 final", fhir.to_fhir_bundle(dx_live)["entry"][-1]["resource"]["status"] == "final")

from app.knowledge import KNOWLEDGE_BASE  # noqa: E402

ICD_BY_KB = {k["id"]: {c.strip() for c in str(k["icd"]).split(";") if c.strip()}
             for k in KNOWLEDGE_BASE if isinstance(k.get("icd"), str)}
bad_icd = []
for x in (r_ for r_ in res if r_["resourceType"] == "Condition"):
    src_ids = [e["detail"][0]["reference"].replace("Observation/citation-", "") for e in x.get("evidence", [])]
    for cod in x["code"].get("coding", []):
        if cod["code"] not in set().union(*[ICD_BY_KB.get(s, set()) for s in src_ids] or [set()]):
            bad_icd.append(f"{x['id']}#{cod['code']}")
check("红线：每条 ICD 编码都有知识库出处（null 映射不编造标准码）", not bad_icd, ", ".join(bad_icd[:3]))
null_only = [x for x in (r_ for r_ in res if r_["resourceType"] == "Condition")
             if x.get("evidence") and all(e["detail"][0]["reference"].replace("Observation/citation-", "")
                                          not in ICD_BY_KB for e in x["evidence"])]
check("仅引用 icd=null 条目的诊断只出 text、不出 coding",
      bool(null_only) and all("coding" not in x["code"] for x in null_only),
      f"null_only={len(null_only)}")

JS_FHIR = Path(__file__).resolve().parents[2] / "frontend" / "functions" / "lib" / "fhir.js"
if JS_FHIR.exists():  # 源码树级检查：容器镜像内只有 /srv/backend，此时该检查无语义（显式 SKIP，不计通过也不计失败）
    missing = [u for u in fhir.CS.values() if u not in JS_FHIR.read_text(encoding="utf-8")]
    check("双端 CodeSystem URI 清单一致", not missing, " | ".join(missing))
else:
    print("  SKIP 双端 CodeSystem URI 清单一致（非源码树环境：", JS_FHIR.parent, "）")

empty = fhir.to_fhir_bundle({})
check("空输入兜底仍产出合法 Bundle", empty["resourceType"] == "Bundle" and len(empty["entry"]) >= 4)
check("空输入时 patient_ref 指向存在的 Patient",
      any(x["resourceType"] == "Patient" for x in resources(empty)))

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
