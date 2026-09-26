#!/usr/bin/env python
"""GitHub Actions 供应链钉版：迁移（--resolve）与判据（--verify）共用同一枚举器。

为什么需要它（第二十三轮对标，2026-09-26 实测）
    活体 peer `bloodworks-io/phlox` 的 4 份工作流里 33/33 处 `uses:` 全部钉到 40 位提交号；
    `openemr/openemr` 79 份工作流里 61 份显式声明 `permissions:`。我方 5 份工作流 31 处 `uses:`
    此前**全部**浮动在 major tag（`@v7` 这类）上，只有 release.yml 有顶层 `permissions:`。
    major tag 可被上游随时移指：一旦某个 action 仓库被接管或被强推，我方每次 CI 实际执行的代码
    就由别人的运维习惯决定——与 r18「pip 侧只有区间声明」同族的问题，只不过发生在 CI 自身的供给链上。

判据取外部真值，不自比：注释声明的版本 tag 必须在上游仓库真实存在，且上游把它解析到的提交号必须
逐字等于工作流里钉的那 40 位。拿"仓内常量"比"仓内常量"会自证式判绿（r19 实证）。

用法：
  python scripts/action_pin.py --verify            # 判据（CI / 本地复跑走这条，需 GitHub Token）
  python scripts/action_pin.py --resolve [--apply] # 升级时重钉（人工触发，不是闸门）
  python scripts/action_pin.py --selftest          # 反例自证：每条判据必须真的会咬（零网络）
退出码：0 全绿 / 1 判红 / 2 环境或参数错误（取不到上游真值时禁止静默判绿）。
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
from collections.abc import Callable, Iterable
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WF_DIR = REPO / ".github" / "workflows"
API = "https://api.github.com"

# 一条 `uses:` 行拆成：前导空白与可选短横、目标 owner/repo[/sub/path]、ref、行尾剩余内容。
USES_RE = re.compile(
    r"^(?P<head>\s*-?\s*uses:\s*)"
    r"(?P<target>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[^\s@#]+)*)"
    r"@(?P<ref>[^\s#]+)"
    r"(?P<tail>.*)$"
)
USES_ANY_RE = re.compile(r"^\s*-?\s*uses:\s*$|^\s*-?\s*uses:\s+\S")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TAG_IN_TAIL_RE = re.compile(r"#\s*(?P<tag>\S+)")
TOP_KEY_RE = re.compile(r"^(?P<key>[A-Za-z_][\w-]*):(?:\s*(?P<val>\S.*))?$")
JOB_KEY_RE = re.compile(r"^  (?P<key>[A-Za-z_][\w-]*):")
GRANT_RE = re.compile(r"^\s+(?P<key>[A-Za-z_][\w-]*):\s*(?P<val>\S.*?)\s*$")

# 覆盖面下限：目录改名或解析器失灵时，"零命中"必须是判红而不是通过（R247）。
MIN_WORKFLOWS = 5
MIN_PINS = 20
# 最小权限上界：这些写权限只允许出现在点名工作流里，别处出现即判红。
WRITE_ALLOW: dict[str, frozenset[str]] = {
    "contents": frozenset({"release.yml"}),
    "packages": frozenset({"release.yml"}),
    "security-events": frozenset({"codeql.yml"}),
}
# 全局禁止的写权限：我方没有任何工作流需要改工作流文件或写 checks。
NEVER_WRITE = frozenset({"workflows", "actions", "deployment", "deployments", "pull-requests"})
# 确需以带凭据身份操作 git 的工作流白名单；当前为零（发布工件走 gh CLI + GH_TOKEN，不靠持久化凭据）。
CREDENTIALED_ALLOW: frozenset[str] = frozenset()

Row = tuple[str, bool, str]


class Pin:
    """工作流里的一处 action 引用。"""

    def __init__(self, fname: str, lineno: int, target: str, ref: str, head: str, tail: str) -> None:
        self.fname = fname
        self.lineno = lineno
        self.target = target
        self.ref = ref
        self.head = head
        self.tail = tail

    @property
    def is_local(self) -> bool:
        return self.target.startswith("./")

    @property
    def pinned(self) -> bool:
        return bool(SHA_RE.match(self.ref))

    @property
    def declared_tag(self) -> str:
        m = TAG_IN_TAIL_RE.search(self.tail)
        return str(m.group("tag")) if m else ""

    def where(self) -> str:
        return f"{self.fname}:{self.lineno}"


def read_workflows() -> list[tuple[str, str]]:
    if not WF_DIR.is_dir():
        print(f"[GATE:action-pin-fail] 工作流目录不存在：{WF_DIR}", file=sys.stderr)
        raise SystemExit(2)
    return [(p.name, p.read_text(encoding="utf-8")) for p in sorted(WF_DIR.glob("*.y*ml"))]


def iter_pins(files: Iterable[tuple[str, str]]) -> tuple[list[Pin], list[str]]:
    """返回（可解析的 action 引用, 解析不了的 uses 行点名）。

    第二项非空即判红：枚举器漏掉的那一类引用不受任何判据保护（r11 retriever_parity 硬编码 hybrid
    导致新档不受双端判据保护，是同族事故）。
    """
    pins: list[Pin] = []
    unparsed: list[str] = []
    for fname, text in files:
        for lineno, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            m = USES_RE.match(line)
            if m is None:
                if USES_ANY_RE.match(line):
                    unparsed.append(f"{fname}:{lineno}: {line.strip()}")
                continue
            pins.append(Pin(fname, lineno, m.group("target"), m.group("ref"), m.group("head"), m.group("tail")))
    return pins, unparsed


def token() -> str:
    env = os.environ.get("GITHUB_TOKEN")
    if env:
        return str(env).strip()
    try:
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def gh_get(path: str, tok: str) -> object:
    """取上游真值。返回 None 表示"没拿到"——调用方须判环境错误，不得当成"该 tag 不存在"。"""
    req = urllib.request.Request(f"{API}{path}", headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "doctor-ai-dx-action-pin",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, ValueError):
        return None


def live_tag_provider(tok: str) -> Callable[[str], dict[str, str] | None]:
    """生产侧 tag 提供者：上游 tag 名 → 提交号（/tags 返回的 commit 已是 peel 后的提交）。"""
    cache: dict[str, dict[str, str] | None] = {}

    def provide(target: str) -> dict[str, str] | None:
        repo = "/".join(target.split("/")[:2])
        if repo in cache:
            return cache[repo]
        out: dict[str, str] = {}
        page = 1
        got = False
        while page <= 5:
            data = gh_get(f"/repos/{repo}/tags?per_page=100&page={page}", tok)
            if not isinstance(data, list):
                out = {}
                got = False
                break
            for item in data:
                if isinstance(item, dict) and isinstance(item.get("name"), str) and isinstance(item.get("commit"), dict):
                    sha = item["commit"].get("sha")
                    if isinstance(sha, str):
                        out[item["name"]] = sha
            got = True
            if len(data) < 100:
                break
            page += 1
        cache[repo] = out if got else None
        return cache[repo]

    return provide


def semver_key(name: str) -> tuple[int, int, int, int, str]:
    m = re.match(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", name)
    if not m:
        return (-1, -1, -1, 0, name)
    exact = 1 if re.match(r"^v?\d+(\.\d+)*$", name) else 0
    return (int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0), exact, name)


def precise_label(sha: str, tags: dict[str, str], fallback: str) -> str:
    """指向该提交的所有 tag 里取版本号最精确、最大的一个作为人读标签。"""
    names = sorted((t for t, s in tags.items() if s == sha), key=semver_key)
    return names[-1] if names else fallback


def scan_permissions(text: str) -> tuple[dict[str, str] | None, dict[str, dict[str, str]]]:
    """极小行扫描：返回（顶层 permissions, {job 名: permissions}）。

    刻意不引第三方 YAML 解析器：本仓工作流格式由我们自己维护，而给一个"检查依赖声明完整性"的
    判据脚本本身新增运行时依赖，会把"判据自己漏声明依赖"这类失效引进门禁链（同轮补的
    dep_completeness 正好会抓到它，但少一个依赖就少一类失效面）。
    """
    top: dict[str, str] | None = None
    jobs: dict[str, dict[str, str]] = {}
    section = ""
    job = ""
    in_job_perms = False
    in_top_perms = False
    for raw in text.splitlines():
        line = "" if raw.lstrip().startswith("#") else raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        top_m = TOP_KEY_RE.match(line)
        if top_m:
            section = str(top_m.group("key"))
            job = ""
            in_job_perms = False
            in_top_perms = section == "permissions"
            if in_top_perms:
                top = {}
            continue
        if in_top_perms:
            g = GRANT_RE.match(line)
            if g and top is not None:
                top[g.group("key")] = g.group("val").strip("'\"")
            continue
        if section == "jobs":
            j = JOB_KEY_RE.match(line)
            if j:
                job = str(j.group("key"))
                in_job_perms = False
                continue
            if job and re.match(r"^    permissions:", line):
                in_job_perms = True
                jobs.setdefault(job, {})
                continue
            if job and re.match(r"^    \S", line):
                in_job_perms = False
                continue
            if in_job_perms:
                g = GRANT_RE.match(line)
                if g and g.group("key") != "run":
                    jobs.setdefault(job, {})[g.group("key")] = g.group("val").strip("'\"")
    return top, jobs


def checkout_credential_state(text: str, pins: list[Pin]) -> dict[str, str]:
    """对每处 actions/checkout，读它所在步骤块的 persist-credentials 取值（缺省记 missing）。"""
    lines = text.splitlines()
    result: dict[str, str] = {}
    for pin in pins:
        if pin.target != "actions/checkout":
            continue
        indent = len(pin.head) - len(pin.head.lstrip())
        verdict = "missing"
        for idx in range(pin.lineno, len(lines)):
            nxt = lines[idx]
            if not nxt.strip():
                continue
            if len(nxt) - len(nxt.lstrip()) <= indent or re.match(r"^\s*-?\s*uses:\s", nxt):
                break
            m = re.match(r"^\s*-?\s*persist-credentials:\s*(\S+)", nxt)
            if m:
                verdict = m.group(1).strip("'\"").lower()
                break
        result[pin.where()] = verdict
    return result


def all_grants(text: str) -> dict[str, str]:
    """把顶层与各 job 的 permissions 合并成 {作用域: 级别}，job 级带 `job/` 前缀以便点名。"""
    top, jobs = scan_permissions(text)
    grants = dict(top or {})
    for job_name, job_grants in jobs.items():
        for scope, level in job_grants.items():
            grants[f"{job_name}/{scope}"] = level
    return grants


def local_checks(
    files: list[tuple[str, str]],
    pins: list[Pin],
    unparsed: list[str],
    min_workflows: int = MIN_WORKFLOWS,
    min_pins: int = MIN_PINS,
) -> list[Row]:
    names = sorted({f for f, _ in files})
    rows: list[Row] = [
        ("覆盖面：工作流数量达下限", len(files) >= min_workflows, f"workflows={len(files)} 下限={min_workflows}"),
        ("覆盖面：action 引用数达下限", len(pins) >= min_pins, f"uses={len(pins)} 下限={min_pins}"),
        ("每条 uses 行都能被枚举器解析", not unparsed, "; ".join(unparsed) or "无"),
    ]

    floating = [p for p in pins if not p.is_local and not p.pinned]
    rows.append(("所有 action 引用钉到 40 位提交号", not floating,
                 "; ".join(f"{p.where()} {p.target}@{p.ref}" for p in floating) or "无"))

    no_tag = [p for p in pins if p.pinned and not p.declared_tag]
    rows.append(("每处钉版都带人读版本注释", not no_tag, "; ".join(p.where() for p in no_tag) or "无"))

    # 同一 action 全仓只钉一个提交号：分裂版本意味着同一个 CI 里两个作业跑的是同一 action 的
    # 两套实现，产物格式差异（artifact 命名/元数据）只会在特定作业里暴露，而这恰好是最难归因的一类红。
    by_target: dict[str, set[str]] = {}
    for p in pins:
        if p.pinned:
            by_target.setdefault(p.target, set()).add(p.ref)
    split = {t: s for t, s in by_target.items() if len(s) > 1}
    rows.append(("同一 action 全仓只钉一个提交号", not split,
                 "; ".join(f"{t} -> {sorted(x[:8] for x in s)}" for t, s in sorted(split.items())) or "无"))

    grant_map = {f: all_grants(t) for f, t in files}
    # 取「顶层显式 permissions 块」为在场判据：与 phlox 4/4 同一取向——默认最小权限写在文件顶层，
    # job 级只作为可见增量存在；否则"忘了写"与"故意不写"在文件里长得一模一样。
    text_of: dict[str, str] = dict(files)
    no_perms = [f for f in names if scan_permissions(text_of[f])[0] is None]
    rows.append(("每份工作流顶层显式声明 permissions", not no_perms, "; ".join(no_perms) or "无"))

    for scope, allowed in sorted(WRITE_ALLOW.items()):
        offenders = [f"{f}:{s.split('/')[-1]}=write"
                     for f in names for s, v in grant_map[f].items()
                     if v == "write" and s.split("/")[-1] == scope and f not in allowed]
        rows.append((f"最小权限：{scope}: write 仅限 {sorted(allowed)}", not offenders, "; ".join(offenders) or "无"))

    illegal = [f"{f}:{s}=write" for f in names for s, v in grant_map[f].items()
               if v == "write" and s.split("/")[-1] in NEVER_WRITE]
    rows.append(("最小权限：禁止的写权限零出现", not illegal, "; ".join(illegal) or "无"))

    prts = [f"{f}:{ln}" for f, t in files for ln, line in enumerate(t.splitlines(), 1)
            if re.match(r"^\s*pull_request_target\s*:", line)]
    rows.append(("不使用 pull_request_target（fork 可拿 secrets）", not prts, "; ".join(prts) or "无"))

    cred: dict[str, str] = {}
    for fname, text in files:
        cred.update(checkout_credential_state(text, [p for p in pins if p.fname == fname]))
    bad = {k: v for k, v in cred.items() if v != "false" and k.split(":")[0] not in CREDENTIALED_ALLOW}
    rows.append(("checkout 一律不留持久凭据（persist-credentials: false）", not bad,
                 "; ".join(f"{k}={v}" for k, v in sorted(bad.items())) or "无"))
    return rows


def upstream_checks(pins: list[Pin], provider: Callable[[str], dict[str, str] | None]) -> tuple[list[Row], int]:
    """外部真值判据：注释声明的 tag 必须在上游存在，且其指向的提交号 == 钉的那个。"""
    unresolved = 0
    bad: list[str] = []
    for p in pins:
        if p.is_local or not p.pinned:
            continue
        tags = provider(p.target)
        if tags is None:
            unresolved += 1
            bad.append(f"{p.where()} 读不到上游 {p.target} 的 tag 清单")
            continue
        declared = p.declared_tag
        if declared not in tags:
            bad.append(f"{p.where()} 上游 {p.target} 不存在 tag `{declared}`")
        elif tags[declared] != p.ref:
            bad.append(f"{p.where()} tag {declared} 实指 {tags[declared][:12]}，工作流钉的却是 {p.ref[:12]}")
    rows: list[Row] = [
        ("上游 tag 清单可解析（取不到不静默放行）", unresolved == 0, f"unresolved={unresolved}" if unresolved else "全部可读"),
        ("钉版与上游 tag 指向逐字对账", not bad, "; ".join(bad) or "无"),
    ]
    return rows, unresolved


def report(rows: list[Row], pin_count: int, file_count: int, quiet: bool = False) -> int:
    failed = [name for name, ok, _ in rows if not ok]
    for name, ok, detail in rows:
        # SKIPPED 一律可见：静默跳过与"没这条判据"在输出上无法区分，正是假绿的形状。
        if ok and quiet and "SKIPPED" not in detail:
            continue
        print(f"{'PASS' if ok else 'FAIL'} :: {name}" + ("" if ok else f" :: {detail}"))
    print(f"[GATE:action-pin-{'pass' if not failed else 'fail'}] {len(rows) - len(failed)}/{len(rows)} 项通过"
          f"（action 引用 {pin_count} 处，工作流 {file_count} 份）")
    return 1 if failed else 0


def run_verify(files: list[tuple[str, str]], tok: str, quiet: bool, offline: bool = False) -> int:
    pins, unparsed = iter_pins(files)
    rows = local_checks(files, pins, unparsed)
    unresolved = 0
    if offline:
        # 显式记 SKIPPED 而不是不出这一行：pre-commit 走离线档，权威判定仍在 CI（本机绿≠钉版为真）。
        rows.append(("上游 tag 逐字对账", True, "SKIPPED（--offline，CI 侧不带此旗标必跑）"))
    else:
        upstream_rows, unresolved = upstream_checks(pins, live_tag_provider(tok))
        rows += upstream_rows
    rc = report(rows, len(pins), len(files), quiet)
    if rc == 0 and unresolved:
        print("上游真值未取全，按环境错误处理（零输入不得记 PASS）", file=sys.stderr)
        return 2
    return rc


def run_resolve(files: list[tuple[str, str]], tok: str, apply: bool) -> int:
    pins, unparsed = iter_pins(files)
    if unparsed:
        print(f"[GATE:action-pin-fail] 先修复无法解析的 uses 行：{unparsed}", file=sys.stderr)
        return 2
    provider = live_tag_provider(tok)
    plan: list[tuple[str, int, str]] = []
    for p in pins:
        if p.is_local or p.pinned:
            continue
        tags = provider(p.target)
        if tags is None:
            print(f"[GATE:action-pin-fail] 取不到上游 {p.target} 的 tag 清单，拒绝半钉", file=sys.stderr)
            return 2
        sha = tags.get(p.ref)
        if not sha and not SHA_RE.match(p.ref):
            data = gh_get("/repos/" + "/".join(p.target.split("/")[:2]) + f"/commits/{p.ref}", tok)
            sha = data.get("sha", "") if isinstance(data, dict) else ""
        if not sha:
            print(f"[GATE:action-pin-fail] 上游 {p.target} 解析不到 ref `{p.ref}`", file=sys.stderr)
            return 2
        label = precise_label(sha, tags, p.ref)
        plan.append((p.fname, p.lineno, f"{p.head}{p.target}@{sha}  # {label}"))
        print(f"{p.where()}: {p.target}@{p.ref} -> {sha[:12]} ({label})")

    if not plan:
        print("没有待钉的浮动引用（已全部钉版）")
        return 0
    if not apply:
        print(f"[GATE:action-pin-dry] 计划改写 {len(plan)} 处；加 --apply 才落盘")
        return 0

    by_file: dict[str, list[str]] = {f: text.splitlines() for f, text in files}
    for fname, lineno, replacement in sorted(plan, key=lambda x: (x[0], -x[1])):
        by_file[fname][lineno - 1] = replacement
    for fname in by_file:
        (WF_DIR / fname).write_text("\n".join(by_file[fname]) + "\n", encoding="utf-8", newline="\n")
    print(f"[GATE:action-pin-pass] 已改写 {len(plan)} 处为钉版（带版本注释）")
    return 0


GOOD_BODY = """name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
  packages: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@08cfa17a92b49b6278e03f50f3247f3d7d08cb0c  # v7.0.1
        with:
          persist-credentials: false
