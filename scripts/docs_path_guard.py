#!/usr/bin/env python3
"""耐久面里的「反引号路径引用」必须**从仓根解析得到**（第四十八轮）。

为什么立这条（一手实测，不是"peer 有所以我也要有"）：
  本轮把 `AGENTS.md`/`README.md`/`CONTRIBUTING.md`/`docs/*.md` 里所有反引号包着的 path 形引用扫了一遍
  ——**212 条**，其中 **15 条从仓根打不开**：8 条写成 `fixtures/*.json` 而真身在 `frontend/tests/fixtures/`、
  `lib/observe.js` 真身在 `frontend/functions/lib/`、`routers/api.py` 在 `backend/app/routers/`，
  另有 2 条 `work/sweep_semantic_weights.mjs` **根本不在本仓**（在工作区私有面里，评审侧永远打不开）。
  ⇒ 对第二个开发者／评审来说，"照文档去点开文件"这一步就是断的（R240：被文档引用的路径须实测存在）。

口径（三条硬要求，缺一即误报或漏报）：
  1. **只认 path 形 token**：含 `/`、以已知扩展名结尾、且不含 `*<>{}$ `、不以 `.`/`/`/`~` 开头。
     写成 glob／带占位符／带参数的不算——那些是命令或模式，不是"点开就能看"的路径。
  2. **判定基准＝仓根**（相对本文件所在仓）。允许 `frontend/tests/fixtures/x.json` 这种全路径，
     不允许 `fixtures/x.json` 这种"按模块根短写"——短写在人眼里有上下文，在 agent 与工具链里没有，
     而且**判据一旦接受"任意基目录都能解析"就永远绿**（那是把判据写成自比，见 lessons「measure() 自比」形态）。
  3. **零输入即红**：一条 path 形引用都没扫到＝取数面坏（扩展名表/正则写坏了），绝不记"全部通过"。

用法：
  python scripts/docs_path_guard.py            # 扫并把死链判红（rc=1）
  python scripts/docs_path_guard.py --json     # 机读
  python scripts/docs_path_guard.py --selftest # 夹具（含专属输入面与反向腿）
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT

#: 判据的取数面：这些是"给第二个开发者/评审读的耐久说明书"。
FACES = ("AGENTS.md", "README.md", "CONTRIBUTING.md", "docs")

EXTS = ("py", "mjs", "js", "json", "md", "yml", "yaml", "css", "html", "ts", "tsx",
        "sh", "toml", "txt", "sql", "mod", "sum", "lock", "csv")

BACKTICK = re.compile(r"`([^`\n]{2,160})`")
TRAILING = re.compile(r"[，。；：、)（）:;,.\s]+$")


def pathish(tok: str) -> bool:
    """token 是否"声称是一条可点开的路径"。"""
    t = TRAILING.sub("", tok.strip())
    if not t or any(c in t for c in "*<>{}$ \t'\"") or t.startswith(("/", "~", "./", "../")):
        return False
    if "/" not in t:
        return False
    return t.rsplit(".", 1)[-1].lower() in EXTS


def norm(tok: str) -> str:
    return TRAILING.sub("", tok.strip())


def harvest(text: str) -> list[str]:
    """抽出一段文本里全部 path 形引用（按出现顺序，去重保留首次）。"""
    out: list[str] = []
    for m in BACKTICK.finditer(text):
        t = m.group(1)
        if pathish(t):
            n = norm(t)
            if n not in out:
                out.append(n)
    return out


def resolve(rel: str, root: Path) -> bool:
    """从**仓根**能不能打到这个文件/目录（唯一基准；不接受"换个基目录再试"）。"""
    return (root / rel).exists()


def faces(root: Path) -> list[Path]:
    out: list[Path] = []
    for name in FACES:
        p = root / name
        if p.is_file():
            out.append(p)
        elif p.is_dir():
            out.extend(sorted(p.rglob("*.md")))
    return out


def check(root: Path, base: Path | None = None) -> tuple[list[str], int, list[str]]:
    """返回 (死链行, path 形引用总数, 空面板点名)。base 缺省＝root（测试时可分开）。"""
    base = base or root
    refs_total = 0
    bad: list[str] = []
    scanned: list[str] = []
    for f in faces(root):
        scanned.append(str(f.relative_to(root)))
        text = f.read_text(encoding="utf-8", errors="replace")
        for rel in harvest(text):
            refs_total += 1
            if not resolve(rel, base):
                bad.append(f"{f.relative_to(root)} -> {rel}")
    empty = [] if scanned else ["一个耐久面都没读到"]
    return sorted(set(bad)), refs_total, empty


def root_hook_files(repo: Path) -> set[str]:
    """解析 .pre-commit-config.yaml 里本判据钩子的 `files:`，展开成"当前盘上真实被覆盖的面"。

    只认本脚本的钩子 id（`docs-path-guard`），别的钩子的 files: 不算数——否则任一钩子覆盖就会伪装成"我覆盖了"。
    正则→成员的换算不做通配猜测：逐个耐久面文件名拿 re.search 试，试中算覆盖（口径与 pre-commit 自己一致）。
    """
    cfg = repo / ".pre-commit-config.yaml"
    if not cfg.is_file():
        return set()
    txt = cfg.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"id: docs-path-guard.*?\n\s+files: (.+)$", txt, re.S)
    if not m:
        return set()
    pat = m.group(1).strip()
    out: set[str] = set()
    for f in faces(repo):
        rel = f.relative_to(repo).as_posix()
        try:
            if re.search(pat, rel):
                out.add(rel)
        except re.error:
            return set()
    return out


def selftest() -> int:
    import tempfile
    cases: list[tuple[str, bool, str]] = []

    def mk(root: Path, rel: str, body: str) -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")

    good = Path(tempfile.mkdtemp(prefix="dpg_good_"))
    mk(good, "frontend/tests/fixtures/a.json", "")
    mk(good, "docs/GUIDE.md", "见 `frontend/tests/fixtures/a.json` 与 `docs/GUIDE.md`。\n")
    mk(good, "README.md", "# x\n")
    bad_rows, total, empty = check(good)
    cases.append(("真面：两条仓根可解析的引用（含自指）⇒ 零死链且计数==2", bad_rows == [] and total == 2, f"{bad_rows} refs={total}"))

    dead = Path(tempfile.mkdtemp(prefix="dpg_dead_"))
    mk(dead, "frontend/tests/fixtures/a.json", "")
    mk(dead, "docs/GUIDE.md", "真身在这里 `fixtures/a.json`，还有一条根本不存在 `tools/nope.py`\n")
    mk(dead, "README.md", "# x\n")
    bad_rows, total, _e = check(dead)
    cases.append(("短写基目录（`fixtures/a.json`）必须判红——判据不接受『换个基目录再试』，否则永绿",
                  any("fixtures/a.json" in r for r in bad_rows), str(bad_rows)))
    cases.append(("真死链（全仓没有）判红并点名", any("tools/nope.py" in r for r in bad_rows), str(bad_rows)))
    cases.append(("引用总数分母与实数一致（防『只报第一条』）", total == 2, f"refs={total}"))

    globface = Path(tempfile.mkdtemp(prefix="dpg_glob_"))
    mk(globface, "docs/G.md", "`backend/app/*.py` `scripts/x.py --flag` `python a.py --check` `docs/{a,b}.md`\n"
                             "裸文件名也不算：`README.md` `wrangler.toml` `knowledge.json`\n")
    mk(globface, "README.md", "# x\n")
    _b2, total2, _e2 = check(globface)
    cases.append(("glob／带参数／带占位符的 token 不算路径引用（防误报成百条）", total2 == 0, f"refs={total2}"))
    # 专属输入面（变异 M2「放行无斜杠 token」只有这一条能逮住）：裸文件名必须被排除。
    # 少了这条，"必须含 /" 这条规则就是无人守的暗规则——把它写进夹具而不是注释，是因为注释不会被执行。
    cases.append(("裸文件名（`README.md`/`wrangler.toml`）被斜杠规则排除＝该规则真的在生效",
                  total2 == 0 and not pathish("README.md") and pathish("docs/README.md"),
                  f"pathish(README.md)={pathish('README.md')} refs={total2}"))

    zero = Path(tempfile.mkdtemp(prefix="dpg_zero_"))
    _b3, total3, empty3 = check(zero)
    cases.append(("零输入：一个耐久面都没读到 ⇒ 判取数面坏，不许记绿", bool(empty3) and total3 == 0, f"{empty3} refs={total3}"))

    # 解析函数的独立反向腿：目录也算可解析（文档会指目录），但绝不接受越界
    ok_case = Path(tempfile.mkdtemp(prefix="dpg_dir_"))
    mk(ok_case, "docs/G.md", "看 `frontend/src` 目录")
    mk(ok_case / "frontend", "src/keep.md", "")
    cases.append(("引用指向目录也算在场（`frontend/src`）", resolve("frontend/src", ok_case), "resolve()"))
    cases.append(("越界路径不参与（上面已排除以 / .. 开头的形态）", not pathish("../secret/x.py"), "pathish()"))

    # 钩子覆盖对账（r44 同族）：**本判据扫的每个面，都必须在 .pre-commit-config.yaml 里被自己的 files: 命中**。
    # 只测"脚本能扫到"不够——扩面而钩子没跟上时，钩子在真实提交里打印 Skipped，判据等于没接线（历史上犯过三次）。
    hook_face = root_hook_files(REPO)
    # 两侧必须同一口径：`str(relative_to())` 在 Windows 上给 `docs\X.md`，而钩子的 files: 匹配 posix 形态，
    # 混用会让"未覆盖"整屏假阳性（r44 同一坑，当时是靠"解析结果不得含反斜杠"这条腿逮住的，这里照搬）。
    rels = [x.relative_to(REPO).as_posix() for x in faces(REPO)]
    uncov = [f for f in rels if f not in hook_face]
    cases.append(("真实面：本判据扫的每个耐久面都在 pre-commit 的 files: 射程内",
                  bool(hook_face) and uncov == [], f"未覆盖={uncov[:3]} 射程面数={len(hook_face)}"))
    cases.append(("枚举结果不得含反斜杠（跨平台口径腿，防把真覆盖判成假缺失）",
                  not any("\\" in r for r in rels), f"含反斜杠={[r for r in rels if chr(92) in r][:2]}"))
    cases.append(("钩子读不到＝判红（缺载体不许记绿，也不许把这条用例静默跳过）",
                  root_hook_files(Path(tempfile.gettempdir()) / "nope-such-repo") == set(), "空射程"))

    bad_n = sum(0 if ok else 1 for _n, ok, _d in cases)
    for name, ok, detail in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name} :: {detail[:88]}")
    print(f"SELFTEST: {len(cases) - bad_n}/{len(cases)}")
    print("[GATE:docs-path-guard-selftest-pass]" if bad_n == 0 else "[GATE:docs-path-guard-selftest-fail]")
    return 0 if bad_n == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--root", default="", help="被扫仓根（默认本文件所在仓）")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    root = Path(a.root).resolve() if a.root else ROOT
    bad, total, empty = check(root)
    # ⚠️ `--json` 模式下 stdout 只准有一行 JSON：判据行/告警一律走 stderr，
    #    否则消费方 `json.loads` 会读到尾巴上的 `[GATE:...]` 而炸成"Extra data"（本轮自踩一次，见 lessons）。
    out = sys.stderr if a.json else sys.stdout
    if a.json:
        print(json.dumps({"refs": total, "dead": bad, "empty_faces": empty}, ensure_ascii=False))
    else:
        print(f"取数面＝AGENTS.md/README.md/CONTRIBUTING.md/docs/*.md｜path 形引用 {total} 条｜"
              f"从仓根解析不到 {len(bad)} 条")
        for b in bad:
            print(f"  DEAD :: {b}")
        for e in empty:
            print(f"  EMPTY :: {e}")
    if empty or total == 0:
        print("[GATE:docs-path-guard-empty]", file=out)
        return 2
    print("[GATE:docs-path-guard-pass]" if not bad else "[GATE:docs-path-guard-fail]", file=out)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
