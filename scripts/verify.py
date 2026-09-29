#!/usr/bin/env python3
"""验证统一入口（第四十三轮；对标 `bloodworks-io/phlox` 的 Makefile 形态）。

为什么不用 Make：本机实测 `which make` 与 `which mingw32-make` **双双 not found**
⇒ 写一份"我这台机器跑不了"的入口，正是本仓立规要治的形态（配置能力需要行为回执）。

为什么要它：README / CONTRIBUTING / docs/PITFALLS.md §F 曾各抄一份命令清单，抄件必然过期
（台账 #106/#51 同族；第四十二轮报告 §4 又抄了一次）。本文件把"跑什么"收敛成**一处声明＋一条命令**，
文档只写 `python scripts/verify.py --suite gate`。

四条设计约束（都是本仓既有铁律，不是新发明）：
  ① **只编排不复制判据**：每步都调用既有载体（pre-commit / npm / 各 gate 脚本），
     本文件里没有一条业务断言，避免制造第二真值；
  ② **先红的不许吞掉后面的**：全部步骤跑完再汇总，失败不提前 exit
     （feedback-judges-must-report-independently）；
  ③ **零输入不记绿**：套件取到 0 步 ⇒ rc=2 EMPTY；步骤引用的脚本不存在 ⇒ 判 FAIL 并点名，
     而不是让 subprocess 抛 FileNotFoundError 把整轮变成"崩了"；
  ④ **跨仓步骤取不到就记 SKIPPED**（不是 PASS 也不是 FAIL）：`cwd=".."` 的步骤属于工作区父仓
     （参赛交付门禁），外部 clone 没有父仓——那是"没测到"，不是"测出问题"。

退出码：0 全通过（含 SKIPPED）/ 1 有步骤失败 / 2 取数面坏（空套件）。
"""
from __future__ import annotations

import argparse
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (id, 说明, cwd（相对仓根，".." 表示工作区父仓）, 命令, 超时秒)
SUITES: dict[str, list[tuple[str, str, str, str, int]]] = {
    "static": [
        ("pre-commit", "全部本地门禁（钩数唯一源 = .pre-commit-config.yaml）", ".",
         "pre-commit run --all-files", 900),
    ],
    "test": [
        ("npm-test", "前端 26 套件（含 docs_link_guard / version_guard / sbom_guard 等）", "frontend",
         "npm test", 900),
        ("backend-selftest", "FastAPI 镜像面自证（套件清单唯一源 backend/selftest.py）", ".",
         "python backend/selftest.py", 300),
        ("docker-context", "构建上下文卫生（垃圾类须被 .dockerignore 覆盖）", ".",
         "python scripts/docker_context_guard.py --quiet", 120),
        ("shell-probe", "工作流 run 块本机探针（解析级 + 已枚举 shellcheck 形态）", ".",
         "python scripts/shell_block_probe.py", 180),
    ],
    "browser": [
        ("e2e", "双视口浏览器回归（Playwright，需已装浏览器）", "frontend",
         "npm run test:e2e", 1200),
    ],
    "delivery": [
        ("freeze-check", "交付口径检查（工作区父仓 work/freeze_check.mjs；检数=本步末行 OVERALL 的 n/n，不在此抄）", "..",
         "node work/freeze_check.mjs", 600),
        ("delivery-consistency", "交付副本对账（工作区父仓）", "..",
         "python work/check_delivery_consistency.py", 600),
    ],
}
# all 不含 browser：E2E 需要本机装过 Playwright 浏览器，默认链里塞进来会让没装的人第一步就红
# （假红比没判据更糟，同族禁令）；CI 侧有专门作业跑它。
# delivery 组的时机面（v1.41.0 实测）：这两步读的是**已发布交付物**，而版本面（package.json/version.js/
# version.py/openapi.json）在打 tag 之前就先变成 1.41.0 ⇒ 未打 tag 时 `delivery_anchor` 必报
# "tag 在本仓不存在" rc=2。这是"先改版本、后发版"的固有顺序，不是缺陷，也**不许**为了让 all 变绿去
# 放宽那两步（它们判的正是"线上=仓内单一源"）⇒ 提交前跑 gate，发版之后再跑 all。
COMPOSE = {"quick": ["static"], "gate": ["static", "test"],
           "all": ["static", "test", "delivery"], "full": ["static", "test", "browser", "delivery"]}


def expand(name: str) -> list[tuple[str, str, str, str, int]]:
    if name in COMPOSE:
        out: list[tuple[str, str, str, str, int]] = []
        for s in COMPOSE[name]:
            out.extend(SUITES[s])
        return out
    return list(SUITES.get(name, []))


def referenced_files(steps) -> list[str]:
    """步骤命令里引用的仓内脚本必须真实存在（入口自己就是最容易烂的那一层）。"""
    miss = []
    for _sid, _desc, cwd, cmd, _t in steps:
        for tok in shlex.split(cmd):
            if "/" in tok and Path(tok).suffix in (".py", ".mjs", ".js", ".sh"):
                if not (ROOT / cwd / tok).resolve().exists() and not (ROOT / tok).exists():
                    miss.append(tok)
    return miss


def last_line(text: str) -> str:
    lines = [ln for ln in (text or "").replace("\r", "").split("\n") if ln.strip()]
    return lines[-1][:170] if lines else "无输出"