"""
GOOD_SHA = "08cfa17a92b49b6278e03f50f3247f3d7d08cb0c"


def run_selftest() -> int:
    """反例自证：每条判据都要被一个坏样本抓到，否则它可能只是永不失败的空断言。

    上游真值判据在这里喂桩 provider（零网络），并额外含一条**正向对照**——同一份真值表下合规样本
    必须判绿，否则"永远判红"的判据也会被这套自证当成合格。
    """
    def good_files(n: int = MIN_WORKFLOWS) -> list[tuple[str, str]]:
        return [(f"w{i}.yml", GOOD_BODY) for i in range(n)]

    def mutated(old: str, new: str) -> list[tuple[str, str]]:
        return good_files() + [("ci.yml", GOOD_BODY.replace(old, new))]

    stub = {GOOD_SHA: GOOD_SHA, "v7.0.1": GOOD_SHA, "v9.9.9": "f" * 40}

    def ok_provider(_t: str) -> dict[str, str] | None:
        return dict(stub)

    def none_provider(_t: str) -> dict[str, str] | None:
        return None

    cases: list[tuple[str, list[tuple[str, str]], bool, bool, bool]] = [
        ("正样本全绿（含上游对账通过）", good_files(), True, True, False),
        ("浮动 ref 判红", mutated(f"@{GOOD_SHA}  # v7.0.1", "@v7"), False, True, False),
        ("缺版本注释判红", mutated("  # v7.0.1", ""), False, True, False),
        ("钉到非 tag 提交号判红", mutated("@" + GOOD_SHA, "@" + "1" * 40), False, True, False),
        ("tag 指向与钉版不符判红", good_files() + [("ci.yml", GOOD_BODY.replace("# v7.0.1", "# v9.9.9"))], False, True, False),
        ("缺 permissions 判红", mutated("permissions:\n  contents: read\n  packages: read\n", ""), False, True, False),
        ("contents: write 越权判红", mutated("contents: read", "contents: write"), False, True, False),
        ("workflows: write 判红", mutated("packages: read", "workflows: write"), False, True, False),
        ("pull_request_target 判红", mutated("  push:", "  pull_request_target:\n    branches: [main]\n  push:"), False, True, False),
        ("checkout 未关持久凭据判红", mutated("        with:\n          persist-credentials: false\n", ""), False, True, False),
        ("同一 action 双提交号判红", good_files() + [("ci2.yml", GOOD_BODY.replace(GOOD_SHA, "2" * 40))], False, True, False),
        ("uses 行解析不了判红", good_files() + [("ci3.yml", GOOD_BODY + "  c:\n    steps:\n      -   uses:\n")], False, True, False),
        ("扫描面为空判红", _two(), False, True, True),
        ("上游读不到时判环境错误（不得记绿）", good_files(), False, False, False),
    ]
    passed = 0
    for label, files, expect_green, network_ok, real_min in cases:
        pins, unparsed = iter_pins(files)
        # 覆盖面判据按真值下限跑（否则"下限本身是否生效"永不被测）；其余样本用 1/1 以免误归因。
        mins = (MIN_WORKFLOWS, MIN_PINS) if real_min else (1, 1)
        rows = local_checks(files, pins, unparsed, min_workflows=mins[0], min_pins=mins[1])
        up_rows, unresolved = upstream_checks(pins, ok_provider if network_ok else none_provider)
        rows += up_rows
        bad = [n for n, ok, _ in rows if not ok]
        env_err = unresolved > 0
        if expect_green:
            ok = not bad and not env_err
        else:
            ok = bool(bad) or env_err
        print(f"{'ok  ' if ok else 'BAD '} :: {label}"
              + ("" if ok else f" -> 判红项={bad or '无'} 环境错误={env_err}"))
        passed += 1 if ok else 0
    print(f"[GATE:action-pin-selftest-{'pass' if passed == len(cases) else 'fail'}] {passed}/{len(cases)}")
    return 0 if passed == len(cases) else 1


def _two() -> list[tuple[str, str]]:
    return [("a.yml", GOOD_BODY), ("b.yml", GOOD_BODY)]


def main() -> int:
    ap = argparse.ArgumentParser(description="GitHub Actions 钉版迁移与判据（共用同一枚举器）")
    ap.add_argument("--verify", action="store_true", help="跑判据（默认动作）")
    ap.add_argument("--resolve", action="store_true", help="解析浮动 ref 并（配 --apply）改写为钉版")
    ap.add_argument("--apply", action="store_true", help="与 --resolve 连用才落盘")
    ap.add_argument("--selftest", action="store_true", help="反例自证（零网络）")
    ap.add_argument("--quiet", action="store_true", help="只打印失败项")
    ap.add_argument("--offline", action="store_true",
                    help="跳过上真值对账（pre-commit 用；CI 侧不带此旗标，权威判定在 CI）")
    args = ap.parse_args()

    if args.selftest:
        return run_selftest()
    files = read_workflows()
    tok = token()
    if args.resolve:
        return run_resolve(files, tok, args.apply)
    if not tok and not args.offline:
        print("[GATE:action-pin-fail] 无 GitHub Token：上游 tag 无法核对，而「取不到」不等于「通过」"
              "（本机快检请加 --offline，权威判定仍由 CI 出）", file=sys.stderr)
        return 2
    return run_verify(files, tok, args.quiet, args.offline)


if __name__ == "__main__":
    sys.exit(main())
