#!/usr/bin/env python3
"""镜像/CI 通用自证 runner：从 tests/suite.json 驱动，逐套执行并在任一失败时 fail-fast。

为什么要有它（第二十轮）：清单此前在 `docker-compose.yml` 与 `frontend/package.json` 各抄一份，
新增套件漏挂 ⇒ 发布的镜像自证的是过期套件。改由单一源驱动后，漏挂由 `scripts/suite_guard.py` 判红。

用法：
  python selftest.py                  # 逐套跑，打印每套的 RESULT 行
  python selftest.py --coverage       # 每套前面套 coverage run --append（供覆盖率地板门禁接续）
  python selftest.py --only tests/test_fhir.py   # 只跑指定套件（本地调试）
退出码：0=全绿；1=有套件失败；2=清单不可用（缺文件/空清单，绝不静默当通过）。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "tests", "suite.json")


def load_suites(only: list[str]) -> list[str]:
    if not os.path.exists(MANIFEST):
        print(f"FAIL 缺清单：{MANIFEST}")
        sys.exit(2)
    with open(MANIFEST, encoding="utf-8") as f:
        suites = [s.replace("\\", "/") for s in (json.load(f).get("suites") or [])]
    if not suites:
        print("FAIL 清单为空（空清单不得判绿）")
        sys.exit(2)
    if only:
        unknown = [o for o in only if o not in suites]
        if unknown:
            print(f"FAIL --only 指定了清单外的条目：{unknown}")
            sys.exit(2)
        return only
    return suites


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage", action="store_true")
    ap.add_argument("--only", action="append", default=[])
    args = ap.parse_args()

    suites = load_suites(args.only)
    print(f"== 后端自证 runner：{len(suites)} 个套件（清单 tests/suite.json）==")
    for rel in suites:
        path = os.path.join(HERE, rel)
        if not os.path.exists(path):
            print(f"FAIL {rel} 文件不存在（清单与磁盘不符）")
            return 1
        cmd = [sys.executable]
        if args.coverage:
            cmd += ["-m", "coverage", "run", "--append", "--source=app"]
        cmd += [rel]
        r = subprocess.run(cmd, cwd=HERE)
        if r.returncode != 0:
            print(f"FAIL {rel} 退出码 {r.returncode}（fail-fast，后续套件不再执行）")
            return 1
        print(f"  OK {rel}")
    print(f"SELFTEST SUMMARY: {len(suites)}/{len(suites)} 套件 exit0")
    print("[GATE:selftest-pass]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
