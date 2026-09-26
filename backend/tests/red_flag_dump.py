"""红旗表·Python 侧 dump（第三十轮 #83），由 frontend/tests/red_flag_table_guard.mjs 以子进程调用。

为什么用 dumper 而不是让 JS 守卫 subprocess 调 Python 跑断言：断言留在 JS 侧，Python 只**给事实**
（表本体 + 校验结论 + 同一份变异夹具的逐条结果）。上一轮的教训正是「守卫用 subprocess 调 Python
执行逻辑 ⇒ coverage.py 看不见镜像端」，所以镜像端的逻辑必须由 `tests/test_red_flag_rules.py` 原生测。

用法：python tests/red_flag_dump.py
输出：stdout 一段 JSON（禁止混印其它文本）。
"""
from __future__ import annotations

import copy
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.pop("DEEPSEEK_API_KEY", None)

from app import rules  # noqa: E402

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "red_flag_mutations.json"


def apply_case(case: dict, danger: list, combo: list) -> tuple[list, list]:
    """按夹具施加一处变异，返回 (danger', combo')；原表只读，绝不就地改。"""
    d = copy.deepcopy(danger)
    c = copy.deepcopy(combo)
    if case.get("op") == "empty":
        return [], []
    pool = d if case["target"] == "danger" else c
    i = int(case["index"])
    if case.get("op") == "replace":
        pool[i] = case["replace"]
        return d, c
    src_ref = case.get("copy_name_from")
    if src_ref:
        src = d if src_ref["target"] == "danger" else c
        pool[i]["name"] = src[int(src_ref["index"])]["name"]
    for k, v in (case.get("set") or {}).items():
        pool[i][k] = v
    return d, c


def main() -> int:
    spec = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = spec.get("cases") or []
    if not cases:
        print(json.dumps({"fatal": "变异夹具为空——读空不许当通过", "cases": []}, ensure_ascii=False))
        return 2
    out = {
        "danger": rules.DANGER_RULES,
        "combo": rules.COMBO_RULES,
        "severities": rules.RED_FLAG_SEVERITIES,
        # 第三十一轮 #89 起，守卫要核「权威 == JS == Py」三方，词表与阈值同样是权威里的数据，
        # 只 dump 两张规则表会让"漂了的词表"继续判绿。
        "negations": rules._NEGATION_TOKENS,
        "positives": rules._POSITIVE_TERMS,
        "bp": rules.BP_THRESHOLDS,
        "clean_errs": rules.validate_red_flag_rules(),
        "mutations": {},
    }
    for case in cases:
        d, c = apply_case(case, rules.DANGER_RULES, rules.COMBO_RULES)
        out["mutations"][case["id"]] = rules.validate_red_flag_rules(d, c)
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
