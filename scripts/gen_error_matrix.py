#!/usr/bin/env python3
"""双端错误码对账矩阵生成器（第二十二轮，关台账#36 的第一半）。

为什么要有生成器：`fixtures/error_parity.json` 原来是 13 条**手写抽样**，
写的人以为覆盖了，其实只覆盖了 `/api/dx/c1` 一条路由的几种入参——
新增第 5 条 POST 路由时不会有任何东西提醒"它没被测过"。这正是本仓反复出现的
"覆盖面靠手感"问题（同 `docs_link_guard` 只认 6 个前缀那条）。

所以口径改成**枚举积**：4 条 POST 路由 × 9 类入站违规 = 36 条用例，
外加 2 条路由级用例（未知病例 id、未匹配路径）。每条的期望码由本文件声明，
生成后的 fixture 落在仓内做单一源；`error_parity_guard.mjs` 会：
  ① 比 已生成用例数 == len(ROUTES) × len(VIOLATIONS) + len(ROUTE_LEVEL)（少一条即红）
  ② 重跑本生成器并比对内容（改了路由/违规却不重生成 ⇒ drift 判红，同 `gen_openapi.py` 的口径）
  ③ 拿三份真值（期望 ↔ JS ↔ Py）逐条对账

跑法：
  python scripts/gen_error_matrix.py            # 生成/覆盖 fixture
  python scripts/gen_error_matrix.py --check    # 只比对，不写（CI 漂移检查用）
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / "frontend" / "tests" / "fixtures" / "error_parity.json"

S = 2000  # 单条字数上限（与 limits 同源，值本身由 limits_guard 对账，这里只造越界样本）
# 越界用例需要一个**合法基底**再放大，否则 body 里连 history 都没有，两端的反应是"缺字段"
# 而不是"超上限"，测到的就不是那条判据（本轮第一版就犯了这个错，被枚举矩阵自己抓出）。
BASE_H = {"history": [{"role": "user", "content": "腹"}]}

ROUTES = [
    {"path": "/api/intake/ask", "kind": "intake"},
    {"path": "/api/dx/{case}", "kind": "dx"},
    {"path": "/api/workup/{case}", "kind": "workup"},
    {"path": "/api/report/{case}", "kind": "report"},
]

# 每类违规给出：入参构造 + 期望码（按路由 kind 覆写，未覆写＝same）
VIOLATIONS = [
    {"name": "history 非数组", "body": {"history": "boom"}, "status": 422},
    {"name": "history 元素非对象", "body": {"history": ["junk"]}, "status": 422},
    {"name": "content 非字符串", "body": {"history": [{"role": "user", "content": {"a": 1}}]}, "status": 422},
    {"name": "role 非字符串", "body": {"history": [{"role": 7, "content": "x"}]}, "status": 422},
    {"name": "dx 非对象", "body": {"history": [], "dx": "x"}, "status": 422},
    {"name": "单条 content 超上限", "body": BASE_H,
     "repeat_content": S + 300, "status": 413},
    {"name": "history 条数超上限", "body": BASE_H,
     "repeat_items": 65, "status": 413},
    {"name": "请求体不是合法 JSON", "raw": "{oops", "status": 400},
    {"name": "空 body", "body": {}, "status": 200, "over": {"intake": 404}},
]

# 路由级用例（不参与枚举积，但同样三方对账）
ROUTE_LEVEL = [
    {"name": "未知病例 id", "path_kind": "dx", "real_case": "nope", "body": {"history": []},
     "status": 404, "message": "unknown case: nope"},
    {"name": "只带路径 case_id 的合法请求", "path_kind": "dx", "body": {"history": [
        {"role": "user", "content": "压榨样胸痛伴冷汗"}]}, "status": 200},
]


def real_path(route: dict, case: str = "c1") -> str:
    return route["path"].replace("{case}", case)


def build_cases() -> list[dict]:
    cases: list[dict] = []
    for route in ROUTES:
        for vio in VIOLATIONS:
            # 异构字典字面量会被 mypy 推成 object ⇒ 用 isinstance 窄化，而不是加抑制注释
            # （本仓 `scripts/type_gate.py` 有"零豁免"判据：源码里出现 type: ignore / noqa 型抑制即判红）
            over = vio.get("over") or {}
            expect = over[route["kind"]] if isinstance(over, dict) and route["kind"] in over else vio["status"]
            row: dict = {"name": f"{route['kind']} × {vio['name']}", "path": real_path(route),
                         "status": expect}
            for key in ("body", "raw", "repeat_content", "repeat_items"):
                if key in vio:
                    row[key] = vio[key]
            cases.append(row)
    for extra in ROUTE_LEVEL:
        row = {"name": extra["name"], "path": real_path({"path": f"/api/{extra['path_kind']}/{extra.get('real_case', 'c1')}"}),
               "body": extra["body"], "status": extra["status"]}
        if "message" in extra:
            row["message"] = extra["message"]
        cases.append(row)
    return cases


def render() -> str:
    doc = {
        "_source": "医·基层AI辅助诊断 · 双端错误码对账矩阵（由 scripts/gen_error_matrix.py 生成，禁手改用例）。",
        "_why": "口径是**枚举积**（POST 路由 × 入站违规类型），不是手写抽样：抽样会随路由增加而静默失真，"
                "而本仓的历史教训是「差异被测试钉住当契约」（台账#28：history:\"boom\" 权威面 500／镜像面 422）。"
                "期望值写在生成器里并入库成单一源 ⇒ 三方对账（期望 ↔ JS ↔ Py），只比两端互相等不够（两边一起错就永远绿）。",
        "_measured": "2026-09-25 第二十二轮：生成后由 error_parity_guard 双端实跑逐条核真值；"
                     "此前抓到的四条真实差异（case_id 只镜像面要、content 传对象镜像面 TypeError→500、"
                     "坏 JSON 400/422 分家、history 非数组 500/422）全部收敛后本矩阵才全绿。",
        "_regen": "python scripts/gen_error_matrix.py   （改路由或违规种类后必须重跑，否则 CI 漂移判红）",
        "routes": [r["path"] for r in ROUTES],
        "violation_kinds": [v["name"] for v in VIOLATIONS],
        "_meta": {"routes": len(ROUTES), "violations": len(VIOLATIONS), "route_level": len(ROUTE_LEVEL),
                  "cases": len(ROUTES) * len(VIOLATIONS) + len(ROUTE_LEVEL)},
        "cases": build_cases(),
    }
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="生成/校验双端错误码枚举矩阵")
    ap.add_argument("--check", action="store_true", help="只比对已入库 fixture，不写文件")
    args = ap.parse_args()

    text = render()
    meta = json.loads(text)["_meta"]
    if meta["cases"] != meta["routes"] * meta["violations"] + meta["route_level"]:
        print("::error::用例数与枚举积不符（生成器自身逻辑坏了）", file=sys.stderr)
        return 2

    if args.check:
        if not OUT.exists():
            print(f"::error::缺 fixture：{OUT.relative_to(REPO)}", file=sys.stderr)
            return 1
        current = OUT.read_text(encoding="utf-8")
        if current != text:
            cur = json.loads(current)
            cur_cases = [c["name"] for c in cur.get("cases", [])]
            new_cases = [c["name"] for c in json.loads(text)["cases"]]
            missing = [n for n in new_cases if n not in cur_cases]
            extra = [n for n in cur_cases if n not in new_cases]
            print("::error::错误码矩阵漂移（改了生成器没重生成，或手改了 fixture）")
            same_names = sum(1 for a, b in zip(cur_cases, new_cases, strict=False) if a == b)
            print(f"  缺用例 {missing[:6]}\n  多用例 {extra[:6]}\n  名字对得上的用例={same_names}（其余为字段级差异）")
            print("  修法：python scripts/gen_error_matrix.py 后连 fixture 一起提交")
            return 1
        print(f"[GATE:error-matrix-pass] 矩阵无漂移：{meta['routes']} 路由 × {meta['violations']} 违规 + "
              f"{meta['route_level']} 路由级 = {meta['cases']} 条")
        return 0

    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"已生成 {OUT.relative_to(REPO)}：{meta['routes']} 路由 × {meta['violations']} 违规 + "
          f"{meta['route_level']} 路由级 = {meta['cases']} 条用例")
    return 0


if __name__ == "__main__":
    sys.exit(main())
