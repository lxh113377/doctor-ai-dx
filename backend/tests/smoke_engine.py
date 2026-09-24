"""后端引擎冒烟测试（无 Key → rule-fallback），断言与 frontend smoke_engine.mjs 对齐。
用法：cd backend && python -m tests.smoke_engine
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.pop("DEEPSEEK_API_KEY", None)  # 强制无 Key 降级

from app.services import engine  # noqa: E402
from app import rag  # noqa: E402
from app.rag import has_evidence  # noqa: E402
from app.retriever import get_retriever  # noqa: E402

HIST_C1 = [{"role": "user", "content": c} for c in
           ["压榨样/紧缩感", "向左肩臂放射", "活动/劳累时加重", "出冷汗", "高血压，吸烟"]]
HIST_C2 = [{"role": "user", "content": c} for c in
           ["最高超过 39℃", "黄脓痰", "无", "明显咽痛", "接触过流感/新冠患者"]]

passed = failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name)


print("== retriever compatibility ==")
retriever = get_retriever()
probe_query = "压榨样胸痛向左肩放射出冷汗"
check("默认检索器为 bm25", retriever.name == "bm25")
check("适配器与原 BM25 输出一致", retriever.search(probe_query, 5) == rag.search(probe_query, 5))

print("== extract_state ==")
s1 = engine.extract_state("c1", HIST_C1)
check("c1 红旗命中 ACS", s1["red_flags"] and "ACS" in s1["red_flags"][0])
check("c1 done 置位", s1["done"] is True)

print("== build_diagnosis (rule-fallback) ==")
dx1 = engine.build_diagnosis("c1", HIST_C1)
check("mode=rule-fallback", dx1["mode"] == "rule-fallback")
check("fallback_reason 非空", bool(dx1["fallback_reason"]))
check("flags 含红旗", len(dx1["flags"]) > 0)
check("AC-OBS-04 疑似诊断>=2", len(dx1["primary"]) >= 2)
check("AC-OBS-04 鉴别诊断>=2", len(dx1["differential"]) >= 2)
check("AC-OBS-04 每个primary有引用", all(p.get("refs") for p in dx1["primary"]))
check("evidence_id 全部有效", all(has_evidence(e["id"]) for e in dx1["evidence"]))
check("trace.evidence_ids 有效", all(has_evidence(i) for i in dx1["trace"]["evidence_ids"]))

dx2 = engine.build_diagnosis("c2", HIST_C2)
check("c2 无红旗", len(dx2["flags"]) == 0)
check("c1/c2 primary 不同", dx1["primary"][0]["name"] != dx2["primary"][0]["name"])

print("== build_workup / build_report ==")
w1 = engine.build_workup("c1", HIST_C1)
check("workup mode 标注", bool(w1.get("mode")))
check("workup 三组非空", w1["essential"] and w1["suggested"] and w1["optional"])
r1 = engine.build_report("c1", HIST_C1)
check("report SOAP 四段", all(r1["soap"].get(k) for k in ("subjective", "objective", "assessment", "plan")))
check("report 含免责声明", "辅助" in r1["disclaimer"])
check("report 含患者名", "张建国" in r1["soap"]["subjective"])

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
