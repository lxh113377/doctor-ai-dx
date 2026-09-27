#!/usr/bin/env python3
"""工作流 `run:` 块的本地语法探针（第四十轮 SC1073 事故的对应强化）。

为什么要有它（实测，不是推测）：本轮我为"失败路径"写的诊断 run 块把全角括号放进了命令替换
（形如 `$(curl … || echo 取不到（连接层失败）)`）⇒ CI 侧 actionlint 报
`shellcheck SC1073: Couldn't parse this command expansion`，`infra-lint` 判红；
而**同一时刻 Release 已经发出去了**（台账 #47）。本机为什么拦不住：`docker info` 报 daemon 不在、
`shellcheck`/`actionlint` 不在 PATH。`bash -n` 是本机跑得动的那一半，**第四十二轮实测证明"只做那一半"不够**：
同族第二次仍从 CI 判红（`arts="$(ls -1 | wc -l)"` → `SC2012:info`，run 36295599503），
而它在 `bash -n` 下完全合法 ⇒ 于是补上**可枚举的启发式腿**（全角标点、`ls` 枚举喂程序）。
边界照旧：**不冒充 actionlint**，未枚举的风格级规则仍只有 CI 侧抓得到（残留缺口见 docs/PITFALLS.md C6）。

三态输出（零输入绝不记绿，见 memory「零输入不得记 PASS」）：
  FAIL    某个 run 块 bash -n 不过，或命中已枚举的 shellcheck 形态（命令替换内全角标点 / 用 ls 枚举文件喂程序）
  EMPTY   一个 run 块都没抽到 ⇒ 抽取器或取数面坏了＝判据失效（rc=2）
  PASS    全部通过且分母 ≥1
bash 找不到时**只跑启发式腿并明说**——绝不因为"我的解释器环境问题"把合规脚本判成红（假红比没判据更糟）。
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BLOCK_RE = re.compile(r"^(\s*)run: [>|][-+]?\s*$")
#: 内联写法 `run: python x --selftest` 也是 shell 文本。v1.41.0 实测：抽取器原本只认 `run: |`，
#: 给 ci.yml 加一条内联步后探针分母**一个数都没变**（30/30）⇒ 仓里所有内联 run 一直不在射程内
#: （不是缺陷暴露，是判据看不见自己少测了；同一族禁令：取数面必须能自证覆盖）。
INLINE_RE = re.compile(r"^(\s*)run:\s+(\S.*?)\s*$")
FULLWIDTH = re.compile(r"[（）【】：；，]")
# SC2012 一族（shellcheck 的**风格级**判据，`bash -n` 结构上抓不到）：用 `ls` 枚举文件再喂给程序消费。
# 为什么补：CI 侧 actionlint 因 `arts="$(ls -1 | wc -l)"` 把发布作业判红过一次
# （2026-09-27 run 36295599503，infra-lint `SC2012:info`）——本机探针当时 28/28 全绿，
# 说明上一轮立的"本地时机腿"只补了解析级，**没覆盖"能跑但 CI 不认"那一层**。
# 两条豁免是必需的，否则会造出自指假命中：`git ls-files` 本身就是被推荐的替代写法；
# 注释行不得参与扫描（本文件正文里就写着"计数一律走 find 不走 ls"）。
LS_ENUM = re.compile(r"(?:\$\(\s*ls\b|\bls\b[^|;\n]*\|)")
GIT_LS = re.compile(r"\bgit\s+ls\b")
NL = "\n"


def find_bash() -> str:
    r"""Windows 实测坑：subprocess 起的裸 `bash` 会解析到 **WSL 的 bash**（rc=127，且把
    `C:\Users\...` 吞成 `C:Users...`），于是合规脚本被报成语法错。故显式优先 Git Bash，
    再退 PATH，最后必须真跑一次 `exit 0` 验它可用。"""
    cands = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"]
    w = shutil.which("bash")
    if w:
        cands.append(w)
    for c in cands:
        if not c or not os.path.exists(c):
            continue
        try:
            r = subprocess.run([c, "-c", "exit 0"], capture_output=True)
        except OSError:
            continue
        if r.returncode == 0:
            return c
    return ""


def extract_blocks(text: str) -> list[tuple[int, str]]:
    """从 YAML 抽出所有 `run:` 的 shell 文本。返回 [(起始行号, 脚本正文)]。

    两式都抽：块标量（`run: |`／`run: >-`，正文按块缩进减两级）与内联标量（`run: python x`）。
    内联式只脱外层成对引号，不做其它解释——判据要对齐的是 runner 实际喂给 shell 的那串字。
    """
    lines = text.split(NL)
    out: list[tuple[int, str]] = []
    i = 0
    while i < len(lines):
        m = BLOCK_RE.match(lines[i])
        if m:
            indent = len(m.group(1))
            j, body = i + 1, []
            while j < len(lines):
                ln = lines[j]
                if ln.strip() == "":
                    body.append("")
                    j += 1
                    continue
                if len(ln) - len(ln.lstrip()) <= indent:
                    break
                body.append(ln[indent + 2:])
                j += 1
            out.append((i + 1, NL.join(body).rstrip(NL)))
            i = j
            continue
        mi = INLINE_RE.match(lines[i])
        if mi:
            val = mi.group(2)
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            if val and not val.startswith("#"):
                out.append((i + 1, val))
        i += 1
    return out


def probe(script: str, tmpdir: str, key: str, bash: str) -> list[str]:
    """问题清单（空＝这块没问题）。bash 不可用时只跑启发式腿，绝不假红。"""
    issues: list[str] = []
    if bash:
        f = os.path.join(tmpdir, f"blk_{key}.sh")
        with open(f, "w", encoding="utf-8", newline=NL) as fh:
            fh.write(script + NL)
        r = subprocess.run([bash, "-n", f], capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            tail = (r.stderr or r.stdout).strip()[:160]
            issues.append(f"bash -n rc={r.returncode}: {tail}")
    for k, ln in enumerate(script.split(NL), 1):
        s = ln.strip()
        # 整行注释一律跳过两条启发式腿：shell 不解析注释文本，shellcheck 也不会因注释报 SC1073。
        # 不跳的后果实测过：第四十二轮我给 release.yml 写的一条注释（内含 `$(…)` 与全角括号）
        # 被本探针判成 FAIL——扫描器命中了被匹配串自己的说明文字（同族自指假命中）。
        # 解析级那条腿不受影响：`bash -n` 看的是整块，注释真把引号/缩进搞坏了它照样红。
        if s.startswith("#"):
            continue
        if "$(" in ln and FULLWIDTH.search(ln):
            issues.append(f"L{k}: 命令替换内含全角标点（shellcheck 解析器会当场顶死）:: {ln.strip()[:90]}")
        # 第二条豁免见模块头 LS_ENUM 上方注释：`git ls-files` 本身就是被推荐的替代写法。
        if GIT_LS.search(ln):
            continue
        if LS_ENUM.search(ln):
            issues.append(f"L{k}: shellcheck SC2012 形态（用 ls 枚举文件喂给程序，改用 find）:: {s[:90]}")
    return issues


def selftest(tmpdir: str) -> int:
    good = 'BASE="https://x"\nH="$(curl -s "$U")" || H=""\necho "$H"'
    bad_parse = 'if [ -z "$X" ; then\necho hi\n'
    bad_width = 'echo "- health: $(curl -s "$U" || echo 取不到（连接层失败）)"'
    bad_ls_pipe = 'arts="$(ls -1 | wc -l)"\necho "n=$arts"'
    bad_ls_for = 'for f in $(ls dist-release); do echo "$f"; done'
    good_ls = ('n=$(git ls-files "*.md" | wc -l)\n'
               'arts="$(find . -maxdepth 1 -type f | wc -l)"\nls -1\n')
    cases = [
        ("合规块必须零问题", good, False),
        ("真语法错必须被抓", bad_parse, True),
        ("命令替换内全角括号必须被抓（本轮事故形态）", bad_width, True),
        ("ls 管道计数必须被抓（CI 判红形态 run 36295599503）", bad_ls_pipe, True),
        ("$(ls) 喂 for 循环必须被抓", bad_ls_for, True),
        ("git ls-files / find / 裸 ls 展示 不得误报（反向腿）", good_ls, False),
        ("整行注释含 $(…) 与全角括号不得误报（注释豁免反向腿）",
         '# 注释里写 echo "$(取不到（连接层失败）)" 只是说明文字\nn=1\necho "$n"\n', False),
        ("内联 run 的专属输入面：全角括号写进内联式也必须被抓（证明新射程真被判定）",
         'run: echo "$(取不到（连接层失败）)"\n', True),
    ]
    bash = find_bash()
    print(f"  INFO bash={bash if bash else '不可用（语法腿跳过，只跑启发式）'}")
    bad = 0
    skipped = 0
    for i, (name, src, want_issue) in enumerate(cases):
        if not bash and want_issue and name == "真语法错必须被抓":
            print(f"  SKIP {name} :: 本机无可用 bash，语法腿不判")
            skipped += 1
            continue
        got = probe(src, tmpdir, f"st{i}", bash)
        ok = bool(got) == want_issue
        bad += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'} {name} :: 有问题={bool(got)} 期望={want_issue} {got[:1]}")
    # 抽取器分母自证：块标量与内联标量**都**要抽到（v1.41.0 实测原抽取器只认 `run: |`，
    # 加了一条内联步而分母纹丝不动 ⇒ 分母自证必须把两式都摆进夹具，否则"看不见"与"没发生"同形）
    yaml = ("steps:\n  - name: a\n    run: |\n      echo a\n"
            "  - name: b\n    run: |\n      echo b\n      echo c\n"
            "  - name: c\n    run: python scripts/x.py --selftest\n"
            "  - name: d\n    run: >-\n      echo folded\n")
    got_blocks = extract_blocks(yaml)
    n = len(got_blocks)
    print(f"  {'PASS' if n == 4 else 'FAIL'} 抽取器分母（2 块标量＋1 内联＋1 折叠 = 4）:: 实测={n}")
    bad += 0 if n == 4 else 1
    inline_hit = any("scripts/x.py" in body for _ln, body in got_blocks)
    print(f"  {'PASS' if inline_hit else 'FAIL'} 内联 run 真被抽到（不是只多了行数）:: 命中={inline_hit}")
    bad += 0 if inline_hit else 1
    bad_inline = probe('echo "$(取不到（连接层失败）)"', tmpdir, "st_inline_bad", bash) if bash else []
    if bash:
        print(f"  {'PASS' if bad_inline else 'FAIL'} 内联面的坏样本必须被抓（专属输入面）:: {bad_inline[:1]}")
        bad += 0 if bad_inline else 1
    else:
        print("  SKIP 内联坏样本 :: 本机无 bash，语法腿不判")
        skipped += 1
    ran = len(cases) + 3 - skipped
    print(f"SELFTEST: {ran - bad}/{ran}")
    print("[GATE:shell-probe-selftest-pass]" if bad == 0 else "[GATE:shell-probe-selftest-fail]")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflows", default=".github/workflows")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="shellprobe_")
    if a.selftest:
        return selftest(tmp)
    root = Path(a.workflows)
    files = sorted(root.glob("*.yml")) + sorted(root.glob("*.yaml"))
    bash = find_bash()
    total, problems = 0, []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            src = fh.read()
        for start, body in extract_blocks(src):
            total += 1
            tag = f"{f.stem}_{start}"
            problems += [f"{f}:{start}: {m}" for m in probe(body, tmp, tag, bash)]
    print(f"== 工作流 run 块语法探针（取数面={a.workflows}，文件={len(files)}，块={total}，"
          f"bash={'可用' if bash else '不可用⇒只跑全角启发式'}）==")
    for p in problems:
        print(f"  FAIL {p}")
    if total == 0:
        print("EMPTY :: 一个 run 块都没抽到＝抽取器或取数面坏了，判据不许记绿")
        print("[GATE:shell-probe-empty]")
        return 2
    if problems:
        print(f"[GATE:shell-probe-fail] {len(problems)} 处（分母={total} 块）")
        return 1
    print(f"[GATE:shell-probe-pass] {total}/{total} 块通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
