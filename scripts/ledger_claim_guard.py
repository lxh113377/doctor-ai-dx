#!/usr/bin/env python
"""台账断言对账守卫（第四十五轮）。

为什么要有它（一手实测，不是"再加一条规矩"）：`memory/07-next-steps.md` 第 9 行挂着
「框架升级批（点头即开）：同一 PR 成批升（vite 6→8 ＋ plugin-react 4→6）」已经**二十二手**，
而盘上事实是 `58ef355`（第二十三轮）就把两个 major 成对升完了——实测：
`frontend/package.json` 声明 `"vite": "^8.3.0"`、`package-lock.json` 解析 `vite 8.3.1` ＋
`@vitejs/plugin-react 6.1.1`，且仓里当前 open PR=0。也就是说新对话每次开场都会读到一条
**不存在的欠账**，还会照着它去"成批升 vite"。

它判什么（三态，零输入绝不记绿）：
  PASS   现役清单行里每条"依赖 版本A→版本B"断言，其目标 major **尚未**在盘上达成（＝真欠账）
  FAIL   有断言的目标版本盘上早已达成（＝假欠账，点名行号＋依赖＋盘上现算值）
  EMPTY  现役面与历史卷**都**取不到任何版本断言 ⇒ 抽取式失效或面被搬空（rc=2，不判绿）

分母与射程（先算后写）：全量扫 `N→M` 形态实测 47 行 / 31 个文件，其中绝大多数是覆盖率与评分增量
（`67.04→74.02%`、`topics 0→15`）不是版本声明 ⇒ 只认"依赖名能在 package-lock / requirements 里
解析出来"的那些。历史分卷里的版本断言**只用作第二层分母证明**（已关闭的叙述体不得改写，与
CHANGELOG 豁免同源）。现役面＝07 壳的未勾行 ＋ 根 AGENTS.md 的未勾行。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

#: 依赖名紧邻版本号再跟箭头，或写 `dep 6→8`：`vite6→8`／`vite 6→8`／`@vitejs/plugin-react 4→6`
CLAIM_RE = re.compile(r"([A-Za-z@][A-Za-z0-9@/._-]*)\s*v?(\d+)(?:\.\d+)*\s*→\s*v?(\d+)")
OPEN_LINE = re.compile(r"^\s*- \[ \]")


def major_of(ver: str) -> int:
    m = re.match(r"(\d+)", str(ver))
    return int(m.group(1)) if m else -1


def installed_majors(repo: Path) -> dict[str, int]:
    """依赖名 → 盘上 major。JS 取 lock 的**解析值**（声明面是区间，不算数）；
    Py 取 requirements.txt 的声明 major（本机无 pip 解析时唯一可复算口径，取不到即不登记）。"""
    out: dict[str, int] = {}
    lock = repo / "frontend" / "package-lock.json"
    if lock.exists():
        try:
            data = json.loads(lock.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            data = {}
        for key, node in (data.get("packages") or {}).items():
            name = key.rsplit("node_modules/", 1)[-1]
            ver = str(node.get("version") or "")
            if not name or not ver:
                continue
            # 作用包包登记**两个键**：lock 里是 `@vitejs/plugin-react`，而台账常写作 `plugin-react`。
            # 只登记全名会让"半条断言"漏判（v1.42.0 实测：`vite 6→8` 被抓、同句 `plugin-react 4→6` 溜掉）
            names = {name.lower()}
            if "/" in name:
                names.add(name.rsplit("/", 1)[-1].lower())
            for n in names:
                out.setdefault(n, major_of(ver))
    req = repo / "backend" / "requirements.txt"
    if req.exists():
        for ln in req.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Za-z0-9._-]+)\s*[=<>~!]=?\s*v?(\d+)", ln.strip())
            if m:
                out.setdefault(m.group(1).lower(), int(m.group(2)))
    return {k: v for k, v in out.items() if v > 0}


def claims_in(text: str, known: dict[str, int]) -> list[tuple[int, str, int, str]]:
    """从台账文本抽 (行号, 依赖名, 声称的目标 major, 原文片段)；依赖名解析不出来的一律不认。"""
    hits = []
    for ln, line in enumerate(text.splitlines(), start=1):
        for m in CLAIM_RE.finditer(line):
            dep = m.group(1).lstrip("@").split("/")[-1].lower()
            if dep in known:
                hits.append((ln, dep, int(m.group(3)), line.strip()[:120]))
    return hits


def open_lines(shell: Path, agents: Path) -> list[tuple[str, int, str]]:
    rows: list[tuple[str, int, str]] = []
    for f in (shell, agents):
        if not f.exists():
            continue
        for ln, line in enumerate(f.read_text(encoding="utf-8").splitlines(), start=1):
            if OPEN_LINE.match(line):
                rows.append((f.name, ln, line))
    return rows


def check(ledger_dir: Path, repo: Path, verbose: bool) -> int:
    known = installed_majors(repo)
    if not known:
        print(f"EMPTY :: 取不到任何依赖版本面（{repo}/frontend/package-lock.json 与 backend/requirements.txt 均不可读）")
        print("[GATE:ledger-claim-empty]")
        return 2
    shell = ledger_dir / "07-next-steps.md"
    agents = ledger_dir.parent / "AGENTS.md"
    rows = open_lines(shell, agents)
    claims: list[tuple[str, int, str, int, str]] = []
    for face, line_no, line in rows:
        for _ln, dep, target, frag in claims_in(line, known):
            claims.append((face, line_no, dep, target, frag))
    hist = sum(len(claims_in(v.read_text(encoding="utf-8"), known))
               for v in sorted(ledger_dir.glob("07-next-steps.part*.md")))
    if verbose:
        print(f"== 台账版本断言对账（依赖版本面 {len(known)} 项｜现役未结行 {len(rows)} 条 ⇒ 版本断言 {len(claims)} 条｜"
              f"历史卷内断言 {hist} 处，只作分母证明）==")
    if not claims and hist == 0:
        print("EMPTY :: 现役面与历史卷都取不到版本断言 ⇒ 抽取式失效或面被搬空，不判绿")
        print("[GATE:ledger-claim-empty]")
        return 2
    bad = []
    for face, ln, dep, target, frag in claims:
        have = known.get(dep, -1)
        if have >= target:
            bad.append((face, ln, dep, target, have))
            print(f"FAIL {face}:{ln} 台账写「{dep} →{target}」仍是未结项，盘上实际 major={have}（现算自 package-lock/requirements）")
            print(f"      原文 …{frag}…")
        elif verbose:
            print(f"  ok   {face}:{ln} {dep} →{target}：盘上 major={have} ⇒ 真欠账")
    if bad:
        print(f"[GATE:ledger-claim-fail] 假欠账 {len(bad)} 条（改法＝按盘上事实关闭台账，而不是去改盘上版本）")
        return 1
    print(f"[GATE:ledger-claim-pass] 现役面 {len(claims)} 条版本断言与盘上一致；历史卷 {hist} 条不改写")
    return 0


def selftest(repo: Path) -> int:
    """反例自证：认得出两条真断言、不把覆盖率/无依赖名的 N→M 当版本、箭头右侧才算目标、零输入判 EMPTY。"""
    known = {"vite": 8, "plugin-react": 6}
    cases: list[tuple[str, bool, str]] = []
    fake = "- [ ] 框架升级批：**同一 PR 成批升**（vite 6→8 ＋ @vitejs/plugin-react 4→6）"
    hits = claims_in(fake, known)
    cases.append(("两条版本断言都被认出", len(hits) == 2, f"实测 {len(hits)}：{[h[1:3] for h in hits]}"))
    cases.append(("目标 major 取箭头右侧（6→8 记 8、4→6 记 6）",
                  [t for _l, _d, t, _f in hits] == [8, 6], f"实测 {[t for _l, _d, t, _f in hits]}"))
    cases.append(("覆盖率增量 `67.04→74.02%` 不得被认成版本断言",
                  claims_in("JS 分支 67.04→74.02%", known) == [], "实测误认"))
    cases.append(("无依赖名的 `topics 0→15` 不得被认成版本断言",
                  claims_in("topics 0→15", known) == [], "实测误认"))
    tmp = Path(tempfile.mkdtemp(prefix="lcg_"))
    (tmp / "07-next-steps.md").write_text("# 空台账\n- [ ] 与版本无关的一条\n", encoding="utf-8")
    rc_empty = check(tmp, repo, False)
    cases.append(("两面都取不到版本断言 ⇒ EMPTY rc=2（绝不记绿）", rc_empty == 2, f"实测 rc={rc_empty}"))
    fake_face = tmp / "07-next-steps.md"
    fake_face.write_text("# 台账\n- [ ] 升级 vite 6→8（盘上早已 8）\n", encoding="utf-8")
    rc_fake = check(tmp, _stub_repo_with_vite8(), False)
    cases.append(("假欠账必须判红（盘上 major 已达成 ⇒ rc=1 且点名行号）", rc_fake == 1, f"实测 rc={rc_fake}"))
    fake_face.write_text("# 台账\n- [ ] 升级 vite 6→9（盘上还是 8，确实没升完）\n", encoding="utf-8")
    rc_true = check(tmp, _stub_repo_with_vite8(), False)
    cases.append(("真欠账不得误报（目标 9 > 盘上 8 ⇒ rc=0，反向腿防假红）", rc_true == 0, f"实测 rc={rc_true}"))
    alias_known = installed_majors(_stub_repo_with_vite8(scoped=True))
    alias_line = "- [ ] 成批升 vite 6→9 ＋ plugin-react 4→9"
    alias_claims = claims_in(alias_line, alias_known)
    cases.append(("作用包别名：lock 写 `@vitejs/plugin-react`、台账写 `plugin-react` ⇒ 两条都要认出",
                  alias_known.get("vite") == 8 and alias_known.get("plugin-react") == 6 and len(alias_claims) == 2,
                  f"实测 known={{vite:{alias_known.get('vite')}, plugin-react:{alias_known.get('plugin-react') }}} 认出 {len(alias_claims)} 条"))
    bad = sum(0 if ok else 1 for _n, ok, _d in cases)
    for name, ok, detail in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
    print(f"SELFTEST: {len(cases) - bad}/{len(cases)}")
    print("[GATE:ledger-claim-selftest-fail]" if bad else "[GATE:ledger-claim-selftest-pass]")
    return 1 if bad else 0


def _stub_repo_with_vite8(scoped: bool = False) -> Path:
    """造一个只含 lock 的假仓，让"盘上 vite 已 8"这个事实由**数据**给出而不是判据写死。
    scoped=True 时再放一个作用域包 `@vitejs/plugin-react`（别名腿用）。"""
    d = Path(tempfile.mkdtemp(prefix="lcg_repo_"))
    fe = d / "frontend"
    fe.mkdir(parents=True, exist_ok=True)
    pkgs = {"node_modules/vite": {"version": "8.3.1"}}
    if scoped:
        pkgs["node_modules/@vitejs/plugin-react"] = {"version": "6.1.1"}
    (fe / "package-lock.json").write_text(json.dumps({"packages": pkgs}), encoding="utf-8")
    return d


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default="../memory", help="项目记忆目录（医/memory）")
    ap.add_argument("--repo", default=".", help="公开仓根（读 frontend/package-lock 与 backend/requirements）")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    repo = Path(a.repo).resolve()
    ledger = Path(a.ledger).resolve()
    return selftest(repo) if a.selftest else check(ledger, repo, not a.quiet)


if __name__ == "__main__":
    sys.exit(main())
