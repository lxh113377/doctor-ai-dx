"""红旗规则表·镜像端原生测试（第三十轮 #83，台账 #83）。

为什么必须原生：上一轮的教训是「守卫用 subprocess 调 Python ⇒ coverage.py 看不见镜像端」，
所以 `validate_red_flag_rules` / `assert_red_flag_tables` 这些**镜像端自己的逻辑**由本文件驱动，
跨端事实对账（表本体是否同值）才交给 `frontend/tests/red_flag_table_guard.mjs`。

用法：cd backend && python tests/test_red_flag_rules.py
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import rules  # noqa: E402

from red_flag_dump import apply_case  # noqa: E402

FIX_DIR = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures"
mut_spec = json.loads((FIX_DIR / "red_flag_mutations.json").read_text(encoding="utf-8"))
red_line = json.loads((FIX_DIR / "red_line_phrases.json").read_text(encoding="utf-8"))

passed = failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


print("== 1. 现表形状事实（读空即判红，不许静默通过）==")
# 在任何变异驱动之前先留一份**深拷贝快照**做对照：本文件里的坏表都是喂给校验器的副本，
# 若现表被就地改写（拷贝失守），后面所有断言证的就不再是产品实际加载的那张表。
_snap_danger = copy.deepcopy(rules.DANGER_RULES)
_snap_len = len(rules.DANGER_RULES)
_snap_first_sev = rules.DANGER_RULES[0]["severity"]
check(f"表规模非空（DANGER={len(rules.DANGER_RULES)} COMBO={len(rules.COMBO_RULES)}）",
      len(rules.DANGER_RULES) >= 13 and len(rules.COMBO_RULES) >= 4)
check(f"severity 值域为 高/中/低（实测 {rules.RED_FLAG_SEVERITIES}）",
      rules.RED_FLAG_SEVERITIES == ["高", "中", "低"])
names = [r["name"] for r in rules.DANGER_RULES + rules.COMBO_RULES]
check("全表 name 唯一（校验器主张的那件事，现表本身必须先满足）", len(names) == len(set(names)),
      f"重名 {sorted({n for n in names if names.count(n) > 1})}")
check(f"变异夹具非空（cases={len(mut_spec['cases'])}）", len(mut_spec["cases"]) >= 8)

print("== 2. 载入即校验：未变异必须零拒绝（防校验器恒假）==")
clean = rules.validate_red_flag_rules()
check("现表 0 拒绝", len(clean) == 0, " ;; ".join(clean[:3]))
try:
    rules.assert_red_flag_tables()
    check("assert_red_flag_tables() 对现表不抛", True)
except RuntimeError as exc:  # pragma: no cover - 只在表坏时到这
    check("assert_red_flag_tables() 对现表不抛", False, str(exc)[:120])

print("== 3. 夹具逐条变异：每条都必须被拒且点名对应不变量 ==")
for case in mut_spec["cases"]:
    d, c = apply_case(case, rules.DANGER_RULES, rules.COMBO_RULES)
    errs = rules.validate_red_flag_rules(d, c)
    hit = [e for e in errs if case["expect"] in e]
    check(f"变异「{case['id']}」被拒且点名「{case['expect']}」", len(errs) > 0 and bool(hit),
          "校验器恒真＝该拒绝路径不存在" if not errs else f"拒了但未点名：{errs[0][:70]}")

print("== 4. 覆盖面：声明的每类不变量都至少被一条变异打到 ==")
touched = {cls for cls in mut_spec["invariant_classes"]
           for case in mut_spec["cases"] if case["expect"] == cls}
untouched = [cls for cls in mut_spec["invariant_classes"] if cls not in touched]
check(f"不变量全覆盖（声明 {len(mut_spec['invariant_classes'])} 类）", len(untouched) == 0,
      f"未被触及：{untouched}——声明了却没人验＝假安全")

print("== 5. 坏表必须让导入期拒绝（直接驱动 raise 路径，不靠改源码做变异）==")
bad_d = [dict(rules.DANGER_RULES[0], severity="危急")]
try:
    rules.assert_red_flag_tables(bad_d, [])
    check("severity 越值域时 assert 抛 RuntimeError", False, "没抛＝fail-fast 是假的")
except RuntimeError as exc:
    check("severity 越值域时 assert 抛 RuntimeError", "severity" in str(exc), str(exc)[:80])
try:
    rules.assert_red_flag_tables([], [])
    check("空表时 assert 抛 RuntimeError", False, "没抛＝读空被当通过")
except RuntimeError as exc:
    check("空表时 assert 抛 RuntimeError", "整体为空" in str(exc), str(exc)[:80])
check("驱动坏表后现表未被改写",
      len(rules.DANGER_RULES) == _snap_len and rules.DANGER_RULES[0]["severity"] == _snap_first_sev
      and rules.DANGER_RULES == _snap_danger,
      f"快照 {len(rules.DANGER_RULES)} 条 vs 实测 {len(rules.DANGER_RULES)} 条")

print("== 6. 静态自产文案过裸子串红线（禁用词单一源＝red_line_phrases.json）==")
forbidden = red_line["forbidden_phrases"]
check(f"禁用词清单非空（{len(forbidden)} 项）", len(forbidden) >= 3)
offenders = [f'{r["name"]} 含「{f}」' for r in rules.DANGER_RULES + rules.COMBO_RULES
             for f in forbidden if f in str(r.get("advice", "")) + str(r.get("name", ""))]
check(f"全部 advice/name 无命中（{len(names)} 条 × {len(forbidden)} 词）", not offenders,
      " ;; ".join(offenders[:3]))

print("== 7. 校验器上线后红旗行为回归（别把红线本体改坏）==")
acs = rules.scan_flags("压榨样胸痛，向左肩臂放射，出冷汗")
check("ACS 关键词仍命中", any("冠脉综合征" in f for f in acs), f"实测 {acs}")
check("被否定的症状不再命中（第二十四轮修复不回潮）",
      rules.scan_flags("最高超过39℃，黄脓痰，无气促，明显咽痛") == [])
dup_probe = rules.scan_flag_details("血压骤升，高血压危象，血压 200/130")
check("同名不重复出（高血压急症只出一条）",
      sum(1 for h in dup_probe if "高血压急症" in h["name"]) == 1, f"实测 {len(dup_probe)} 条")

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
