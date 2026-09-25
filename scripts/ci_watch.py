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


def main() -> int:
    ap = argparse.ArgumentParser(description="观察某次提交在 GitHub Actions 上的结果（只读）")
    ap.add_argument("--sha", default="", help="要观察的提交（短或长 sha），默认取本机 HEAD")
    ap.add_argument("--expect", type=int, default=0, help="至少要观察到几条 run（0=有几条算几条）")
    ap.add_argument("--wait", type=int, default=0, metavar="秒", help="等待全部 run 收尾的总时长，0=只看当前")
    ap.add_argument("--interval", type=int, default=20)
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON（供 hook 消费）")
    args = ap.parse_args()

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

    deadline = time.time() + args.wait
    rows: list[dict[str, Any]] = []
    while True:
        try:
            rows = list_runs(full[:10] if len(full) == 40 else sha)
        except RuntimeError as e:
            print(f"取数失败：{e}", file=sys.stderr)
            return 2
        pending = [r for r in rows if r["status"] != "completed"]
        if rows and args.expect and len(rows) < args.expect:
            pending.append({"workflowName": f"<期待 {args.expect} 条，只见 {len(rows)} 条>"})
        if not pending or time.time() >= deadline:
            break
        time.sleep(max(5, args.interval))

    if not rows:
        # 关键：一条 run 都没看到 ≠ 通过。最常见原因是 tag 是轻量的没推上去，或推的根本不是这个提交。
        print(f"UNKNOWN 未观察到 {sha[:10]} 的任何 run（推了吗？是附注 tag 吗？gh 登录的是这个仓库吗？）", file=sys.stderr)
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
