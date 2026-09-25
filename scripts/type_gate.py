#!/usr/bin/env python
r"""Python 类型门禁：跑 mypy 并按 fixtures/type_floor.json 的阈值判定（阈值单一权威源）。

为什么不是"直接跑 mypy 看退出码"（第十五轮设计说明）：
  · mypy 静默检查 0 个文件也会报成功 ⇒ 必须实证「检查了 ≥N 个源文件」（R247 输入非空证明）。
  · 工具版本换默认行为 ⇒ 必须实证 devDeps 里 mypy 被钉住，且实跑版本 ≥ 阈值最低版本。
  · 阈值写在 fixture 而 CI 硬编码 ⇒ 两套数（r14 实测抓出该缺陷），故本脚本只读 fixture。
借鉴来源（实测）：OpenEMR phpstan level 10 + phpstan-baseline-diff.yml（只拦新增）；
我方存量已清零，直接钉 expected_errors=0，比基线豁免更严。

用法：
  python scripts/type_gate.py                  # 正常判定
  python scripts/type_gate.py --fixture PATH   # 换阈值（反例自证：喂假阈值必须判红）
  python scripts/type_gate.py --quiet
退出码：0 达标 / 1 判红（类型错误超阈值或输入非空证明失败）/ 2 环境或参数错误（fail-closed）。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "frontend" / "tests" / "fixtures" / "type_floor.json"
DEV_DEPS = REPO / "backend" / "requirements-dev.txt"
SUMMARY = re.compile(r"(?:Found|Success: no issues found in)\s+(?P<err>\d+)\s+errors?\s+in.*?\(checked\s+(?P<checked>\d+)\s+source files\)")
PLAIN = re.compile(r"no issues found in\s+(?P<checked>\d+)\s+source files")
VERSION = re.compile(r"mypy\s+(?P<v>[\d.]+)")


def parse_version(text: str) -> tuple[int, ...]:
    return tuple(int(x) for x in text.split(".")[:3] if x.isdigit())


SUPPRESS_CODE = re.compile(r"#\s*type:\s*ignore")
SUPPRESS_CFG = re.compile(r"^\s*(disable_error_code|ignore_errors|follow_imports)\b")


def find_suppressions() -> list[str]:
    """扫 mypy 抑制项：源码里的行尾类型抑制注释（井号 + type 冒号 ignore 形态）
    与 mypy.ini 里的整段关闸（disable_error_code / ignore_errors / follow_imports），台账#18。

    本行刻意不写那条字面量：扫描器若在自身文案里出现被扫字面量，就会自判红（实测发生一次）。
    只针对 mypy 一类，**不碰 ruff 的行尾 noqa**——后者在 ruff.toml 头注里逐条写明理由，
    属不同判据体系，混在一起判红会把已论证的余量也一起打掉。
    """
    hits: list[str] = []
    for base in (REPO / "backend" / "app", REPO / "scripts"):
        for f in sorted(base.rglob("*.py")):
            for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if SUPPRESS_CODE.search(line):
                    hits.append(f"{f.relative_to(REPO)}:{n}")
    cfg = REPO / "mypy.ini"
    if cfg.is_file():
        for n, line in enumerate(cfg.read_text(encoding="utf-8").splitlines(), 1):
            if SUPPRESS_CFG.match(line):
                hits.append(f"mypy.ini:{n} {line.strip()}")
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description="mypy 阈值棘轮")
    ap.add_argument("--fixture", default=str(FIXTURE))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    fixture = Path(args.fixture)
    if not fixture.is_file():
        print(f"[GATE:type-fail] 阈值文件不存在：{fixture}", file=sys.stderr)
        return 2
    floor = json.loads(fixture.read_text(encoding="utf-8"))

    ver = subprocess.run([sys.executable, "-m", "mypy", "--version"], capture_output=True, text=True)
    if ver.returncode != 0:
        print("[GATE:type-fail] mypy 不可用：先 `python -m pip install -r backend/requirements-dev.txt`", file=sys.stderr)
        return 2
    found = VERSION.search(ver.stdout)
    run_version = found.group("v") if found else "0"

    dev = DEV_DEPS.read_text(encoding="utf-8") if DEV_DEPS.is_file() else ""
    pinned = re.search(r"^\s*mypy\s*([<>=!~].+)$", dev, re.M)

    run = subprocess.run([sys.executable, "-m", "mypy"], capture_output=True, text=True, cwd=REPO)
    out = (run.stdout or "") + (run.stderr or "")
    if run.returncode not in (0, 1):  # mypy 自身报错（配置坏/文件缺失）不得当成"通过"
        print(f"[GATE:type-fail] mypy 异常退出 rc={run.returncode}\n{out.strip()[:800]}", file=sys.stderr)
        return 2
    m = SUMMARY.search(out) or PLAIN.search(out)
    if not m:
        print(f"[GATE:type-fail] 无法从 mypy 输出解析统计（判据失效即 fail-closed）\n{out.strip()[:800]}", file=sys.stderr)
        return 2
    checked = int(m.group("checked"))
    errors = int(m.groupdict().get("err", 0) or 0)

    budget = int(floor.get("max_suppressions", 0))
    sup = find_suppressions()
    checks: list[tuple[str, bool, str]] = [
        (f"mypy 抑制项 {len(sup)} 处 ≤ 预算 {budget}（零豁免要有机器判据，台账#18）",
         len(sup) <= budget, "; ".join(sup[:6])),
        ("mypy 运行版本 ≥ 阈值最低版本", parse_version(run_version) >= parse_version(str(floor["min_version"])),
         f"实跑 {run_version} / 最低 {floor['min_version']}"),
        ("requirements-dev.txt 钉住 mypy 版本区间（换版本=换判据）", bool(pinned),
         "未检出 mypy 钉版行" if not pinned else pinned.group(0).strip()),
        (f"实跑检查源文件数 ≥ 下限 {floor['files_checked_min']}（输入非空证明，R247）",
         checked >= int(floor["files_checked_min"]), f"实测 checked={checked}"),
        (f"类型错误 {errors} ≤ 阈值 {floor['expected_errors']}（只准收紧）", errors <= int(floor["expected_errors"]),
         "\n" + "\n".join(ln for ln in out.splitlines() if ": error:" in ln)[:900]),
    ]

    failed = 0
    for name, ok, detail in checks:
        if ok:
            if not args.quiet:
                print(f"  PASS {name}" + (f" [{detail}]" if detail and not args.quiet and len(detail) < 60 else ""))
        else:
            failed += 1
            print(f"  FAIL {name} :: {detail}")
    print(f"\nTYPE GATE SUMMARY: mypy={run_version} 检查文件={checked} 错误={errors} 阈值={floor['expected_errors']}")
    if failed:
        print("[GATE:type-fail] 类型门禁未达标（禁止用注释/ignore 静默放行；如需豁免须在阈值文件写明理由）")
        return 1
    print("[GATE:type-pass] RESULT: 全部达标")
    return 0


if __name__ == "__main__":
    sys.exit(main())
