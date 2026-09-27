#!/usr/bin/env python3
"""工作流 `run:` 块的本地语法探针（第四十轮 SC1073 事故的对应强化）。

为什么要有它（实测，不是推测）：本轮我为"失败路径"写的诊断 run 块把全角括号放进了命令替换
（形如 `$(curl … || echo 取不到（连接层失败）)`）⇒ CI 侧 actionlint 报
`shellcheck SC1073: Couldn't parse this command expansion`，`infra-lint` 判红；
而**同一时刻 Release 已经发出去了**（台账 #47）。本机为什么拦不住：`docker info` 报 daemon 不在、
`shellcheck`/`actionlint` 不在 PATH。`bash -n` 是本机跑得动的那一半，这条探针只做那一半，
**不冒充 actionlint**：解析级的红在提交前就看见，风格级判据仍留在 CI 侧（差距如实留档）。

三态输出（零输入绝不记绿，见 memory「零输入不得记 PASS」）：
  FAIL    某个 run 块 bash -n 不过，或命令替换里含全角标点（本轮 shellcheck 的致命形态）
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

BLOCK_RE = re.compile(r"^(\s*)run: \|\s*$")
FULLWIDTH = re.compile(r"[（）【】：；，]")
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
    """从 YAML 抽出 `run: |` 的字面块正文（按块缩进减两级）。返回 [(起始行号, 脚本正文)]。"""
    lines = text.split(NL)
    out: list[tuple[int, str]] = []
    i = 0
    while i < len(lines):
        m = BLOCK_RE.match(lines[i])
        if not m:
            i += 1
            continue
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
        if "$(" in ln and FULLWIDTH.search(ln):
            issues.append(f"L{k}: 命令替换内含全角标点（shellcheck 解析器会当场顶死）:: {ln.strip()[:90]}")
    return issues


def selftest(tmpdir: str) -> int:
    good = 'BASE="https://x"\nH="$(curl -s "$U")" || H=""\necho "$H"'
    bad_parse = 'if [ -z "$X" ; then\necho hi\n'
    bad_width = 'echo "- health: $(curl -s "$U" || echo 取不到（连接层失败）)"'
    cases = [
        ("合规块必须零问题", good, False),
        ("真语法错必须被抓", bad_parse, True),
        ("命令替换内全角括号必须被抓（本轮事故形态）", bad_width, True),
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
    # 抽取器分母自证：含 2 个 run 块的 YAML 必须正好抽到 2
    # （真实形态是 `- name:` 换行后才写 `run: |`；写成 `- run: |` 抽不到，首版夹具就错过在这里）
    yaml = "steps:\n  - name: a\n    run: |\n      echo a\n  - name: b\n    run: |\n      echo b\n      echo c\n"
    n = len(extract_blocks(yaml))
    print(f"  {'PASS' if n == 2 else 'FAIL'} 抽取器分母（2 块输入须抽到 2）:: 实测={n}")
    bad += 0 if n == 2 else 1
    ran = len(cases) + 1 - skipped
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
