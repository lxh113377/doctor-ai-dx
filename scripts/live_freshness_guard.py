#!/usr/bin/env python3
"""排班作业健康度守卫（第四十四轮；对标 `openemr` 的 acceptance/回归作业常态化形态）。

为什么要它（一手观察，不是"peer 有所以我也要有"）：
  `perf_gate.mjs` 里那条「报告新鲜度 ≤14 天」**唯一的执行点在 `live-smoke.yml` 的 `online-eval` 作业里，
  而那份报告是同一次作业的上一步刚生成的** ⇒ 这条判据在那个位置上永远为真，
  它声称防的是"数据过期"，实际防不到任何东西（判据只能匹配行为，不能匹配描述）。
  真正会发生的失效是另一件事：**排班停摆**（配额、调度被取消、作业长期 skipped），
  这时"最新一次评测"再也无人生产，而现有判据一条都不会红。
  本守卫判的就是这个——拿「最近一次 conclusion=success 的 run 的时间」当分母。

为什么它敢存在（与 A-get-memory 判据⑩ 咬合）：它是**可自愈**的——排班恢复的第二天读数自然回到 PASS，
不像"读某次历史红 run"那种永久红；且它**不进任何人的提交链**，只挂在排班巡检作业里
（advisory 类新指标先看得见、不拦任务；停摆由作业变红＋摘要行暴露）。

四态（零输入绝不记绿）：
  PASS        最近成功 run 在 max_age_days 内，且（要求时）该 run 留有指定 artifact
  FAIL        超期 / 近期无任何成功 run / 要求 artifact 却没有
  UNVERIFIED  取不到 run 列表（无 gh、无凭据、网络失败）⇒ rc=2，**既不记绿也不判红**
  EMPTY       artifact 面被要求但没有一条 run 可判 ⇒ rc=2
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml  # 锁内已声明（与 branch_guard 同源）：不自己写 YAML 解析器

#: 必须用 per-workflow 端点。实测两件事：
#:   · `repos/{repo}/actions/runs?workflow=<file>` 的 `workflow` 参数被 API **忽略**（返回的是全仓混合 run）；
#:   · 全局首页 300 条里根本没有 live-smoke/link-health/dep-triage ⇒ 拿首页当分母会把"停摆"读成"没数据"。
RUNS_API = "repos/{repo}/actions/workflows/{wf}/runs?per_page=50"


def run_gh(repo: str, workflow: str):
    """取最近 run 列表；任何失败都返回 (None, 原因)——调用方必须把它走成 UNVERIFIED 而不是 0 条。"""
    if not shutil.which("gh"):
        return None, "本机无 gh 可执行文件"
    r = subprocess.run(["gh", "api", RUNS_API.format(repo=repo, wf=workflow)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        return None, f"gh 取 run 列表失败 rc={r.returncode}：{(r.stderr or '').strip()[:120]}"
    try:
        data = json.loads(r.stdout or "{}")
    except json.JSONDecodeError as e:
        return None, f"gh 返回不是合法 JSON：{str(e)[:80]}"
    runs = data.get("workflow_runs")
    if runs is None:
        return None, "响应里没有 workflow_runs 字段（取数面变了，不许当成 0 条）"
    return runs, ""


def parse_ts(s: str):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return None


def decide(runs, workflow_file: str, now: datetime, max_age_days: float, artifact: str):
    """纯函数：runs -> (状态, 读数, 原因)。拆出来是为了能被 selftest 直接驱动（不联网）。"""
    # 两个"空"必须分开，折叠成一个就会把真停摆读成没数据（本轮实测正是这条救场）：
    #   raw 为空      ⇒ 该 workflow 在本仓库从未产生过任何 run ⇒ FAIL（触发器根本没走过）
    #   raw 非空而我过滤后为空 ⇒ 返回体形状/归属与预期不符 ⇒ UNVERIFIED（不猜）
    if not runs:
        return ("FAIL", 0, f"{workflow_file} 一条 run 都没有 ⇒ 触发器从未生效（排班停摆／cron 从未命中）；"
                           "本仓实测：event=schedule 全仓 0 条")
    mine = [r for r in runs if (r.get("path") or "").endswith("/" + workflow_file)
            or r.get("name") == workflow_file]
    if not mine:
        return ("UNVERIFIED", 0, f"取到 {len(runs)} 条 run 但没有一条属于 {workflow_file} ⇒ 取数面与预期不符，不猜")
    ok = [r for r in mine if r.get("status") == "completed" and r.get("conclusion") == "success"]
    if not ok:
        recent = [str(r.get("updatedAt") or r.get("created_at") or "?") for r in mine[:3]]
        return "FAIL", len(mine), (f"近期无任何成功 run（最近 3 条时间戳 {', '.join(recent)}）⇒ 排班停摆或长期失败")
    newest = max((r for r in ok), key=lambda r: str(r.get("updated_at") or r.get("created_at") or ""))
    ts = parse_ts(newest.get("updated_at") or newest.get("created_at"))
    if ts is None:
        return "UNVERIFIED", len(ok), "最新成功 run 的时间戳解析不出来（字段形状变了）"
    age_days = (now - ts).total_seconds() / 86400.0
    readout = f"最近成功 run={newest.get('id')} age={age_days:.2f}d 阈值={max_age_days:.1f}d"
    if artifact:
        runs_with_artifact = bool(newest.get("artifacts_url"))
        if not runs_with_artifact:
            return "FAIL", len(ok), readout + f" ｜该 run 无 artifacts 面，要求的 {artifact} 无从核对"
        readout += " artifact面=有"
    return ("PASS" if age_days <= max_age_days else "FAIL"), len(ok), readout


def scheduled_workflows(workdir: Path) -> list[str]:
    """列出**声明了 cron** 的工作流文件名（"在册排班"的枚举器，不靠人记）。"""
    out = []
    for f in sorted(workdir.glob("*.yml")) + sorted(workdir.glob("*.yaml")):
        try:
            doc = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except Exception:                      # noqa: BLE001 - 解析不动＝看不见的排班，更要点名
            out.append(f.name)
            continue
        on = doc.get(True) or doc.get("on") or {}      # YAML 1.1 会把裸 `on` 解析成布尔真
        if isinstance(on, dict) and on.get("schedule"):
            out.append(f.name)
    return out


def patrolled_workflows(ci_text: str) -> list[str]:
    """从 ci.yml 的 `--workflow <file>` 调用里枚举**已被巡检**的工作流。"""
    return sorted(set(re.findall(r"live_freshness_guard\.py\s+--workflow\s+(\S+\.ya?ml)", ci_text)))


def check_patrol_coverage(workdir: Path, ci_path: Path) -> tuple[bool, str]:
    """配对判据（第四十五轮）：**声明了 cron 的作业，必须每一个都被新鲜度巡检覆盖。**

    一手起因：r44 实测本仓 `event=schedule` 全仓 0 条 run，四条 cron 里只有两条被我按名字写了巡检步
    ⇒ "在册的排班"与"被巡检的排班"是两个集合，缺的那一半会安静地永远不发生（dep-triage 就是这么躺着的）。
    差集由两个枚举器现算，不写死名单。
    """
    if not ci_path.exists():
        return False, f"读不到 {ci_path} ⇒ 巡检面无法核对，不判绿"
    sched = scheduled_workflows(workdir)
    if not sched:
        return False, f"{workdir} 里一条 schedule 都没有 ⇒ 取数面空（不判『覆盖完整』）"
    covered = patrolled_workflows(ci_path.read_text(encoding="utf-8"))
    if not covered:
        return False, f"在册排班 {len(sched)} 条，但 ci.yml 里一条巡检步都没找到 ⇒ 全裸奔"
    missing = sorted(set(sched) - set(covered))
    extra = sorted(set(covered) - set(sched))
    tail = f"（另：被巡检但已不排班 {extra}）" if extra else ""
    return not missing, (f"在册排班={sched}｜已巡检={covered}｜缺={missing}{tail}；"
                         f"覆盖 {len(set(sched) & set(covered))}/{len(sched)}")


def selftest() -> int:
    now = datetime(2026, 9, 27, 12, 0, tzinfo=UTC)
    def mk(when, status="completed", conclusion="success", art=True):
        return {"id": 1, "name": "Delivered artifact smoke",
                "path": "refs/heads/main/.github/workflows/live-smoke.yml",
                "status": status, "conclusion": conclusion, "updated_at": when,
                "artifacts_url": "u" if art else None}
    cases = []
    st, _n, why = decide([mk("2026-09-27T06:00:00Z")], "live-smoke.yml", now, 3.0, "")
    cases.append(("新鲜成功 run ⇒ PASS", st == "PASS", why))
    st, _n, why = decide([mk("2026-09-20T06:00:00Z")], "live-smoke.yml", now, 3.0, "")
    cases.append(("超期 run ⇒ FAIL（专属输入面：只有 7 天前的 run 能使它红）", st == "FAIL", why))
    st, _n, why = decide([mk("2026-09-27T06:00:00Z", conclusion="failure")], "live-smoke.yml", now, 3.0, "")
    cases.append(("只有失败 run ⇒ FAIL", st == "FAIL", why))
    st, _n, why = decide([], "live-smoke.yml", now, 3.0, "")
    cases.append(("raw 空 run 列表 ⇒ FAIL（从未触发），绝不记绿", st == "FAIL", why))
    st, _n, why = decide([mk("2026-09-27T06:00:00Z", art=False)], "live-smoke.yml", now, 3.0, "eval-report-live")
    cases.append(("要求 artifact 但该 run 无 artifacts 面 ⇒ FAIL", st == "FAIL", why))
    st, _n, why = decide([mk("garbage")], "live-smoke.yml", now, 3.0, "")
    cases.append(("时间戳不可解析 ⇒ UNVERIFIED（不猜年龄）", st == "UNVERIFIED", why))
    st, _n, why = decide([{"name": "其它作业", "path": "x/ci.yml", "status": "completed",
                           "conclusion": "success", "updated_at": "2026-09-27T06:00:00Z"}],
                         "live-smoke.yml", now, 3.0, "")
    cases.append(("raw 非空但无一条属目标 workflow ⇒ UNVERIFIED（不拿别人的 run 顶数）",
                  st == "UNVERIFIED", why))
    # ── 排班⇄巡检配对判据（第四十五轮）：真面＋两条专属输入面 ─────────────────────────
    wf_dir = Path(__file__).resolve().parents[1] / ".github" / "workflows"
    ok_real, detail_real = check_patrol_coverage(wf_dir, wf_dir / "ci.yml")
    cases.append(("真实面：每条声明 cron 的作业都被新鲜度巡检覆盖", ok_real, detail_real))
    import tempfile
    tmp = Path(tempfile.mkdtemp(prefix="patrol_"))
    (tmp / "cron-bare.yml").write_text("on:\n  schedule:\n    - cron: '0 3 * * 2'\njobs: {}\n", encoding="utf-8")
    (tmp / "ci.yml").write_text("jobs:\n  x:\n    steps:\n      - run: python scripts/live_freshness_guard.py "
                                "--workflow other.yml\n", encoding="utf-8")
    ok_miss, detail_miss = check_patrol_coverage(tmp, tmp / "ci.yml")
    cases.append(("反例：在册排班没被巡检覆盖 ⇒ 必须判红并点名", not ok_miss and "cron-bare.yml" in detail_miss,
                  detail_miss))
    (tmp / "cron-bare.yml").write_text("on:\n  push:\n    branches: [main]\njobs: {}\n", encoding="utf-8")
    ok_zero, detail_zero = check_patrol_coverage(tmp, tmp / "ci.yml")
    cases.append(("零输入：面里一条排班都没有 ⇒ 不判『覆盖完整』", not ok_zero, detail_zero))
    bad = len(cases) - sum(1 for _name, b, _why in cases if b)
    for name, ok, why in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name} :: {why[:90]}")
    print(f"SELFTEST: {len(cases) - bad}/{len(cases)}")
    print("[GATE:schedule-health-selftest-pass]" if bad == 0 else "[GATE:schedule-health-selftest-fail]")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="lxh113377/doctor-ai-dx")
    ap.add_argument("--workflow", default="live-smoke.yml")
    ap.add_argument("--max-age-days", type=float, default=3.0)
    ap.add_argument("--artifact", default="", help="要求最新成功 run 留有该 artifact 名（仅核有无 artifacts 面）")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--patrol", action="store_true",
                    help="静态配对：在册 cron 作业 ⇄ ci.yml 的巡检覆盖（零网络，可进阻断链）")
    ap.add_argument("--now", default="", help="注入当前时刻（ISO，仅测试用）")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if a.patrol:
        wf_dir = Path(__file__).resolve().parents[1] / ".github" / "workflows"
        ok, detail = check_patrol_coverage(wf_dir, wf_dir / "ci.yml")
        print(("PASS :: " if ok else "FAIL :: ") + detail)
        print("[GATE:schedule-patrol-pass]" if ok else "[GATE:schedule-patrol-fail]")
        return 0 if ok else 1
    runs, err = run_gh(a.repo, a.workflow)
    if runs is None:
        print(f"UNVERIFIED :: {err}")
        print("[GATE:schedule-health-unverified]")
        return 2
    now = parse_ts(a.now) or datetime.now(UTC)
    if now is None:
        print(f"UNVERIFIED :: --now 注入值不可解析：{a.now!r}")
        print("[GATE:schedule-health-unverified]")
        return 2
    state, n, why = decide(runs, a.workflow, now, a.max_age_days, a.artifact)
    print(f"{state} :: {why}")
    print({"PASS": "[GATE:schedule-health-pass]", "FAIL": "[GATE:schedule-health-fail]",
           "UNVERIFIED": "[GATE:schedule-health-unverified]", "EMPTY": "[GATE:schedule-health-empty]"}[state])
    return 0 if state == "PASS" else (2 if state == "UNVERIFIED" else 1)


if __name__ == "__main__":
    sys.exit(main())
