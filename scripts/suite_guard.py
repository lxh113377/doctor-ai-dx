#!/usr/bin/env python3
"""测试套件清单对账门禁（第二十轮）：一份清单只能有一个真相源，且三处消费方必须真的从它驱动。

立论（本轮实测踩到的）：第十九轮新增 `tests/test_limits.py` 后，
`docker-compose.yml` 的 selftest 与 `frontend/package.json` 的 coverage:py **各自硬编码了同一份五件套清单**，
新套件两边都没挂上 ⇒ 发布出去的镜像自证的是**过期套件**（那段注释还写着「三套」，数字也早失真）。
两处抄同一份清单＝漂移的必然，故本轮改为 manifest 驱动，并用本门禁把"再抄一份"变成判红。

判据（任一失败 exit 1）：
 1. 清单非空且 ≥ MIN_SUITES（**空清单不得判绿**，R247 同口径）
 2. 清单每条都是真实存在的文件（防改名后静默跳过）
 3. **反向覆盖**：`backend/tests/test_*.py` + `smoke_engine.py` 全部必须出现在清单里（新增测试忘记登记即判红）
 4. 清单不得有幽灵条目（指了不存在的文件也算红）
 5. 接线实证（禁第二真值）：三处消费方**不得再各自手写套件清单**
      - `docker-compose.yml` 的 selftest 必须调用 selftest.py，且其 command 里不得出现 `python tests/`
      - `frontend/package.json` 的 coverage:py 同上（不得逐条列 tests/*.py）
      - `.github/workflows/ci.yml` 的后端套件步骤必须调用 selftest.py（不得逐条列）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(REPO, "backend")
MANIFEST = os.path.join(BACKEND, "tests", "suite.json")
RUNNER = "selftest.py"
MIN_SUITES = 6  # 实测当前为 6（含 test_limits.py）；只许增不许降


def discover() -> set[str]:
    """按结构枚举真实套件：tests/ 下 test_*.py 一律算，另加不匹配该模式的 smoke_engine.py。"""
    tdir = os.path.join(BACKEND, "tests")
    out = {f"tests/{n}" for n in sorted(os.listdir(tdir)) if re.match(r"^test_.*\.py$", n)}
    if os.path.exists(os.path.join(tdir, "smoke_engine.py")):
        out.add("tests/smoke_engine.py")
    return out


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        print(f"FAIL 缺清单文件：{os.path.relpath(MANIFEST, REPO)}")
        return 1
    spec = json.loads(read(MANIFEST))
    suites = [str(s).replace("\\", "/") for s in (spec.get("suites") or [])]
    found = discover()

    checks: list[tuple[str, bool, str]] = []
    checks.append((f"清单非空且 ≥ {MIN_SUITES}", len(suites) >= MIN_SUITES, f"实测 {len(suites)}"))
    missing_files = [s for s in suites if not os.path.exists(os.path.join(BACKEND, s))]
    checks.append(("清单每条都真实存在（防改名后静默跳过）", not missing_files, f"缺文件 {missing_files}"))
    unregistered = sorted(found - set(suites))
    checks.append(("所有已存在的套件都已登记进清单（新增测试忘记登记即判红）",
                   not unregistered, f"漏登记 {unregistered}"))
    ghosts = sorted(set(suites) - found)
    checks.append(("清单无幽灵条目", not ghosts, f"多余 {ghosts}"))
    dup = [s for s in suites if suites.count(s) > 1]
    checks.append(("清单无重复条目", not dup, f"重复 {set(dup)}"))

    compose = read(os.path.join(REPO, "docker-compose.yml"))
    pkg = read(os.path.join(REPO, "frontend", "package.json"))
    ci = read(os.path.join(REPO, ".github", "workflows", "ci.yml"))
    st_command = compose.split("selftest:", 1)[1].split("healthcheck:", 1)[0] if "selftest:" in compose else ""
    checks.append(("docker-compose selftest 已改为 runner 驱动", RUNNER in st_command and "python tests/" not in st_command,
                   "仍在硬编码逐条套件＝第二真值"))
    cov = pkg.split('"coverage:py"', 1)[1] if '"coverage:py"' in pkg else ""
    checks.append(("package.json coverage:py 已改为 runner 驱动", RUNNER in cov and "tests/test_" not in cov,
                   "仍在硬编码逐条套件"))
    checks.append(("ci.yml 后端套件由 runner 驱动", RUNNER in ci and "run: python tests/test_" not in ci,
                   "CI 仍在逐条列套件"))
    checks.append((f"runner 存在且可执行（{RUNNER}）", os.path.exists(os.path.join(BACKEND, RUNNER)),
                   f"缺 {BACKEND}/{RUNNER}"))

    if not args.quiet:
        print(f"== 测试套件清单对账（清单 {len(suites)} 条 / 枚举 {len(found)} 条 / 三处消费方驱动检查）==")
    rc = 0
    for name, ok, detail in checks:
        if ok and args.quiet:
            continue
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
        if not ok:
            rc = 1
    print(f"[GATE:suite-{'pass' if rc == 0 else 'fail'}] 清单={os.path.relpath(MANIFEST, REPO)} 套件数={len(suites)}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
