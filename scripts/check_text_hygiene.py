#!/usr/bin/env python
r"""文本卫生门禁：全仓受版本控制的文本文件不得含 C0 控制字符（\t \n \r 之外）与 DEL。

为什么立这道门（同类缺陷两次实测）：
  · v1.11.0 把 JS 正则里的 \\b 写进 privacy_guard.mjs 时，经 Python 字符串落地被转义成裸 0x08，
    三条遥测判据变成"永不匹配的死判据"，而聚合反例仍判绿 —— 由 v1.12.0 的 ESLint no-control-regex 才发现。
  · v1.12.0 写 CHANGELOG 时同一机制当场复发（6 处 0x08），只是这次由自检脚本抓到。
结论：靠"记得用原始字符串"防不住，必须有一道与语言无关的字节层面门禁兜底。

用法：
  python scripts/check_text_hygiene.py                # 扫 git ls-files 的文本文件（CI/提交前）
  python scripts/check_text_hygiene.py --root ..      # 同一门禁扫工作区级父仓（AGENTS.md/memory/ 等）
  python scripts/check_text_hygiene.py --check-file P # 只扫单文件（反例自证与手工复查用）
  python scripts/check_text_hygiene.py --quiet
退出码：0 干净 / 1 发现控制字符 / 2 环境或参数错误（含"清单为空"，禁止静默通过）。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {".md", ".txt", ".js", ".mjs", ".cjs", ".jsx", ".py", ".json", ".yml", ".yaml",
                 ".css", ".html", ".toml", ".cfg", ".ini", ".sh", ".ps1", ".example", ".gitignore"}
# \t(9) \n(10) \r(13) 合法；其余 C0（0-8,11,12,14-31）与 DEL(127) 一律判违规。
OK_CODEPOINTS = {9, 10, 13}
MIN_FILES = 40  # 少于该数说明清单来源出问题（死链/非 git 目录），必须判红而非"零违规"


def scan_file(path: Path) -> list[str]:
    problems: list[str] = []
    try:
        raw = path.read_bytes()
    except OSError as exc:  # 读不到就判红，不静默跳过
        return [f"{path}: 无法读取（{exc}）"]
    if b"\x00" in raw[:8192]:
        return []  # 真二进制（ZIP/PNG 等）不归本门禁管
    text = raw.decode("utf-8", errors="replace")
    if "\ufffd" in text:  # U+FFFD：解码替换符，说明文件含非 UTF-8 字节（本行只写转义序列，不写字面量）  # U+FFFD：解码替换符，说明非 UTF-8 字节
        problems.append(f"{path}: 非 UTF-8 字节（解码出现替换符）")
    for lineno, line in enumerate(text.split("\n"), 1):
        for col, ch in enumerate(line, 1):
            cp = ord(ch)
            if (cp < 32 or cp == 127) and cp not in OK_CODEPOINTS:
                snippet = line.replace(ch, f"[{ch}]")[:110]
                problems.append(f"{path}:{lineno}:{col}: 控制字符 U+{cp:04X} — {snippet}")
    return problems


def tracked_text_files(root: Path) -> list[Path]:
    out = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        print(f"git ls-files 失败：{out.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2)
    names = [n for n in out.stdout.split("\0") if n]
    return [root / n for n in names
            if Path(n).suffix in TEXT_SUFFIXES or Path(n).name == ".gitignore"]


def main() -> int:
    ap = argparse.ArgumentParser(description="全仓文本控制字符门禁")
    ap.add_argument("--check-file", default="", help="只扫这一个文件（反例自证用）")
    ap.add_argument("--root", default=str(REPO),
                    help="受版本控制的仓根（默认本仓；工作区级文件可指向其父仓）")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if args.check_file:
        target = Path(args.check_file)
        if not target.is_file():
            print(f"[GATE:text-hygiene-fail] 文件不存在：{target}", file=sys.stderr)
            return 2
        problems = scan_file(target)
        scanned = 1
    else:
        root = Path(args.root).resolve()
        files = tracked_text_files(root)
        if len(files) < MIN_FILES:
            print(f"[GATE:text-hygiene-fail] 清单仅 {len(files)} 个文本文件（<{MIN_FILES}）"
                  "——清单来源异常时零命中属假通过", file=sys.stderr)
            return 2
        problems = []
        for f in files:
            problems += scan_file(f)
            if len(problems) > 20:
                break
        scanned = len(files)

    if not args.quiet:
        print(f"文本卫生扫描：{scanned} 个受控文本文件")
    for line in problems[:20]:
        print(f"  FAIL {line}")
    if problems:
        print(f"\n[GATE:text-hygiene-fail] {len(problems)} 处违规"
              "（常见根因：经 Python/bash 字符串落地时 \\b \\f 等被转义成裸控制字符）")
        return 1
    print("[GATE:text-hygiene-pass] 未发现 C0 控制字符与 DEL")
    return 0


if __name__ == "__main__":
    sys.exit(main())
