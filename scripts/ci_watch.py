#!/usr/bin/env python3
"""push 后 CI 结果观察器（第二十一轮）——把"推完就得人肉刷网页"变成一条可脚本化的取数。

为什么存在：本仓的验收口径是「远端可见才算完成」（附注 tag 是否推上去、run 是否绿、Release 资产是否挂上），
此前每一步都要手敲 `gh run list` + `gh run view --log-failed` 再看一眼。脚本化之后，它可以被
IDE 的 post-execution hook 直接调用（配置见 CONTRIBUTING「CI 观察钩子（可选）」），把失败面原文回灌给 Agent。

设计约束（都是本仓踩过的坑）：
- 拿不到数据一律 **非零退出并打印原因**，绝不"无 run ⇒ 通过"（静默空结果＝假通过）。
- run 创建有延迟：未观察到的 run 用轮询等待，超时才判 UNKNOWN，不在第一轮就下结论。
- 只读：不改仓库、不重跑、不注释 PR；写操作留给人（或显式 `--rerun-failed`，默认关闭）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from typing import Any

# 部署作业在本仓按设计是 skipped（AUTO_DEPLOY 未开），skipped 不是失败
GREEN = {"success", "skipped", "neutral"}
RED = {"failure", "timed_out", "cancelled", "startup_failure", "stale"}


def run_gh(args: list[str], timeout: int = 90) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["gh", *args], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
    except FileNotFoundError:
        return 127, "", "gh 不在 PATH 上"
    except subprocess.TimeoutExpired:
        return 124, "", f"gh {' '.join(args[:2])} 超时 {timeout}s"
    return p.returncode, p.stdout or "", p.stderr or ""


def list_runs(sha: str, limit: int = 20) -> list[dict[str, Any]]:
    rc, out, err = run_gh(["run", "list", "-L", str(limit), "--json",
                           "databaseId,workflowName,headBranch,event,status,conclusion,url,headSha"])
    if rc != 0:
        raise RuntimeError(f"gh run list 失败 rc={rc}: {err.strip()[:200]}")
    rows = json.loads(out or "[]")
    return [r for r in rows if str(r.get("headSha", "")).startswith(sha)]


def failing_detail(run_id: int) -> str:
    rc, out, _ = run_gh(["run", "view", str(run_id), "--json", "jobs",
                         "--jq", '[.jobs[] | select(.conclusion=="failure") | .name] | join(" | ")'], timeout=60)
    jobs = out.strip() if rc == 0 else "?"
    rc2, log, _ = run_gh(["run", "view", str(run_id), "--log-failed"], timeout=120)
    if rc2 != 0:
        return f"失败作业=[{jobs}]（日志取回 rc={rc2}）"
    keep = [ln.split("\t")[-1].strip() for ln in log.splitlines()
            if any(k in ln for k in ("::error::", "FAIL", "Traceback", "error:", "Error:", "npm ERR!", "rc=1"))]
    first = keep[0][:200] if keep else "（日志里没匹配到错误行，看完整日志）"
    return (f"失败作业=[{jobs}]\n"
            f"      首条错误: {first}\n"
            f"      错误行数={len(keep)}（全文：gh run view {run_id} --log-failed）")


def poll_runs(sha: str, wait: float, interval: float, expect: int,
              fetch, sleep=time.sleep, clock=time.time):
    """轮询到「有 run 且全部收尾」为止；返回最后一次观察到的 rows（可能为空）。

    🔴 空集与"都完成了"必须分开（第二十五轮修的缺陷）：旧实现是
    `if not pending or time >= deadline: break`，而 rows 为空时 pending 也为空 ⇒ 条件恒真，
    第一次查询就退出。后果是「刚推完、GitHub 还没建出 run」这一**最常见**情形直接落 UNKNOWN，
    实测 v1.23.0 三条 run 全 success 而本脚本报"未观察到任何 run"。
    方向上它不产假绿（安全），但工具恰好在它最该生效的时刻失效——
    而且与本文件 docstring 第 10 行自己写的「不在第一轮就下结论」直接矛盾（承诺在文档、实现在另一条路）。
    """
    deadline = clock() + wait
    rows: list[dict[str, Any]] = []
    while True:
        rows = fetch(sha)
        pending = [r for r in rows if r.get("status") != "completed"]
        if rows and expect and len(rows) < expect:
            pending.append({"workflowName": f"<期待 {expect} 条，只见 {len(rows)} 条>"})
        if rows and not pending:
            return rows
        if clock() >= deadline:
            return rows
        sleep(max(0.01, interval))


def selftest() -> int:
    """离线自证三态，全部注入假 fetch，不打网络也不碰 gh。"""
    fails = 0

    def case(name, got, want):
        nonlocal fails
        ok = got == want
        print(f"  {'PASS' if ok else 'FAIL'} {name}（实得 {got!r} 期望 {want!r}）")
        if not ok:
            fails += 1

    def mk(status, conclusion, n=1, sha="abc"):
        return [{"workflowName": f"w{i}", "status": status, "conclusion": conclusion,
                 "headSha": sha} for i in range(n)]

    t = [0.0]

    def clock():
        return t[0]

    def advance_sleep(sec):
        t[0] += max(0.01, sec)

    # ① 空集→必须持续轮询到 deadline 才罢手，并且返回空（让上层判 UNKNOWN），不许第一轮就退
    calls = {"n": 0}

    def always_empty(_sha):
        calls["n"] += 1
        return []

    t[0] = 0.0
    out = poll_runs("abc", wait=10, interval=2, expect=0, fetch=always_empty,
                    sleep=advance_sleep, clock=clock)
    case("空集时按 deadline 轮询（查询次数 ≥5 而非 1）", calls["n"] >= 5, True)
    case("空集最终仍返回空集（上层据此判 UNKNOWN）", out, [])

    # ② 先空后有 → 必须"等到"而不是错过（真实推送后的时序）
    seq = {"i": 0}

    def empty_then_done(_sha):
        seq["i"] += 1
        return [] if seq["i"] < 3 else mk("completed", "success")

    t[0] = 0.0
    got = poll_runs("abc", wait=30, interval=1, expect=0, fetch=empty_then_done,
                    sleep=advance_sleep, clock=clock)
    case("run 延迟出现时能等到（第 3 次才有）", len(got), 1)

    # ③ 有 run 且仍 in_progress → 继续等；转 success 才返回
    st = {"i": 0}

    def pending_then_green(_sha):
        st["i"] += 1
        return mk("in_progress", None) if st["i"] < 2 else mk("completed", "success")

    t[0] = 0.0
    got3 = poll_runs("abc", wait=30, interval=1, expect=0, fetch=pending_then_green,
                     sleep=advance_sleep, clock=clock)
    case("未收尾时不提前返回", got3[0]["status"], "completed")

    # ④ expect 未满足 → 不许因为"已有的几条都绿了"就返回
    t[0] = 0.0
    got4 = poll_runs("abc", wait=6, interval=2, expect=3,
                     fetch=lambda _s: mk("completed", "success", n=2),
                     sleep=advance_sleep, clock=clock)
    case("expect=3 而只见 2 条时按 deadline 等满", len(got4), 2)
    print(f"\n{'[GATE:ci-watch-selftest-pass]' if fails == 0 else f'[GATE:ci-watch-selftest-fail] {fails}'}")
    return 0 if fails == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="观察某次提交在 GitHub Actions 上的结果（只读）")
    ap.add_argument("--selftest", action="store_true", help="离线自证轮询三态（不联网、不调 gh）")
    ap.add_argument("--sha", default="", help="要观察的提交（短或长 sha），默认取本机 HEAD")
    ap.add_argument("--expect", type=int, default=0, help="至少要观察到几条 run（0=有几条算几条）")
    ap.add_argument("--wait", type=int, default=0, metavar="秒", help="等待全部 run 收尾的总时长，0=只看当前")
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON（供 hook 消费）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    sha = args.sha
    if not sha:
        p = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True)
        if p.returncode != 0:
            print(f"取 HEAD 失败: {p.stderr.strip()[:120]}", file=sys.stderr)
            return 2
        sha = p.stdout.strip()
    full = sha
    if len(sha) < 40:
        p = subprocess.run(["git", "rev-parse", sha], capture_output=True, text=True)
        full = p.stdout.strip() if p.returncode == 0 else sha

    def fetch(key: str) -> list[dict[str, Any]]:
        return list_runs(key)

    # 轮询逻辑收进 poll_runs——它同时被 --selftest 离线验过；
    # main 里不留第二份实现（否则"改了一份、另一份还带着老 bug"就是本条缺陷的复发路径）。
    try:
        rows = poll_runs(full[:10] if len(full) == 40 else sha,
                         wait=args.wait, interval=args.interval, expect=args.expect, fetch=fetch)
    except RuntimeError as e:
        print(f"取数失败：{e}", file=sys.stderr)
        return 2

    if not rows:
        # 关键：一条 run 都没看到 ≠ 通过。最常见原因是 tag 是轻量的没推上去，或推的根本不是这个提交。
        print(f"UNKNOWN 未观察到 {sha[:10]} 的任何 run"
              f"（已轮询 {args.wait}s；推了吗？是附注 tag 吗？gh 登录的是这个仓库吗？）", file=sys.stderr)
        return 2

    bad = [r for r in rows if r.get("conclusion") in RED]
    unfinished = [r for r in rows if r["status"] != "completed"]
    report = {
        "sha": full[:10], "runs": len(rows),
        "green": [r["workflowName"] for r in rows if r.get("conclusion") in GREEN],
        "failed": [{"id": r["databaseId"], "name": r["workflowName"], "url": r["url"]} for r in bad],
        "unfinished": [r["workflowName"] for r in unfinished],
        "verdict": "FAIL" if bad else ("PENDING" if unfinished else "PASS"),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(f"== CI 观察 @ {report['sha']}（run={report['runs']}）==")
        for r in rows:
            mark = "PASS" if r.get("conclusion") in GREEN else ("PEND" if r["status"] != "completed" else "FAIL")
            print(f"  {mark:4s} {r['workflowName']} :: {r['status']}/{r.get('conclusion') or '-'}")
        for f in report["failed"]:
            print(f"  -- {f['name']} (run {f['id']})")
            for ln in failing_detail(f["id"]).splitlines():
                print("    " + ln)
            print(f"     {f['url']}")
        if report["unfinished"]:
            print(f"  仍未收尾：{report['unfinished']}（未到 --wait 上限，别当通过）")
        print(f"[GATE:ci-watch-{'pass' if report['verdict'] == 'PASS' else 'fail'}] 判定={report['verdict']}")
    if bad:
        return 1
    if unfinished:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
