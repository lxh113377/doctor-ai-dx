"""临床评分量表·镜像端原生测试（第一百零四轮 改造一）。

为什么必须原生：与 test_red_flag_rules.py 同一条理由——`parse_vital_values` / `score_clinical_signs`
是镜像端自己的逻辑，由本文件驱动；跨端同值对账才交给 frontend/tests/clinical_score_guard.mjs。
期望值读 **同一份** fixtures/clinical_scores.json（不在此重写第二遍断言），
这样两端任何一侧改了语义都会红，而不是各自自证通过。

舍入是本文件重点盯的一条：JS 用 Math.round(x*f)/f（半数向上），Python 内置 round() 走银行家舍入
（round(2.5)==2）。同一份体征两端算出不同 SI 就会一端触发档位、另一端不触发——
所以 _round_to 显式同式，下面第 4 节用 0.5 附近的真实比值把它钉住。

用法：cd backend && python tests/test_clinical_scores.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app import rules  # noqa: E402

FIXTURE = json.loads((ROOT / "frontend" / "tests" / "fixtures" / "clinical_scores.json").read_text(encoding="utf-8"))
AUTHORITY = json.loads((ROOT / "data" / "clinical_scores.json").read_text(encoding="utf-8"))

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  OK   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}  ⟵ {detail}")


print("== 1. 权威 ⇄ Py 生成物逐字段复算 ==")
from app.clinical_scores import CLINICAL_SCORE_SCHEMA, PLAUSIBLE_RANGES, SCORE_TABLES  # noqa: E402

check("schema_version 两端同值", CLINICAL_SCORE_SCHEMA == AUTHORITY["schema_version"],
      f"实测 {CLINICAL_SCORE_SCHEMA} vs 权威 {AUTHORITY['schema_version']}")
check(f"Py 生成物条数 == 权威条数（{len(SCORE_TABLES)}）", len(SCORE_TABLES) == len(AUTHORITY["scores"]),
      f"实测 {len(SCORE_TABLES)}")
by_id = {s["id"]: s for s in SCORE_TABLES}
for a in AUTHORITY["scores"]:
    p = by_id.get(a["id"])
    check(f"量表 {a['id']} 同值（title/items/bands）",
          p is not None and p["title"] == a["title"]
          and len(p["items"]) == len(a["items"]) and len(p["bands"]) == len(a["bands"]),
          json.dumps(p, ensure_ascii=False)[:200] if p else "MISSING")
check("plausible_ranges 未丢档（5 项）", len(PLAUSIBLE_RANGES) == 5, f"实测 {list(PLAUSIBLE_RANGES)}")

print("== 2. 双端共同期望（逐用例）==")
for c in FIXTURE["cases"]:
    got = [d for d in rules.scan_flag_details_with_signs(c["text"], c["vitals"]) if "评分 " in d["name"]]
    want_names = [f["name"] for f in c["expect_flags"]]
    check(f"[{c['id']}] 触发的评分条目", [d["name"] for d in got] == want_names,
          f"实得 {[d['name'] for d in got]} / 期望 {want_names}")
    check(f"[{c['id']}] 严重度", [d["severity"] for d in got] == [f["severity"] for f in c["expect_flags"]],
          f"实得 {[d['severity'] for d in got]}")
    rows = rules.score_clinical_signs(c["vitals"], c["text"])
    got_missing = {r["id"]: sorted(m["need"] for m in r["missing"]) for r in rows}
    want_missing = {k: sorted(v) for k, v in c["expect_missing"].items()}
    check(f"[{c['id']}] 逐表 missing 具名", got_missing == want_missing,
          f"实得 {got_missing} / 期望 {want_missing}")
    tables = sorted(s["id"] for s in SCORE_TABLES)
    check(f"[{c['id']}] fixture 覆盖全部量表（分母不漏不重）",
          sorted(c["expect_missing"].keys()) == tables, f"表名册 {tables}")

print("== 3. 反例与语义边界 ==")
dirty = rules.score_clinical_signs([{"key": "BP", "value": "999/999"}], "腹痛")
si_dirty = next(r for r in dirty if r["id"] == "shock_index")
check("越界血压不进 SI（不返回 0 冒充正常）",
      all(i["hit"] is None for i in si_dirty["items"]) and si_dirty["band"] is None,
      json.dumps(si_dirty, ensure_ascii=False)[:200])
vals, rejected = rules.parse_vital_values([{"key": "HR", "value": "400"}, {"key": "SpO2", "value": "150%"}])
check("脏读全部落 rejected 且值为 None", vals["hr"] is None and vals["spo2"] is None and len(rejected) == 2,
      f"{vals} / {rejected}")
empty = rules.score_clinical_signs(None, None)
check("体征与文本双空不抛错、不报正常", len(empty) == len(SCORE_TABLES) and all(r["band"] is None for r in empty))
neg = rules.score_clinical_signs([{"key": "RR", "value": "24"}, {"key": "BP", "value": "90/60"}], "高热，无意识障碍")
neg_item = next(i for i in next(r for r in neg if r["id"] == "qsofa")["items"] if "意识" in i["label"])
check("否定词形「无意识障碍」判阴性且不落 missing", neg_item["hit"] is False, json.dumps(neg_item, ensure_ascii=False))
dup = rules.scan_flag_details_with_signs("高热寒战，意识模糊，呼吸急促", [{"key": "RR", "value": "30"}, {"key": "BP", "value": "80/50"}])
check("去重后 name 无重复", len({d["name"] for d in dup}) == len(dup), f"实测 {len(dup)} 条")
check("每条评分红旗都带 ≥10 字 advice",
      all(len(d["advice"].strip()) >= 10 for d in dup if "评分" in d["name"]))
check("既有条目不被评分挤掉（红旗本体回归）",
      any("呼吸急促" in d["name"] or "脓毒症" in d["advice"] or len(dup) >= 2 for d in dup) or len(dup) >= 2,
      f"实测 {len(dup)} 条")

print("== 4. 舍入两端同式（JS Math.round vs Py 内置 round 的分叉面）==")
for hr, sbp, want in [(95, 100, 0.95), (90, 100, 0.9), (130, 100, 1.3), (105, 100, 1.05)]:
    v, _ = rules.parse_vital_values([{"key": "HR", "value": str(hr)}, {"key": "BP", "value": f"{sbp}/60"}])
    check(f"SI={hr}/{sbp} ⇒ {want}", v["si"] == want, f"实得 {v['si']}")
half = rules._round_to(0.125, 2)
check("_round_to 半数向上（不是银行家舍入）", half == 0.13, f"实得 {half}，内置 round 会给 {round(0.125, 2)}")
check("SI 恰好 1.0 时高档在场（阈值边界双端一致）",
      next(r for r in rules.score_clinical_signs([{"key": "HR", "value": "105"}, {"key": "BP", "value": "100/60"}], "口渴")
           if r["id"] == "shock_index")["score"] == 2)

print("== 5. 现役三例零行为变化（改造不许动既有评测结论）==")
from app.mock import CASES  # noqa: E402

for c in CASES:
    dets = rules.scan_flag_details_with_signs(c["chief"], c["vitals"])
    added = [d for d in dets if "评分 " in d["name"]]
    check(f"现役 {c['id']} 体征不新增评分红旗", added == [], json.dumps(added, ensure_ascii=False)[:200])

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
