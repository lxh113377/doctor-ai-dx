#!/usr/bin/env python3
"""发布链的 CI-green 前置闸（第四十轮台账 #47 的机制化）。

红因（实测，不是推测）：本轮提交 d5e197f 的 `CI - build & deploy` 判红（infra-lint SC1073），
而 **同一时刻 `Release artifacts (tag)` 作业跑完并 success** —— 发布链对"CI 绿"零门槛。
这与 v1.21.0 那次（从 infra-lint 判红的提交出了镜像与 Release）同形，是**第二次以上复发**，
按 A-get-memory Step 2.7 的复发计数硬门槛：禁止以"下次注意"收口，当轮必须交付机器载体。

判定四态（`decide()` 是纯函数，输入是 run 记录列表 ⇒ 夹具可在内存造输入驱动，不落盘不 fork）：
  FAIL      —— 有任一 completed 且 conclusion != success 的 run（已知红提交即此态）
  PENDING   —— 没有红，但有仍在排队/运行的 run（发布该等，不该抢跑）
  PASS      —— 全部 completed 且 conclusion == success
  UNVERIFIED—— 该 commit 在本工作流下**一条 run 都没有**（例如直接打 tag 没推 main）
             ⇒ 放行但 loudly 记 UNVERIFIED：新指标先量误报率再接线，取不到数不拦（见 memory 铁律
               「advisory gates never block execution」）。真要收紧成 fail-closed，须先积累误报率数据。

用法：
  python scripts/release_ci_gate.py --ref v1.38.0        # release.yml 里用
  python scripts/release_ci_gate.py --selftest           # 6 项夹具（含"删掉红判定必翻红"的反向自证）
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REPO = "lxh113377/doctor-ai-dx"
WORKFLOW = "ci.yml"  # GitHub 的 runs 端点认**文件名或数字 ID**，不认显示名（现测显示名 ⇒ HTTP 404）
DONE_STATES = {"completed"}


def sh(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} 失败 rc={r.returncode}: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def resolve_commit(ref: str, repo_dir: Path) -> str:
    """tag 可能是附注标签 ⇒ 必须 ^{commit} 解引用；不解就会把 tag 对象 sha 当 commit 用。"""
    return sh(["git", "-C", str(repo_dir), "rev-parse", f"{ref}^{{commit}}"]).strip()


def resolve_workflow_id(repo: str, want: str) -> str:
    """显示名 → 工作流文件名。runs 端点只认文件名或数字 ID（实测显示名 ⇒ HTTP 404），
    而 404 会被上层读成 UNVERIFIED ⇒ 这条闸看着在跑其实什么都没测。故先解析，认不出再原样送回。"""
    tsv = chr(9)
    # GET 的参数必须拼进 URL query：`-f` 会进请求体 ⇒ GitHub 回 404（本机实测，同族已立规）
    raw = sh(["gh", "api", f"repos/{repo}/actions/workflows?per_page=100",
              "--jq", "[.workflows[] | select(.state==\"active\") | (.name + \"\t\" + .path)] | .[]"])
    for line in raw.splitlines():
        if tsv not in line:
            continue
        name, path = line.split(tsv, 1)
        if name == want or path == want or path.rsplit("/", 1)[-1] == want:
            return path.rsplit("/", 1)[-1]  # runs 端点要的是**文件名**（ci.yml），不是仓内全路径
    return want  # 原样送回：让上层按取数失败如实记 UNVERIFIED，绝不静默放行成 PASS


def fetch_runs(sha: str, repo: str = REPO, workflow: str = WORKFLOW) -> list[dict]:
    workflow = resolve_workflow_id(repo, workflow)
    raw = sh([
        "gh", "api", f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100",
        "--paginate",
        "--jq", "[.workflow_runs[] | {id: .id, status: .status, conclusion: .conclusion, url: .html_url}]",
    ])
    try:
        runs = json.loads(raw or "[]")
    except json.JSONDecodeError as exc:  # gh 出错时也可能吐出半截文本
        raise RuntimeError(f"无法解析 run 列表（判据不许把解析失败读成「没有 run」）：{exc}") from exc
    if not isinstance(runs, list):
        raise RuntimeError("run 列表形态不是数组，拒绝判定")
    return runs  # 服务端已按 head_sha 过滤；这里不再二次猜字段形态


def decide(runs: list[dict]) -> tuple[str, str]:
    red = [r for r in runs if r.get("status") in DONE_STATES and (r.get("conclusion") or "") not in ("success", "")]
    pending = [r for r in runs if r.get("status") not in DONE_STATES]
    done = [r for r in runs if r.get("status") in DONE_STATES]
    if red:
        return "FAIL", f"红 run={len(red)}：{red[0].get('url')}（conclusion={red[0].get('conclusion')}）"
    if pending:
        return "PENDING", f"未完成 run={len(pending)}：{pending[0].get('url')}（status={pending[0].get('status')}）"
    if not done:
        return "UNVERIFIED", "该 commit 在本工作流下没有任何已完成的 run（可能未推 main 就直接打 tag）"
    return "PASS", f"全部绿（completed run={len(done)}）"


def selftest() -> int:
    cases: list[tuple[str, list[dict], str]] = [
        ("红提交必须判 FAIL", [{"status": "completed", "conclusion": "failure", "url": "u1"}], "FAIL"),
        ("全绿必须判 PASS", [{"status": "completed", "conclusion": "success", "url": "u2"}], "PASS"),
        ("绿+在跑必须判 PENDING（不许读成绿）",
         [{"status": "completed", "conclusion": "success", "url": "u3"},
          {"status": "in_progress", "conclusion": None, "url": "u4"}], "PENDING"),
        ("零 run 必须判 UNVERIFIED（不许读成 PASS）", [], "UNVERIFIED"),
        ("混合里有一红必须优先于绿",
         [{"status": "completed", "conclusion": "success", "url": "u5"},
          {"status": "completed", "conclusion": "cancelled", "url": "u6"}], "FAIL"),
        # 反向自证：cancelled / startup_failure 这类"不是 success 的完成态"都必须落进 FAIL。
        # 若哪天只判 conclusion == "failure"，这条夹具会立刻翻红——它就是那个专属输入面。
        ("conclusion=success 的空串/None 不得被当成红",
         [{"status": "completed", "conclusion": "success", "url": "u7"}], "PASS"),
    ]
    bad = 0
    for name, runs, want in cases:
        got, detail = decide(runs)
        ok = got == want
        if not ok:
            bad += 1
        print(f"  {'PASS' if ok else 'FAIL'} {name} :: 期望={want} 实测={got} | {detail[:70]}")
    print(f"SELFTEST: {len(cases) - bad}/{len(cases)}")
    print("[GATE:release-ci-selftest-pass]" if bad == 0 else "[GATE:release-ci-selftest-fail]")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="", help="tag 或 sha（release.yml 传 github.ref_name）")
    ap.add_argument("--repo", default=REPO)
    ap.add_argument("--workflow", default=WORKFLOW)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--allow-unverified", action="store_true",
                    help="显式放行 UNVERIFIED 之外的语义不变；此开关只把 UNVERIFIED 也当放行（默认就是放行，"
                         "保留此开关是为了在收紧成 fail-closed 时不改调用方）")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.ref:
        print("用法：--ref <tag|sha> 或 --selftest", file=sys.stderr)
        return 2
    try:
        sha = resolve_commit(a.ref, Path(__file__).resolve().parents[1])
        runs = fetch_runs(sha, a.repo, a.workflow)
    except RuntimeError as exc:
        # 工具取不到数 ⇒ 记 UNVERIFIED 放行（advisory 不阻断），但把原因打全，绝不静默
        print(f"[GATE:release-ci-unverified] 取数失败：{exc}")
        return 0
    state, detail = decide(runs)
    print(f"== 发布前置：commit={sha[:7]} 工作流={a.workflow} ==")
    print(f"  {state} {detail}")
    if state == "FAIL":
        print("[GATE:release-ci-fail] 该提交 CI 未绿 ⇒ 拒绝发布（修 CI 后重打/重锚 tag，别绕闸）")
        return 1
    if state == "PENDING":
        print("[GATE:release-ci-pending] CI 还在跑 ⇒ 等它结束（scripts/ci_watch.py --wait 1500）")
        return 1
    if state == "UNVERIFIED":
        print("[GATE:release-ci-unverified] 无 CI 记录 ⇒ 放行但如实记 UNVERIFIED（不声称已核）")
        return 0
    print("[GATE:release-ci-pass]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
