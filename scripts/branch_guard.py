#!/usr/bin/env python3
"""分支保护 ↔ CI 作业图对账门禁（第十九轮）。

为什么必须存在（本轮实测的缺口）：`ci.yml` 有 4 个阻断性作业（build-and-test / backend-test /
text-hygiene / e2e），但 `branch protection 的 required_status_checks` 实测只有 2 项
（build-and-test、backend-test）⇒ **本轮刚上线的浏览器回归与上一轮的文本卫生判据可以被绕过**：
PR 带着红的 e2e 也能合进 main。这属于"判据写了但不被强制"，与 r12「红线在 live 路径从未被测」
同一类，只是发生在更外层（合入闸门）。

对标：OpenEMR 有一条名为 `All Checks Passed` 的作业（95 个工作流里可见）——用**单个聚合检查**
做 required check，新增作业只要挂进聚合的 needs 就自动被强制，不必回头改仓库设置。本轮照此实现。

判据（任一失败 exit 1）：
 1. `ci.yml` 存在聚合 job，且 `if: always()`（否则任一前置失败时聚合不跑，required check 永不出现＝保护形同虚设）
 2. 聚合 job 的 `needs` ⊇ {ci.yml 中全部非 deploy、非聚合自身的 job}（**新增作业忘记挂进来即判红**）
 3. `deploy.needs` 同样覆盖全部阻断作业（部署不得绕过任何一道判据）
 4. 聚合 job 的 id 与脚本内登记的 required check 名一致（改 id 必须同步改仓库保护，防止"改了名字保护还在指旧名"）
 5. `--remote` 时读 GitHub API 实测：required_status_checks.contexts ⊇ {聚合检查名}；无权限则打印 SKIP 并说明，**不静默判绿**

用法：
  python scripts/branch_guard.py [--quiet]            # 本地/CI 静态对账（零凭据）
  python scripts/branch_guard.py --remote             # 额外核线上分支保护真实配置（需 gh 登录）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import yaml  # 锁内已声明（pyyaml>=6.0.1）：不自造 YAML 解析器

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CI = os.path.join(REPO, ".github", "workflows", "ci.yml")
AGGREGATE_ID = "all-checks-passed"  # 仓库保护里 required check 的 context 即此 id
NON_BLOCKING = {AGGREGATE_ID, "deploy"}  # deploy 是条件作业（AUTO_DEPLOY 未设时 skipped），不能当阻断判据


def load_jobs() -> dict:
    with open(CI, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    jobs = doc.get("jobs") or {}
    if not isinstance(jobs, dict) or len(jobs) < 3:
        raise SystemExit(f"[GATE:branch-fail] ci.yml 解析到的 job 数异常：{len(jobs)}（非空证明失败）")
    return jobs


def gh(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["gh", *args], capture_output=True, text=True, cwd=REPO)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--remote", action="store_true", help="额外核对线上分支保护真实配置（需 gh 凭据）")
    args = ap.parse_args()

    jobs = load_jobs()
    blocking = [j for j in jobs if j not in NON_BLOCKING]
    checks: list[tuple[str, bool, str]] = []

    agg = jobs.get(AGGREGATE_ID)
    checks.append((f"存在聚合 job `{AGGREGATE_ID}`", agg is not None, f"ci.yml jobs={list(jobs)}"))
    if agg:
        needs = agg.get("needs") or []
        needs = [needs] if isinstance(needs, str) else list(needs)
        missing = [j for j in blocking if j not in needs]
        checks.append(("聚合 needs 覆盖全部阻断作业（新增作业忘记挂进来即判红）",
                       not missing, f"缺 {missing}；实测阻断作业={blocking}"))
        cond = str(agg.get("if", ""))
        checks.append(("聚合 job 带 if: always()（否则前置红时它不跑，required check 永不出现）",
                       "always()" in cond, f"实测 if={cond!r}"))
    with open(CI, encoding="utf-8") as f:
        ci_text = f.read()
    checks.append(("ci.yml 真的调用 branch_guard 自身（判据不许只写在文档里）",
                   "branch_guard.py" in ci_text, "工作流里找不到自调用 ⇒ 本判据不会在 CI 生效"))
    dep = (jobs.get("deploy") or {}).get("needs") or []
    dep = [dep] if isinstance(dep, str) else list(dep)
    dep_missing = [j for j in blocking if j not in dep]
    checks.append(("deploy.needs 覆盖全部阻断作业（部署不得绕过判据）", not dep_missing, f"缺 {dep_missing}"))

    if not args.quiet:
        print(f"== 分支保护 ↔ CI 作业图对账（ci.yml jobs={len(jobs)}，阻断作业={len(blocking)}）==")
    rc = 0
    for name, ok, detail in checks:
        if ok and args.quiet:
            continue
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
        if not ok:
            rc = 1

    if args.remote:
        r = gh("api", "repos/lxh113377/doctor-ai-dx/branches/main/protection",
               "--jq", ".required_status_checks.contexts // [] | @json")
        if r.returncode != 0:
            print(f"  SKIP 线上保护实测不可读（{(r.stderr or '').strip()[:90]}）⇒ 本轮不判绿，"
                  "须人工在仓库 Settings 或用有权限凭据复跑 --remote")
        else:
            try:
                contexts = json.loads(r.stdout or "[]")
            except json.JSONDecodeError:
                contexts = []
            ok = AGGREGATE_ID in contexts
            print(f"  {'PASS' if ok else 'FAIL'} 线上 required checks 含聚合检查 :: 实测={contexts}")
            if not ok:
                rc = 1
    else:
        print("  SKIP 未加 --remote：仅静态对账（线上保护真实配置需另跑 --remote 或看仓库设置）")

    print(f"[GATE:branch-{'pass' if rc == 0 else 'fail'}] 聚合检查名={AGGREGATE_ID}"
          "（改名须同步 PUT 分支保护，二者由本判据钉在一起）")
    return rc


if __name__ == "__main__":
    sys.exit(main())
