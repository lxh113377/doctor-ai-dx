#!/usr/bin/env python
"""Python 侧覆盖率地板门禁（与 frontend/tests/coverage_floor_guard.mjs 同一份地板清单，单一权威源）。

为什么需要它（第十四轮实测）：py 地板值此前只以 `--fail-under=85` 硬编码在 ci.yml 与
package.json 两处，而 fixtures/coverage_floor.json 里的 `py_total_fail_under` **没有任何代码读取**
——即"地板清单"与"实际判据"是两套数（改 JSON 不改变判定）。本脚本把两处收敛为单一源，
并按模块判定：全局均值会掩盖红线模块单独退化（rules.py 语句覆盖曾 100% 而分支只走 75%）。

用法：
  python scripts/coverage_gate.py                 # 用默认地板清单判当前 .coverage 数据
  python scripts/coverage_gate.py --fixture PATH  # 换地板清单（反例自证：喂假地板必须判红）
  python scripts/coverage_gate.py --json-out PATH # 额外导出 coverage.py 的 json 产物
退出码：0 全绿 / 1 判红 / 2 参数或环境错误（缺数据即判红，禁止静默通过）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_FLOOR = REPO / "frontend" / "tests" / "fixtures" / "coverage_floor.json"
PY_FLOOR_PREFIX = "app" + "\\"


def run_coverage_json(backend_dir: Path, out: Path) -> dict:
    proc = subprocess.run(
        [sys.executable, "-m", "coverage", "json", "-o", str(out), "--quiet"],
        cwd=backend_dir, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"coverage json 失败：{proc.stdout}{proc.stderr}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(out.read_text(encoding="utf-8"))


def pct(summary: dict) -> float:
    return float(summary.get("percent_covered", 0.0))


def main() -> int:
    ap = argparse.ArgumentParser(description="coverage.py 模块级地板棘轮")
    ap.add_argument("--fixture", default=str(DEFAULT_FLOOR), help="地板清单 JSON（单一权威源）")
    ap.add_argument("--json-out", default=str(REPO / "backend" / "coverage-py.json"))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    floor_path = Path(args.fixture)
    if not floor_path.is_file():
        print(f"[GATE:coverage-py-fail] 地板清单不存在：{floor_path}", file=sys.stderr)
        return 2
    floors = json.loads(floor_path.read_text(encoding="utf-8"))
    backend_dir = REPO / "backend"
    data = run_coverage_json(backend_dir, Path(args.json_out))

    files = data.get("files") or {}
    # 先证输入非空：数据缺失时"零违规"是假通过（R247）
    checks: list[tuple[str, bool, str]] = [("覆盖率数据存在且非空", len(files) > 0, f"files={len(files)}")]
    total = pct(data.get("totals", {}))
    total_floor = float(floors.get("py_total_fail_under", 0))
    checks.append((f"TOTAL {total:.2f}% ≥ 地板 {total_floor:g}%", total >= total_floor, ""))

    py_modules = floors.get("py_modules") or {}
    known = {name.replace("\\", "/"): pct(v["summary"]) for name, v in files.items()}
    for mod, want in py_modules.items():
        key = mod if mod.startswith(PY_FLOOR_PREFIX.replace("\\", "/")) else f"{PY_FLOOR_PREFIX}{mod}".replace("\\", "/")
        hit = next((v for name, v in known.items() if name == key or name.endswith("/" + key)), None)
        if hit is None:
            checks.append((f"{mod} 在覆盖率产物中存在（防改名后地板失效）", False, f"已知={sorted(known)[:3]}…"))
            continue
        checks.append((f"{mod} {hit:.2f}% ≥ 地板 {want:g}%", hit >= want, f"实测 {hit:.2f}%"))

    # 地板清单与产物双向对账：清单里写了但产物没有 → 上面判红；产物有但清单没列 → 只报不红（新模块待登记）
    unlisted = [n for n, v in known.items()
                if v < 100.0 and not any(n.endswith(m.replace("\\", "/")) for m in py_modules)]
    failed = 0
    for name, ok, detail in checks:
        if not ok:
            failed += 1
            print(f"  FAIL {name}" + (f" :: {detail}" if detail else ""))
        elif not args.quiet:
            print(f"  PASS {name}")
    if unlisted and not args.quiet:
        print("  NOTE 未登记地板的模块（低于 100% 且不在清单内，须显式登记或补测）：" + ", ".join(sorted(unlisted)))
    print(f"\nCOVERAGE-PY GATE SUMMARY: 模块地板={len(py_modules)} 全局={total:.2f}%（地板 {total_floor:g}%）")
    if failed:
        print(f"[GATE:coverage-py-fail] {failed} 项未达标（地板只准收紧，放宽须在 _meta 写明原因）")
        return 1
    print("[GATE:coverage-py-pass] RESULT: 全部达标")
    return 0


if __name__ == "__main__":
    sys.exit(main())
