"""后端引擎冒烟测试（无 Key → rule-fallback），断言与 frontend smoke_engine.mjs 对齐。
用法：cd backend && python -m tests.smoke_engine
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.pop("DEEPSEEK_API_KEY", None)  # 强制无 Key 降级

from app import rag, rules  # noqa: E402
from app.rag import has_evidence  # noqa: E402
from app.retriever import get_retriever  # noqa: E402
from app.services import engine  # noqa: E402

HIST_C1 = [{"role": "user", "content": c} for c in
           ["压榨样/紧缩感", "向左肩臂放射", "活动/劳累时加重", "出冷汗", "高血压，吸烟"]]
HIST_C2 = [{"role": "user", "content": c} for c in
           ["最高超过 39℃", "黄脓痰", "无", "明显咽痛", "接触过流感/新冠患者"]]

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


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

# 红旗规则探针（第十四轮补）：与 frontend/tests/engine_smoke.mjs 的 RED_FLAG_PROBES 逐字同表。
# 覆盖 rules.py 的数值血压判定 / 组合线索 / 脏读值域拒绝 / 同名去重 / 空输入五条分支
# —— 此前这些分支在镜像端零执行（JS 端有测，Python 端没有，双端"同逻辑"无判据）。
RED_FLAG_PROBES = [
    ("血压 190/110 伴头痛", ["高血压急症红旗|高"]),
    ("血压 400/300", []),
    ("血压 120/80 无不适", []),
    ("停经 6 周，阴道出血，下腹剧痛，面色苍白", ["异位妊娠（宫外孕）破裂红旗|高"]),
    ("高血压危象，血压 200/130", ["高血压急症红旗|高"]),
    ("", []),
    # 否定修饰（第二十四轮补）：前 1 条是实测从产品路径抓到的假阳性，后 4 条锁住修复的边界。
    # "无气促" 曾被当成 "气促" 阳性 ⇒ 脓毒症红旗误报；"无尿" 却是真阳性（尿闭），方向不能搞反。
    ("最高超过39℃，黄脓痰，无气促，明显咽痛", []),
    ("高热伴意识模糊", ["脓毒症红旗|高"]),
    ("老年男性无尿伴下腹胀痛", ["急性尿潴留红旗|中"]),
    ("无尿痛，无尿频", []),
    # 鉴别探针：与上一条同前缀，但这条**带齐了尿潴留的第二组线索**——若把 "无尿痛" 里的 "无尿"
    # 误当阳性体征，这条就会假阳性。本条是修复首版把排除条件写成互斥时实测判红补上的。
    ("老年男性无尿痛伴下腹胀痛", []),
    ("阵发性哭闹，没有呕吐", []),
]
# 否定守卫全表探针（第二十五轮 #50，镜像端派生版）：分母交给规则表本身，不是手挑对照集。
# 与 frontend/tests/negation_probe.mjs 同一性质的判据（各自主张同一事实，跨端漂移由上面的逐字全等表拦）。
_neg_hits = 0
for _r in rules.DANGER_RULES:
    for _k in _r["keywords"]:
        _pos = any(h["name"] == _r["name"] for h in rules.scan_flag_details(_k))
        check(f"DANGER {_r['name']} 关键词 {_k!r} 阳性即命中", _pos)
        _neg = any(h["name"] == _r["name"] for h in rules.scan_flag_details("没有" + _k))
        check(f"DANGER {_r['name']} 关键词 {_k!r} 加否定前缀即不命中", not _neg)
        _neg_hits += 2
for _r in rules.COMBO_RULES:
    _groups = _r["all"]
    for _gi, _g in enumerate(_groups):
        _others = [_gg[0] for _i, _gg in enumerate(_groups) if _i != _gi]
        for _k in _g:
            _pos = any(h["name"] == _r["name"] for h in rules.scan_flag_details("，".join(_others + [_k])))
            check(f"COMBO {_r['name']} 第{_gi + 1}组 {_k!r} 齐线索即命中", _pos)
            _neg = any(h["name"] == _r["name"] for h in rules.scan_flag_details("，".join(_others + ["没有" + _k])))
            check(f"COMBO {_r['name']} 第{_gi + 1}组 {_k!r} 被否即不命中", not _neg)
            _neg_hits += 2
check(f"镜像端派生用例数非空且达下限（实测 {_neg_hits}，<100 即规则表读空）", _neg_hits >= 100,
      "读空＝判据失效，不许当通过")

for probe_text, want in RED_FLAG_PROBES:
    got = [f"{h['name']}|{h['severity']}" for h in rules.scan_flag_details(probe_text)]
    check(f"红旗探针 {probe_text!r}", got == want, f"实测 {got} 期望 {want}")

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
