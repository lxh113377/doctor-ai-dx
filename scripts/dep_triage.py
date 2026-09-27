#!/usr/bin/env python
"""上游反馈闭环判据：开放中的 Dependabot PR 不得无人处置地发霉（第二十三轮）。

对标取证（2026-09-26 实测）：`openemr/openemr` 有 `dependabot-auto-merge.yml`（过全部门禁的依赖
PR 自动合并），我方 `.github/dependabot.yml` 三个生态都开了，却**从不消费它的产出**——本轮开跑时
仓里正挂着三张 9/24 起没人动过的 PR（#12 / #19 / #20）。开了机器人不等于做了维护；这一条与
r19「门禁挂在长期 skipped 的 deploy 作业 = 没有门禁」同族，只是方向相反：产出侧没人接。

为什么不做"自动合并"：本仓三张产品红线 + 8s 单模型硬超时 + 交付包逐字节对账，依赖 major 升版
必须过 Playwright 双视口与 bundle/fhir 判据（本轮 #12/#20 的实测结论就是"单张不可构建、成对才解析"），
所以取「超龄即判红 + 每张必须有分诊痕迹」而不是「绿了就合」。

用法：
  python scripts/dep_triage.py                # 判据（CI 定时作业；需 GITHUB_TOKEN）
  python scripts/dep_triage.py --selftest     # 反例自证（零网络）
退出码：0 无逾期且都有痕迹 / 1 有逾期或漏分诊 / 2 环境错误（API 取不到＝不判绿，禁止"没查到"当"没有"）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
FIXTURE = REPO / "frontend" / "tests" / "fixtures" / "dep_triage.json"
API = "https://api.github.com"


def load_cfg() -> dict[str, Any]:
    if not FIXTURE.is_file():
        print(f"[GATE:dep-triage-fail] 阈值文件缺失：{FIXTURE}", file=sys.stderr)
        raise SystemExit(2)
    cfg = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if not isinstance(cfg.get("max_age_days"), int) or cfg["max_age_days"] < 1:
        print("[GATE:dep-triage-fail] max_age_days 非法（必须为 ≥1 的整数）", file=sys.stderr)
        raise SystemExit(2)
    if not isinstance(cfg.get("marker"), str) or len(cfg["marker"]) < 6:
        print("[GATE:dep-triage-fail] marker 非法（太短的分诊标记会被正文里任意文本撞中）", file=sys.stderr)
        raise SystemExit(2)
    return cfg


def token() -> str:
    env = os.environ.get("GITHUB_TOKEN")
    if env:
        return str(env).strip()
    try:
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def gh_get(path: str, tok: str) -> Any:
    """返回解析后的 JSON；任何失败返回 None（调用方必须判环境错误而不是"没有 PR"）。"""
    req = urllib.request.Request(f"{API}{path}", headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "doctor-ai-dx-dep-triage",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        return None


def fetch_pending(repo_slug: str, tok: str) -> list[dict[str, Any]] | None:
    """开放中的 Dependabot PR + 各自的评论与标签。None＝取不到上游。"""
    pulls = gh_get(f"/repos/{repo_slug}/pulls?state=open&per_page=100", tok)
    if not isinstance(pulls, list):
        return None
    out: list[dict[str, Any]] = []
    for pr in pulls:
        if not isinstance(pr, dict) or (pr.get("user") or {}).get("login") != "dependabot[bot]":
            continue
        number = pr.get("number")
        comments = gh_get(f"/repos/{repo_slug}/issues/{number}/comments?per_page=100", tok)
        if comments is None:
            return None
        out.append({
            "number": number,
            "title": str(pr.get("title")),
            "created_at": str(pr.get("created_at")),
            "updated_at": str(pr.get("updated_at")),
            "base": str((pr.get("base") or {}).get("ref")),
            "bodies": [str(c.get("body") or "") for c in comments if isinstance(c, dict)],
            "labels": [str((lbl or {}).get("name")) for lbl in (pr.get("labels") or [])],
        })
    return out


def evaluate(pending: list[dict[str, Any]], cfg: dict[str, Any], now: datetime) -> list[tuple[str, bool, str]]:
    marker = str(cfg["marker"])
    limit = int(cfg["max_age_days"])
    stale: list[str] = []
    untriaged: list[str] = []
    for pr in pending:
        try:
            created = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
        except (KeyError, ValueError):
            stale.append(f"#{pr.get('number')} created_at 不可解析（判据不能因脏数据而放行）")
            continue
        age = (now - created).days
        has_marker = any(marker in b for b in pr["bodies"]) or any(marker in lbl for lbl in pr["labels"])
        flag = f"#{pr['number']} {age}天 · {pr['title'][:48]}"
        if age > limit:
            stale.append(f"{flag}（>{limit} 天未处置）")
        if not has_marker:
            untriaged.append(f"{flag}（缺分诊标记 {marker}）")
    return [
        (f"开放 Dependabot PR 均不超过 {limit} 天", not stale, "; ".join(stale) or "无"),
        ("每张开放 PR 都有分诊痕迹（评论或标签带 marker）", not untriaged, "; ".join(untriaged) or "无"),
    ]


def _pr(n: int, days: int, marked: bool, now: datetime) -> dict[str, Any]:
    """造一条开放 PR 样本：days 天前开的、评论里有没有分诊标记。"""
    ts = (now - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"number": n, "title": f"bump dep {n}", "created_at": ts, "updated_at": ts, "base": "main",
            "bodies": ["本轮门禁实测结论 <!-- dep-triage:v1 -->"] if marked else ["chore: bump x"],
            "labels": []}


def permissions_block(text: str) -> str:
    """顶层 `permissions:` 段的正文（作业级 permissions 缩进更深，故意不取——本判据对的是全流默认面）。"""
    out, seen = [], False
    for ln in text.splitlines():
        if ln.startswith("permissions:"):
            seen = True
            continue
        if seen:
            if ln.startswith(" ") or not ln.strip():
                out.append(ln)
            else:
                break
    return "\n".join(out)


def summarize_ecosystems(prs: list[dict[str, Any]]) -> list[tuple[str, int, int]]:
    """按生态给出 dependabot PR 的「已合并／被关闭未合并」计数（advisory，不参与判定）。

    为什么要这条读数（第四十五轮一手实测）：本仓 dependabot PR 累计 17 张，**只有 2 张被合并**，
    其余 15 张被关闭——按生态看是 `github-actions 5/5 弃`、`pip 5/5 弃`、`npm 2 合 5 弃`。
    前两者是**结构性**的：pip 升级的唯一通道是 `uv pip compile` 重算锁（lock_guard 硬对账），
    而 dependabot 只改 requirements.txt；actions 侧我方把 `uses:` 钉到 commit SHA（r18），
    它提的是 tag 版本号——合了反而破坏供应链钉版。
    ⇒ "配置了三个生态"与"三个生态都在产出可用升级"不是一回事。这条读数每轮打印，
    让"哪个生态在制造噪音"不必等我某次想起来才看见；**它只报告，不改变判定与退出码**。
    """
    buckets: dict[str, list[int]] = {}
    for pr in prs:
        title = str(pr.get("title") or "")
        low = title.lower()
        if "actions/" in low:
            eco = "github-actions"
        elif "requirement from" in low or "in /backend" in low:
            eco = "pip"
        else:
            eco = "npm"
        merged = bool(pr.get("merged_at"))
        b = buckets.setdefault(eco, [0, 0])
        b[0 if merged else 1] += 1
    return sorted((eco, m, d) for eco, (m, d) in buckets.items())


def fetch_all_states(repo_slug: str, tok: str) -> list[dict[str, Any]] | None:
    """取 dependabot 的全部 PR（含已关闭）只为算生态读数；取不到返回 None，调用侧 fail-open。"""
    data = gh_get(f"/repos/{repo_slug}/pulls?state=all&per_page=100", tok)
    if not isinstance(data, list):
        return None
    return [p for p in data if isinstance(p, dict) and str((p.get("user") or {}).get("login")) == "dependabot[bot]"]


def check_workflow_pairing(workflow_text: str) -> tuple[bool, str]:
    """配对判据（第四十五轮）：本脚本**要读的 API** ⇄ **工作流声明的权限**，加上"有没有会真触发的通路"。

    一手起因（实测）：`gh api …/workflows/dep-triage.yml/runs --jq .total_count` ⇒ **0**，
    该作业自建仓以来一次都没跑过；而它的 `permissions` 只有 `contents: read`，本脚本取的是
    `/repos/{repo}/pulls?state=open` ⇒ 就算哪天 cron 生效，第一次执行也是 403。
    两个缺口同源：**"配了作业"既不代表它会被触发，也不代表它跑得通。**
    """
    wf = REPO / ".github" / "workflows" / "dep-triage.yml"
    if not workflow_text:
        return False, f"读不到 {wf} ⇒ 配对判据没有输入，不判绿"
    granted = re.search(r"^\s*pull-requests:\s*read", permissions_block(workflow_text), re.M) is not None
    fires = re.search(r"^  workflow_run:", workflow_text, re.M) is not None
    return granted and fires, f"pull-requests:read={granted}｜会触发的通路 workflow_run={fires}"


def run_selftest() -> int:
    now = datetime(2026, 9, 26, 12, 0, tzinfo=UTC)
    sample: list[dict[str, Any]] = [
        {"title": "chore(deps): update fastapi requirement from >=0.128 to >=0.130", "merged_at": None},
        {"title": "chore(deps): bump actions/checkout from 4 to 7", "merged_at": None},
        {"title": "chore(deps-dev): bump wrangler from 4.135.0 to 4.136.1", "merged_at": "2026-09-26T00:00:00Z"},
        {"title": "chore(deps): bump react from 19.2.8 to 19.3.0 in /frontend", "merged_at": None}]
    got_stats = {e: (m, d) for e, m, d in summarize_ecosystems(sample)}
    eco_ok = (got_stats.get("pip") == (0, 1) and got_stats.get("github-actions") == (0, 1)
              and got_stats.get("npm") == (1, 1))
    print(f"{'ok  ' if eco_ok else 'BAD '} :: 生态读数分组（pip/actions 各算成零合并、npm 有合并）-> {got_stats}")
    zero_ok = summarize_ecosystems([]) == []
    print(f"{'ok  ' if zero_ok else 'BAD '} :: 零输入：一张 PR 都没有 ⇒ 读数必须空集（不编出行来）"
          f" -> {summarize_ecosystems([])}")
    cfg = {"max_age_days": 14, "marker": "dep-triage:v1"}
    cases = [
        ("新 PR + 有标记 ⇒ 全绿", [_pr(1, 3, True, now)], 0),
        ("超龄 ⇒ 判红", [_pr(2, 40, True, now)], 1),
        ("未分诊 ⇒ 判红", [_pr(3, 5, False, now)], 1),
        ("零 PR ⇒ 不判红（覆盖面靠打印数量自证）", [], 0),
        ("脏 created_at ⇒ 不得静默放行", [{"number": 4, "title": "x", "created_at": "not-a-date",
                                          "updated_at": "", "base": "main", "bodies": [], "labels": []}], 1),
    ]
    passed = 0
    for label, pending, expect in cases:
        rows = evaluate(pending, cfg, now)
        rc = 1 if any(not ok for _, ok, _ in rows) else 0
        ok = rc == expect
        print(f"{'ok  ' if ok else 'BAD '} :: {label} -> rc={rc} 期望={expect}")
        passed += 1 if ok else 0
    # 阈值文件自身也要被读一遍（否则 fixture 坏了要等到 CI 才发现）
    try:
        live = load_cfg()
        cfg_ok = int(live["max_age_days"]) >= 1
    except SystemExit:
        cfg_ok = False
    print(f"{'ok  ' if cfg_ok else 'BAD '} :: 阈值文件可读且合法（fixture 是判据的输入）")
    passed += 1 if cfg_ok else 0
    # ── 第四十五轮补的两条：真实工作流的"权限＋通路"配对，以及它自己的反向腿 ──────────────
    try:
        real_text = (REPO / ".github" / "workflows" / "dep-triage.yml").read_text(encoding="utf-8")
    except OSError as bad:
        real_text = ""
        print(f"BAD  :: 读不到 dep-triage.yml：{type(bad).__name__} {bad}")
    pair_ok, pair_detail = check_workflow_pairing(real_text)
    print(f"{'ok  ' if pair_ok else 'BAD '} :: 真实工作流配对（pull-requests 权限＋会触发的通路）-> {pair_detail}")
    passed += 1 if pair_ok else 0
    neg_perm, _ = check_workflow_pairing("on:\n  workflow_run:\n    workflows: [x]\npermissions:\n  contents: read\n")
    neg_trig, _ = check_workflow_pairing("on:\n  schedule: []\npermissions:\n  contents: read\n  pull-requests: read\n")
    both = check_workflow_pairing("on:\n  schedule: []\npermissions:\n  contents: read\n")
    neg_ok = (not neg_perm) and (not neg_trig) and (not both[0])
    print(f"{'ok  ' if neg_ok else 'BAD '} :: 反例三向（缺权限红／缺通路红／只有 cron 红）"
          f"-> 缺权限={not neg_perm} 缺通路={not neg_trig} 只有 cron={not both[0]}")
    passed += 1 if neg_ok else 0
    passed += 1 if eco_ok else 0
    passed += 1 if zero_ok else 0
    total = len(cases) + 5
    print(f"[GATE:dep-triage-selftest-{'pass' if passed == total else 'fail'}] {passed}/{total}")
    return 0 if passed == total else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Dependabot 分诊闭环判据")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", "lxh113377/doctor-ai-dx"))
    args = ap.parse_args()
    if args.selftest:
        return run_selftest()
    cfg = load_cfg()
    tok = token()
    if not tok:
        print("[GATE:dep-triage-fail] 无 GitHub Token：取不到开放 PR 时不得判绿", file=sys.stderr)
        return 2
    pending = fetch_pending(str(args.repo), tok)
    if pending is None:
        print(f"[GATE:dep-triage-fail] 上游 {args.repo} 的开放 PR 读取失败（区分不了『没有』与『没查到』）",
              file=sys.stderr)
        return 2
    rows = evaluate(pending, cfg, datetime.now(UTC))
    for name, ok, detail in rows:
        print(f"{'PASS' if ok else 'FAIL'} :: {name}" + ("" if ok else f" :: {detail}"))
    print(f"开放 Dependabot PR={len(pending)}"
          + ("（零 PR 也如实报数：本判据不因『没活干』而假绿，也不因『没活干』而假红）" if not pending else ""))
    for pr in pending:
        print(f"  #{pr['number']} base={pr['base']} {pr['title'][:60]}")
    # 生态产出读数（第四十五轮，advisory：只报告，不改变上面的判定与退出码；取不到即 fail-open）
    try:
        allp = fetch_all_states(str(args.repo), tok)
    except Exception as bad:  # noqa: BLE001 - 读数不得把判据本身弄崩
        allp = None
        print(f"UNVERIFIED :: 生态读数取数异常（不影响判定）：{type(bad).__name__} {bad}")
    if allp is None:
        print("UNVERIFIED :: 生态读数取不到全部 PR ⇒ 如实报不可判（不拿『没查到』当『没有』）")
    elif not allp:
        print("ADVISORY :: dependabot 历史上没有一张 PR（如实报数，不猜原因）")
    else:
        for eco, merged_n, discarded_n in summarize_ecosystems(allp):
            clash = merged_n == 0 and discarded_n >= 3
            print(f"ADVISORY :: 生态 {eco}：已合并={merged_n} 关闭未合并={discarded_n}"
                  + ("｜结构性冲突：该生态的升级通道与 dependabot 的 PR 形态不兼容（见 summarize_ecosystems 注释）"
                     if clash else ""))
    failed = [n for n, ok, _ in rows if not ok]
    print(f"[GATE:dep-triage-{'pass' if not failed else 'fail'}] {len(rows) - len(failed)}/{len(rows)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