def run_steps(steps, fail_fast: bool) -> list[tuple[str, str, str]]:
    """返回 [(id, PASS|FAIL|SKIP, 证据行)]；不抛异常——可执行文件缺失也是一行 FAIL。"""
    res: list[tuple[str, str, str]] = []
    for sid, desc, cwd, cmd, tmo in steps:
        wd = (ROOT / cwd).resolve()
        print(f"\n--- {sid} :: {desc}")
        if not wd.exists():
            res.append((sid, "SKIP", f"工作目录不存在：{wd}（跨仓步骤，本 clone 没有父工作区）"))
            print("  SKIP 工作目录不存在：" + str(wd))
            continue
        argv = shlex.split(cmd)
        exe = shutil.which(argv[0])
        if not exe:
            res.append((sid, "FAIL", f"可执行文件不在 PATH：{argv[0]}"))
            print(f"  FAIL rc=127 :: 可执行文件不在 PATH：{argv[0]}")
            if fail_fast:
                break
            continue
        argv[0] = exe  # Windows 实测：npm 是 npm.cmd，不显式 which 会 FileNotFoundError ⇒ 假红
        try:
            r = subprocess.run(argv, cwd=str(wd), capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=tmo)
            rc = r.returncode
            note = last_line(r.stdout) if rc == 0 else (last_line(r.stderr) or last_line(r.stdout))
            out, err = r.stdout or "", r.stderr or ""
        except subprocess.TimeoutExpired:
            rc, note, out, err = 124, f"超时 >{tmo}s", "", ""
        except OSError as e:  # 起进程本身失败：记 FAIL，绝不让它把整轮崩掉
            rc, note, out, err = 126, f"启动失败：{e}", "", ""
        tag = "PASS" if rc == 0 else "FAIL"
        print(f"  {tag} rc={rc} :: {note}")
        if rc != 0:
            # 失败时把两条流各截一段打出来。只打 stderr 末行会掩盖真错（本轮 npm 就是被一条
            # `npm warn` 顶掉了判据行）——证据格式化属于判据的一部分，它不全等于判据没说清为什么红。
            for label, blob in (("stdout", out), ("stderr", err)):
                tail = [ln for ln in blob.splitlines() if ln.strip()][-12:]
                if tail:
                    print(f"    ~ {label} 末 {len(tail)} 行：")
                    for ln in tail:
                        print("      " + ln[:180])
        res.append((sid, tag, f"rc={rc} {note}"))
        if rc != 0 and fail_fast:
            break
    return res


def selftest() -> int:
    cases = []
    cases.append(("all 套件须 ≥5 步（空＝编排表被改坏）", len(expand("all")) >= 5))
    cases.append(("套件名拼错 ⇒ expand 返回空 ⇒ 主流程走 EMPTY 而不是 0", expand("nope") == []))
    cases.append(("引用文件检查能抓到不存在的脚本",
                  referenced_files([("x", "d", ".", "python scripts/__no_such__.py", 5)])
                  == ["scripts/__no_such__.py"]))
    cases.append(("引用文件检查不得误报真实脚本（反向腿）",
                  referenced_files([("x", "d", ".", "python scripts/docker_context_guard.py", 5)]) == []))
    cases.append(("PATH 里没有的解释器 ⇒ 记 FAIL 而不是抛异常",
                  any(t == "FAIL" for _i, t, _n in
                      run_steps([("ghost", "不存在的可执行", ".", "__no_such_exe__ --version", 10)], False))))
    ok = last_line("")
    cases.append(("last_line 空输入返回字符串而不是崩", isinstance(ok, str) and ok == "无输出"))
    bad = sum(0 if ok2 else 1 for _n, ok2 in cases)
    for name, ok2 in cases:
        print(f"  {'PASS' if ok2 else 'FAIL'} {name}")
    print(f"SELFTEST: {len(cases) - bad}/{len(cases)}")
    print("[GATE:verify-selftest-pass]" if bad == 0 else "[GATE:verify-selftest-fail]")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", default="gate", help="quick|gate|all|full|static|test|browser|delivery")
    ap.add_argument("--only", action="append", default=[], help="只跑指定步骤 id（可重复）")
    ap.add_argument("--fail-fast", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    steps = expand(a.suite)
    if a.only:
        wanted = set(a.only)
        steps = [s for s in steps if s[0] in wanted]
    if not steps:
        print(f"EMPTY :: 套件 {a.suite!r} 取到 0 步 ⇒ 编排表或参数坏了，不许记绿")
        print("[GATE:verify-empty]")
        return 2
    missing = referenced_files(steps)
    if missing:
        print("FAIL :: 入口指向不存在的脚本（文档漂移的早期形态）：" + ", ".join(missing))
        print("[GATE:verify-fail]")
        return 1
    print(f"== verify 统一入口 :: suite={a.suite} 步数={len(steps)} ==")
    res = run_steps(steps, a.fail_fast)
    fails = [r for r in res if r[1] == "FAIL"]
    skips = [r for r in res if r[1] == "SKIP"]
    print(f"\n===== 汇总（{len(res)} 步 / 失败 {len(fails)} / 跳过 {len(skips)}）=====")
    for sid, tag, note in res:
        print(f"  {tag:<5} {sid:<18} {note[:100]}")
    if fails:
        print("[GATE:verify-fail] 失败步骤：" + ", ".join(f[0] for f in fails))
        return 1
    if skips:
        print(f"[GATE:verify-pass] {len(res) - len(skips)}/{len(res)} 步通过，"
              f"{len(skips)} 步 SKIP（未测到，不是通过）：{', '.join(s[0] for s in skips)}")
        return 0
    print(f"[GATE:verify-pass] {len(res)}/{len(res)} 步通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
