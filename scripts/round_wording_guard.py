#!/usr/bin/env python3
"""入口面的"相对轮次词"看守（第四十三轮；台账 #106「手抄快照必然过期」的第二个形态）。

为什么要有它：`AGENTS.md` 与 `memory/07-next-steps.md` 是**新对话唯一的续接入口**，
而"本轮 / 上一轮"这类词离开写作那一刻就没有指代——第四十二轮写的「本轮 CI 判红」，
到第四十三轮读起来就变成"哪一轮？"，同一条线上第四十一轮的「本轮实测 8/8 ALL PASS」
已经是一个**错的数**（现在是 12 检）。文档里的数字会过期是已知病，**代词过期更隐蔽**：
它看起来仍然是一句通顺的话。

射程（必须声明，防"0 命中"被读成"没问题"）：
  在射程内：`AGENTS.md` `README.md` `CONTRIBUTING.md` `SECURITY.md` —— 入口/上手面，写给不认识历史的人。
  有意不在射程内：`CHANGELOG.md` 与 `docs/*.md` —— 那是**按版本/按事故编号组织的历史叙述体**，
  "本轮"在那里可由所在小节（`## [1.33.0]`）或同段其它锚点消歧；把 16 处一次性改写反而是在
  伪造叙述者的当时视角。扩面需要先给每处补绝对锚点，已列台账跟进，不在本判据里悄悄扩面。

词表也是收窄过的（第一版按"本轮/本次/下一轮/上次"全禁会误伤）：
  禁：`本轮`、`上一轮`（纯轮次自称）
  不禁：`本次提交`、`本次安装`、"把下一轮排查带到别的系统"（这些"次/轮"不是轮次计数器，
        第四十三轮实测它们确实出现在合规文句里）

三态：PASS（0 命中且面非空）/ FAIL（具名 文件:行 + 原句）/ EMPTY（扫不到文件或全空，rc=2）。
"""
from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

FACES = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "SECURITY.md"]
# 第四十四轮扩面：docs/*.md 纳入射程（29 行相对轮次词已用 blame→first-tag 换成版本锚点）。
# CHANGELOG.md 仍排除：它每个小节自带 `## [x.y.z]` 绝对锚点，句中指代可由所在小节消歧；
# 把它的历史叙述改写等于伪造叙述者当时的视角（该理由同时记在台账 #135）。
DOC_GLOB = "docs/*.md"
FORBIDDEN = re.compile(r"本轮|上一轮")


def scan_text(text: str) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(text.splitlines(), 1):
        m = FORBIDDEN.search(line)
        if m:
            j = m.start()
            out.append((i, line[max(0, j - 30):j + 40].strip()))
    return out


def check(root: Path, verbose: bool) -> int:
    faces = list(FACES) + sorted(str(x.relative_to(root)).replace("\\", "/")
                                 for x in root.glob(DOC_GLOB))
    hits = 0
    scanned = 0
    empty_faces = []
    for name in faces:
        f = root / name
        if not f.exists():
            empty_faces.append(name)
            continue
        text = open(f, encoding="utf-8").read()
        if not text.strip():
            empty_faces.append(name + "(空文件)")
            continue
        scanned += 1
        for ln, frag in scan_text(text):
            print(f"FAIL {name}:{ln} 相对轮次词 → …{frag}…")
            hits += 1
        if verbose and not hits:
            print(f"ok   {name}：无相对轮次自称")
    if scanned == 0:
        print("EMPTY :: 一个入口面都没读到 ⇒ 判据看不见输入，不许记绿")
        print("[GATE:round-wording-empty]")
        return 2
    if len(faces) - scanned > len(faces) // 2:
        print(f"EMPTY :: 入口面读到 {scanned}/{len(FACES)}，过半缺失＝取数面坏了（{', '.join(empty_faces)}）")
        print("[GATE:round-wording-empty]")
        return 2
    if hits:
        print(f"[GATE:round-wording-fail] {hits} 处（改法＝换绝对锚点：第 N 轮 / v号 / 日期，而不是删判据）")
        return 1
    print(f"[GATE:round-wording-pass] {scanned} 个耐久面零命中")
    return 0


def selftest(root: Path) -> int:
    cases = []
    cases.append(("真实入口面须零命中（正例）", scan_text(
        open(root / "AGENTS.md", encoding="utf-8").read()) == []))
    bad = "下一步：跑 `node work/freeze_check.mjs`，本轮实测 12/12 全绿。\n"
    got = scan_text(bad)
    cases.append(("注入「本轮」必须被抓（反例专属输入面）", len(got) == 1 and "本轮" in got[0][1]))
    ok = "一条命令看本次提交在 Actions 上的结果；猜测式提示语会把下一轮排查带到别的系统上。\n"
    cases.append(("「本次提交 / 下一轮排查」不得误报（反向腿，防假红）", scan_text(ok) == []))
    empty_dir = Path(tempfile.mkdtemp(prefix="rwg_"))
    cases.append(("入口面全缺失 ⇒ rc=2 而不是 0", check(empty_dir, False) == 2))
    injected = Path(tempfile.mkdtemp(prefix="rwg_bad_"))
    (injected / "AGENTS.md").write_text(bad, encoding="utf-8")
    (injected / "README.md").write_text("正常一行。\n", encoding="utf-8")
    (injected / "CONTRIBUTING.md").write_text("正常两行。\n再来一行。\n", encoding="utf-8")
    cases.append(("有命中时 check() 返回 1（不是只打印）", check(injected, False) == 1))
    bad_sum = sum(0 if ok2 else 1 for _n, ok2 in cases)
    for name, ok2 in cases:
        print(f"  {'PASS' if ok2 else 'FAIL'} {name}")
    print(f"SELFTEST: {len(cases) - bad_sum}/{len(cases)}")
    print("[GATE:round-wording-selftest-pass]" if bad_sum == 0 else "[GATE:round-wording-selftest-fail]")
    return 0 if bad_sum == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    root = Path(a.root).resolve()
    return selftest(root) if a.selftest else check(root, not a.quiet)


if __name__ == "__main__":
    sys.exit(main())
