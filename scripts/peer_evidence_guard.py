#!/usr/bin/env python3
"""对标取证纪律守卫：peer 名册与自述读数必须**可复算**（第八十九轮）。

为什么立这条（一手实测，不是"peer 有所以我也要有"）：
  本轮做八维对标时连撞四个取数陷阱，每一个都会让报告写出**看起来像结论的错数**：
  ① 短名 peer（`ragflow` 这类）同时造成"解析失败"与"类别错判"——全名可解析也可能是一堆论文的课题 monorepo，
     所以还必须过"身份≠能力"核验（README 首屏有安装信号 + 顶层有可运行目录）。
  ② 把 `open_issues_count`（**未闭数，含 PR**）当"issue 响应速度"——分子分母根本不同。
     响应速度只能由"已闭 issue 的 created→closed 分布"现算，且**样本量必须随行**；
     实测算样本端点影响一个数量级：`issues?state=closed&per_page=50` 在 openemr 一页 50 条里只有 2 条非 PR，
     换 `search/issues + closed:>=` 才升到 29。
  ③ 引用对方 README 的性能/质量数字而不给复算命令——那是"不可复算的数"，进不了结论。
  ④ 管道测量型假值：`git log --oneline | Measure-Object -Line` 返回 **1**（真值 162）、
     `git --no-pager tag | Measure-Object -Line` 返回 **1**（真值 60）。本轮首读就是假值。

口径（五条硬要求，缺一即误报或漏报）：
  1. **零输入即红**：一份名册都没读到条目 ⇒ 取数面坏（路径写错/文件空），绝不记"全部通过"。
  2. **取数失败 ≠ 没有数据**：`fetch_error` 存在的条目不得同时声称数字读数，
     也不得因字段缺失被静默跳过（静默 continue 是"条目被判假"的同族）。
  3. **样本量随行**：任何分布型读数（出现 `median_hours`/`p50_hours`/`p90_hours` 之一）
     必须带 `sample_n` 与中文 `口径`；`sample_n` 必须是正整数。
  4. **不接受"换基目录再试"**：名册路径由 `--roster` 显式给定，不做多目录搜索。
  5. **两种面都查**：`--mode peer` 查对方读数；`--mode self` 查我方自述读数
     （每条 fact 必须配 `recompute_cmd`，且复算命令不得用第 ④ 条的假值形态）。

用法：
  python scripts/peer_evidence_guard.py                               # 查默认名册（仓内 fixture）
  python scripts/peer_evidence_guard.py --mode self --roster <path>   # 查我方读数文件
  python scripts/peer_evidence_guard.py --json                        # 机读（stdout 只准一行 JSON）
  python scripts/peer_evidence_guard.py --selftest                    # 夹具（含专属输入面与反向腿）
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROSTER = ROOT / "frontend" / "tests" / "fixtures" / "bench_peer_roster.json"

#: `owner/name` 全名：恰好一个斜杠、两侧非空、无空白。短名与三段路径都不算。
FULL_NAME = re.compile(r"^[^/\s]+/[^/\s]+$")
#: 取数时刻：ISO 8601 日期开头（YYYY-MM-DD…），只要日期段即可。
FETCHED_AT = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?")
#: 分布型读数的判定键：出现任一即视为"分布"，必须配样本量与口径。
DIST_KEYS = ("median_hours", "p50_hours", "p90_hours", "p95_hours", "max_hours", "min_hours")
#: 第 ④ 条陷阱：管道测量型假值。git log/git tag 与 | Measure-Object 同时出现即判红。
PIPE_MEASURE = re.compile(r"git\s+(?:--no-pager\s+)?(?:log|tag)\b[^|;]*\|\s*Measure-Object", re.I)


def is_full_name(v) -> bool:
    return isinstance(v, str) and bool(FULL_NAME.match(v.strip()))


def is_fetched_at(v) -> bool:
    return isinstance(v, str) and bool(FETCHED_AT.match(v.strip()))


def _walk_dicts(obj):
    """递归产出所有 dict（self 模式下 fact 可能嵌在任意层）。"""
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from _walk_dicts(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_dicts(v)


def check_peer(roster: dict) -> tuple[list[str], int]:
    """返回 (违规行, 读到的条目数)。"""
    bad: list[str] = []
    peers = roster.get("peers") if isinstance(roster, dict) else None
    if not isinstance(peers, list):
        return ["名册缺 peers 数组（或顶层不是对象）"], 0
    for i, p in enumerate(peers):
        if not isinstance(p, dict):
            bad.append(f"#{i}: 条目不是对象")
            continue
        tag = p.get("full_name") if isinstance(p.get("full_name"), str) else f"#{i}"
        if not is_full_name(p.get("full_name")):
            bad.append(f"{tag}: full_name 必须是 owner/name 全名（短名造成解析失败与类别错判两重代价）")
        if not is_fetched_at(p.get("fetched_at")):
            bad.append(f"{tag}: 缺 fetched_at（数字类必须当日现取并写取数时刻）")
        if not (isinstance(p.get("can_recompute"), str) and p["can_recompute"].strip()):
            bad.append(f"{tag}: 缺 can_recompute 标注（对方数字不可复算时必须显式说明，不得直接进结论）")
        if "open_issues_count" in p:
            bad.append(f"{tag}: 字段名 open_issues_count 被禁用——它是未闭数（含 PR）不是响应速度，"
                       f"须写成 *_unclosed* 并附 note")
        if "fetch_error" in p:
            numeric = [k for k, v in p.items() if isinstance(v, (int, float)) and not isinstance(v, bool)]
            if numeric:
                bad.append(f"{tag}: 有 fetch_error 却同时带数字读数 {numeric[:4]}——取数失败不得读成 0")
        for k, v in p.items():
            if not isinstance(v, dict) or not any(dk in v for dk in DIST_KEYS):
                continue
            n = v.get("sample_n")
            if not (isinstance(n, int) and not isinstance(n, bool) and n >= 1):
                bad.append(f"{tag}.{k}: 分布型读数缺合法 sample_n（当前={n!r}）")
            if not (isinstance(v.get("口径"), str) and v["口径"].strip()):
                bad.append(f"{tag}.{k}: 分布型读数缺中文口径（样本量 N 小只能声称 N 内结论）")
    return bad, len(peers)


def check_self(roster: dict) -> tuple[list[str], int]:
    """返回 (违规行, 读到的 fact 数）。fact ＝ 含 value 或 recompute_cmd 键的 dict。"""
    bad: list[str] = []
    facts = 0
    for d in _walk_dicts(roster):
        if "value" not in d and "recompute_cmd" not in d:
            continue
        label = d.get("key") or d.get("id") or d.get("name") or f"#{facts}"
        facts += 1
        cmd = d.get("recompute_cmd")
        if not (isinstance(cmd, str) and cmd.strip()):
            bad.append(f"{label}: 缺 recompute_cmd（我方读数不给复算命令 ⇒ 该格不可复算）")
            continue
        if PIPE_MEASURE.search(cmd):
            bad.append(f"{label}: recompute_cmd 用了管道测量形态 `git log/tag … | Measure-Object`——"
                       f"该形态在本机返回 1（假值），须改 git rev-list --count 或直接列举")
    return bad, facts


def _clone(obj: dict[str, Any]) -> dict[str, Any]:
    """深拷贝夹具并保住 dict[str, Any] 口径——直接 deepcopy 会退化成 object，
    之后的下标赋值/`.pop` 在 mypy 下变成 attr-defined 错（真踩过）。"""
    return copy.deepcopy(obj)


def selftest() -> int:
    cases: list[tuple[str, bool, str]] = []

    good_peer: dict[str, Any] = {
        "peers": [{
            "full_name": "openemr/openemr", "fetched_at": "2026-10-02T13:20:00Z",
            "can_recompute": "gh api 逐条复算", "stars": 5490,
            "open_issues_count_unclosed_including_prs": 1139,
            "closed_issue_response": {"sample_n": 29, "median_hours": 83.98, "口径": "created→closed；N=29"},
        }]
    }
    bad0, n0 = check_peer(good_peer)
    cases.append(("真面：合规名册 ⇒ 零违规且条目数==1", bad0 == [] and n0 == 1, f"{bad0} n={n0}"))

    short = _clone(good_peer)
    short["peers"][0]["full_name"] = "ragflow"
    b1, _ = check_peer(short)
    cases.append(("短名 peer 判红（解析失败与类别错判两重代价）", any("全名" in x for x in b1), str(b1[:1])))

    nofetch = _clone(good_peer)
    nofetch["peers"][0].pop("fetched_at")
    b2, _ = check_peer(nofetch)
    cases.append(("缺 fetched_at 判红", any("fetched_at" in x for x in b2), str(b2[:1])))

    norec = _clone(good_peer)
    norec["peers"][0].pop("can_recompute")
    b3, _ = check_peer(norec)
    cases.append(("缺 can_recompute 判红", any("can_recompute" in x for x in b3), str(b3[:1])))

    misnomer = _clone(good_peer)
    misnomer["peers"][0]["open_issues_count"] = 1139
    b4, _ = check_peer(misnomer)
    cases.append(("字段名 open_issues_count 判红（未闭数含 PR，不是响应速度）",
                  any("open_issues_count" in x for x in b4), str(b4[:1])))

    nosample = _clone(good_peer)
    nosample["peers"][0]["closed_issue_response"].pop("sample_n")
    b5, _ = check_peer(nosample)
    nokou = _clone(good_peer)
    nokou["peers"][0]["closed_issue_response"].pop("口径")
    b5b, _ = check_peer(nokou)
    cases.append(("分布读数缺 sample_n 判红", any("sample_n" in x for x in b5), str(b5[:1])))
    cases.append(("分布读数缺口径 判红", any("口径" in x for x in b5b), str(b5b[:1])))

    zero_n = _clone(good_peer)
    zero_n["peers"][0]["closed_issue_response"]["sample_n"] = 0
    b6, _ = check_peer(zero_n)
    cases.append(("sample_n=0 判红（零样本不得读成无差异）", any("sample_n" in x for x in b6), str(b6[:1])))

    failed = _clone(good_peer)
    failed["peers"][0]["fetch_error"] = "403 rate limit"
    b7, _ = check_peer(failed)
    cases.append(("有 fetch_error 却带数字读数 判红", any("fetch_error" in x for x in b7), str(b7[:1])))

    b8, n8 = check_peer({})
    cases.append(("零输入（名册无 peers）⇒ 判取数面坏且条目数==0", bool(b8) and n8 == 0, f"{b8} n={n8}"))

    good_self = {"inner": {"facts": {"commits_total": {
        "value": 162, "recompute_cmd": "git rev-list --count HEAD"}}}}
    s0, f0 = check_self(good_self)
    cases.append(("self 真面：合规 fact ⇒ 零违规且 fact 数==1", s0 == [] and f0 == 1, f"{s0} f={f0}"))

    pipe = {"facts": {"tags": {"value": 1, "recompute_cmd": "git --no-pager tag | Measure-Object -Line"}}}
    s1, _ = check_self(pipe)
    cases.append(("管道测量假值命令判红（git tag | Measure-Object 本机返回 1）",
                  any("管道测量" in x for x in s1), str(s1[:1])))
    pipelog = {"facts": {"c": {"value": 1, "recompute_cmd": "git log --oneline | Measure-Object -Line"}}}
    s1b, _ = check_self(pipelog)
    cases.append(("同上对 git log 形态同样判红", any("管道测量" in x for x in s1b), str(s1b[:1])))
    okpipe = {"facts": {"c": {"value": 1, "recompute_cmd": "git --no-pager log | Measure-Object -Line"}}}
    s1c, _ = check_self(okpipe)
    cases.append(("`--no-pager` 不得洗白假值形态（假值来自测量口径而非 pager）",
                  any("管道测量" in x for x in s1c), str(s1c[:1])))

    nocmd = {"facts": {"c": {"value": 1}}}
    s2, _ = check_self(nocmd)
    cases.append(("self 缺 recompute_cmd 判红", any("recompute_cmd" in x for x in s2), str(s2[:1])))
    s3, f3 = check_self({"facts": {}})
    cases.append(("self 零 fact ⇒ fact 数==0（须由调用方按取数面坏处理）", f3 == 0, f"f={f3}"))

    cases.append(("is_full_name 边界：a/b 通过，三段/带空白/空 全不通过",
                  is_full_name("a/b") and not is_full_name("a/b/c")
                  and not is_full_name(" ragflow ") and not is_full_name(""), "is_full_name()"))
    cases.append(("is_fetched_at 边界：日期段与 ISO 都通过、'yesterday' 不通过",
                  is_fetched_at("2026-10-02") and is_fetched_at("2026-10-02T10:00:00Z")
                  and not is_fetched_at("yesterday"), "is_fetched_at()"))

    if DEFAULT_ROSTER.is_file():
        real = json.loads(DEFAULT_ROSTER.read_text(encoding="utf-8"))
        rb, rn = check_peer(real)
        cases.append((f"真实面：默认名册 {DEFAULT_ROSTER.relative_to(ROOT).as_posix()} 存在且合规（n={rn}）",
                      rb == [] and rn > 0, f"{rb[:2]} n={rn}"))
    else:
        cases.append(("真实面：默认名册缺失 ⇒ 判红（不许记绿）", False, str(DEFAULT_ROSTER)))

    bad_n = sum(0 if ok else 1 for _n, ok, _d in cases)
    for name, ok, detail in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name} :: {detail[:88]}")
    print(f"SELFTEST: {len(cases) - bad_n}/{len(cases)}")
    print("[GATE:peer-evidence-guard-selftest-pass]" if bad_n == 0 else "[GATE:peer-evidence-guard-selftest-fail]")
    return 0 if bad_n == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("peer", "self"), default="peer")
    ap.add_argument("--roster", default="", help="名册路径（默认 peer 模式＝仓内 fixture）")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    path = Path(a.roster).resolve() if a.roster else DEFAULT_ROSTER
    out = sys.stderr if a.json else sys.stdout
    # 规则 4：只认显式路径，不做多目录搜索。
    if not path.is_file():
        print(f"[GATE:peer-evidence-guard-missing] roster={path}", file=out)
        return 2
    try:
        roster = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[GATE:peer-evidence-guard-badjson] roster={path} :: {e}", file=out)
        return 2

    if a.mode == "peer":
        bad, total = check_peer(roster)
        unit = "peer 条目"
    else:
        bad, total = check_self(roster)
        unit = "fact 条目"

    if a.json:
        print(json.dumps({"mode": a.mode, "roster": str(path), "checked": total,
                          "violations": bad}, ensure_ascii=False))
    else:
        print(f"取数面＝{path.name}｜模式 {a.mode}｜{unit} {total} 条｜违规 {len(bad)} 条")
        for b in bad:
            print(f"  VIOLATION :: {b}")

    # 规则 1：零输入即红（rc=2，不折成 0 也不折成 1）
    if total == 0:
        print("[GATE:peer-evidence-guard-empty]", file=out)
        return 2
    print("[GATE:peer-evidence-guard-pass]" if not bad else "[GATE:peer-evidence-guard-fail]", file=out)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
