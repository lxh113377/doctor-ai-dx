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
# 第四十八轮扩面：`.github/workflows/*.yml` 的注释也是耐久说明书（评审与下一个会话都会读），
# 里面同样写着"本轮实测 87""本轮脚本扩面而钩子没扩"这类相对自称——轮次一翻就查不到指代。
# 一手计数：扩面前 workflows 里 3 个文件共 8 处（ci.yml 3／dep-triage.yml 1／release.yml 4）。
WF_GLOB = ".github/workflows/*.yml"
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


def all_faces(root: Path) -> list[str]:
    """射程的唯一枚举器：入口四面 + `docs/*.md` + `.github/workflows/*.yml`。

    只写这一处（不是 check 与钩子对账各写一份）是故意的：两把尺各自枚举迟早算出两个分母，
    而"钩子覆盖没覆盖"这条判据恰恰要求两边共用同一个面（#149 同一事实只许一处判）。
    """
    out = list(FACES)
    for glob in (DOC_GLOB, WF_GLOB):
        out.extend(sorted(str(x.relative_to(root)).replace("\\", "/") for x in root.glob(glob)))
    return out


def check(root: Path, verbose: bool) -> int:
    faces = all_faces(root)
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


def hook_uncovered_faces(root: Path, files_re: str | None = None) -> list[str]:
    """返回「脚本会扫、但提交链的钩子射程不会触发」的面。

    为什么要有这条（复发计数=3 的机器落点）：#46（composite 的 uses: 不受保护）、#129（run 块只补解析级）、
    本轮（脚本射程加了 docs/*.md 而 `.pre-commit-config.yaml` 的 `files:` 没跟上 ⇒ 真实提交里钩子打印
    Skipped，判据根本没跑到）。前两次都靠下一轮人肉发现，这次让自测当场判红：
    钩子的 `files:` 只是**触发过滤器**（`pass_filenames: false` 时不参与取数），
    所以每个耐久面都必须能被它匹配到，否则该面的改动永远绕开这道闸。
    """
    cfg = root / ".pre-commit-config.yaml"
    if not cfg.exists():
        return ["<.pre-commit-config.yaml 缺失>"]
    text = cfg.read_text(encoding="utf-8")
    blk = re.search(r"-\s+id:\s*round-wording-guard\b(.*?)(?=\n\s{6}-\s+id:|\Z)", text, re.S)
    if not blk:
        return ["<钩子 round-wording-guard 不在配置里>"]
    if files_re is None:
        m = re.search(r"^\s*files:\s*(.+)$", blk.group(1), re.M)
        if not m:
            return []          # 没有 files: ＝全量触发，覆盖一切
        files_re = m.group(1).strip()
    pat = re.compile(files_re)
    return [f for f in all_faces(root) if not pat.search(f)]


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
    uncov = hook_uncovered_faces(root)
    narrow = r"^(AGENTS|README|CONTRIBUTING|SECURITY)\.md$"
    got_narrow = hook_uncovered_faces(root, narrow)
    print(f"  信息 钩子 files: 现算未覆盖面={uncov}；退回扩面前的写法时={got_narrow}")
    cases.append(("每个耐久面都必须能被钩子 files: 触发（Skipped＝判据没跑到）", uncov == []))
    cases.append(("反向腿：files: 退回扩面前的写法 ⇒ 必须点名 docs 面（证明这条判据有牙）",
                  any(f.startswith("docs/") for f in got_narrow)))
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
