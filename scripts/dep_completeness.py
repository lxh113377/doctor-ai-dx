#!/usr/bin/env python
"""依赖声明完整性门禁（第二十三轮）：imported-but-undeclared 与 peer 相容性双生态对账。

对标取证（2026-09-26 实测）：`openemr/openemr` 有 `composer-require-checker.yml`——把"代码里用到、
但清单里没写"判成 CI 红。我方此前只核「锁 ↔ 声明」的钉版与哈希（lock_guard），从不核「import ↔ 声明」，
所以「靠传递依赖直接 import」一直无人拦。**首跑即抓到一条真实缺陷**：`backend/app/main.py:8` 直接
`from starlette.exceptions import HTTPException`，而 starlette 从未出现在声明面（v1.17.0 把 404
处理器注册到 Starlette 基类时引入）。它能工作只因为 fastapi 恰好带它——把运行时依赖挂在第三方包
的内部依赖上，正是 fastapi 换 ASGI 框架的那天会炸的那类债。

同源第二问：peer 相容性。台账#12/#20 单张升不动（ERESOLVE）的机制就是
`@vitejs/plugin-react` 声明了非 optional 的 `peer vite ^8.0.0`，而 vite 还停在 6.x。npm 装在
`--legacy-peer-deps` 下会**静默**违反 peer ⇒ 光靠"CI 能 npm ci"证明不了锁没被绕过，故在仓内复盘一次。

用法：
  python scripts/dep_completeness.py                # 全量判据
  python scripts/dep_completeness.py --selftest     # 反例自证（含正/负两侧样本与解析器不退化断言）
退出码：0 全绿 / 1 判红 / 2 环境或参数错误（扫描面塌陷按环境错误处理，零输入不得记 PASS）。
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FRONT = REPO / "frontend"
REQ = REPO / "backend" / "requirements.txt"
REQ_DEV = REPO / "backend" / "requirements-dev.txt"
REQ_BUILD = REPO / "backend" / "requirements-build.txt"
LOCK = REPO / "backend" / "requirements.lock"

PY_ROOTS = (("backend/app", "runtime"), ("backend/tests", "dev"), ("scripts", "dev"))
PY_EXTRA = [("backend/run.py", "runtime")]
JS_ROOTS = ("src", "functions", "tests", "e2e")
JS_FILES = ("lint.mjs", "playwright.config.mjs", "vite.config.mjs", "vite.config.js")

# 模块名 != 发行包名的既有事实（PEP 503 归一也救不了的那些），每条带来源包。
MODULE_TO_DIST = {
    "yaml": "pyyaml",           # PyYAML 装完叫 yaml
    "dotenv": "python-dotenv",  # python-dotenv 装完叫 dotenv
    "serial": "pywin32",
}
# 非 PyPI 依赖的显式豁免：必须写原因，且下面有一条判据保证豁免表不会无限膨胀。
LOCAL_DYNAMIC_IMPORTS = {
    # scripts/build_semantic_neighbors.py 按 --engine-dir 往 sys.path 里插一个本地 BGE ONNX 引擎，
    # 导入失败即 SystemExit 可读报错；它不在任何清单里，也不该在（线上运行时零模型零网络）。
    "bge_onnx_engine": "构建期本地引擎，经 sys.path 注入（见 encode()），非 PyPI 包",
}
MIN_PY_FILES = 25
MIN_JS_FILES = 40
MIN_PY_MODULES = 15
MIN_JS_PACKAGES = 6

Row = tuple[str, bool, str]


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def declared_set(path: Path) -> set[str]:
    out = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        m = re.match(r"^([A-Za-z0-9._-]+)", line)
        if m:
            out.add(norm(m.group(1)))
    return out


def python_imports() -> tuple[dict[str, list[str]], int]:
    """{顶层模块名: [首个来源文件:行]} + 扫到的文件数。"""
    found: dict[str, list[str]] = {}
    count = 0
    dirs: list[tuple[Path, str]] = [(REPO / d, s) for d, s in PY_ROOTS]
    dirs += [(REPO / f, s) for f, s in PY_EXTRA]
    for root, _scope in dirs:
        files = [root] if root.is_file() else sorted(root.rglob("*.py"))
        for f in files:
            if "__pycache__" in f.parts:
                continue
            count += 1
            try:
                tree = ast.parse(f.read_text(encoding="utf-8"))
            except SyntaxError as exc:  # 语法坏掉必须判红，不能被当成"没有 import"
                found.setdefault(f"!!parse:{f.name}", []).append(str(exc))
                continue
            for node in ast.walk(tree):
                names: list[str] = []
                lineno = 0
                if isinstance(node, ast.Import):
                    names, lineno = [str(a.name) for a in node.names], node.lineno
                elif isinstance(node, ast.ImportFrom):
                    if node.level:  # 相对导入不是第三方依赖
                        continue
                    names, lineno = ([str(node.module)] if node.module else []), node.lineno
                for n in names:
                    top = n.split(".")[0]
                    found.setdefault(top, []).append(f"{f.relative_to(REPO).as_posix()}:{lineno}")
    return found, count


def js_imports() -> tuple[dict[str, list[str]], int]:
    """只吃**行首锚定**的真 import/require 语句。

    必须是语句而不是字符串：privacy_guard 的 25 条遥测形态样本（含 `@sentry/browser`、`mongoose`）
    正是"以字符串出现的伪 import"，用正则不锚定就会把反例样本当成依赖（实测第一轮就踩到）。
    """
    stmt = re.compile(
        r"""^\s*(?:import\b[^\n]*?\bfrom|export\b[^\n]*?\bfrom)\s*["']([^"']+)["']"""
        r"""|^\s*import\s+["']([^"']+)["']"""
        r"""|^\s*(?:const|let|var)\s+[\w{},\s]+\s*=\s*require\(\s*["']([^"']+)["']"""
    )
    found: dict[str, list[str]] = {}
    files: list[Path] = []
    for pat in JS_ROOTS:
        p = FRONT / pat
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix in {".js", ".jsx", ".mjs"} and f.is_file()]
    files += [FRONT / f for f in JS_FILES if (FRONT / f).is_file()]
    for f in sorted(set(files)):
        for lineno, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if line.lstrip().startswith(("//", "*")):
                continue
            m = stmt.match(line)
            if not m:
                continue
            spec = next((g for g in m.groups() if g), "")
            if not spec or "\\" in spec or spec.startswith((".", "/", "node:")):
                continue
            name = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
            found.setdefault(name, []).append(f"{f.relative_to(REPO).as_posix()}:{lineno}")
    return found, len(set(files))


NUM = re.compile(r"^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?P<pre>[-+][0-9A-Za-z.\-]+)?$")


def _parse(version: str) -> tuple[tuple[int, int, int], bool] | None:
    """版本串 → (数字三元组, 是否带预发布后缀)。解析不了返回 None（由调用方点名）。"""
    m = re.match(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$", version.strip())
    if not m:
        return None
    return ((int(m.group(1)), int(m.group(2) or 0), int(m.group(3) or 0)), bool(m.group(4)))


def _one(ver: tuple[int, int, int], pre: bool, comp: str) -> bool | None:
    """单个比较符，按 npm 语义。"""
    comp = comp.strip()
    if not comp or comp == "*":
        return True
    m = NUM.match(comp)
    if not m:
        return None
    op = m.group(1) or ""
    has_minor = m.group(3) is not None
    tgt = (int(m.group(2)), int(m.group(3) or 0), int(m.group(4) or 0))
    if pre and m.group("pre") is None:
        # npm：预发布版不满足不含预发布的比较符（宁保守判不满足，也不要放过一个装不出来的组合）
        return False
    if op == "^":
        if tgt[0] > 0:
            return ver[0] == tgt[0] and ver >= tgt
        if tgt[1] > 0:
            return ver[0] == 0 and ver[1] == tgt[1] and ver >= tgt
        return ver == tgt
    if op == "~":
        if has_minor:
            return ver[0] == tgt[0] and ver[1] == tgt[1] and ver >= tgt
        return ver[0] == tgt[0] and ver >= tgt
    if op == ">=":
        return ver >= tgt
    if op == "<=":
        return ver <= tgt
    if op == ">":
        return ver > tgt
    if op == "<":
        return ver < tgt
    return ver == tgt


def version_ok(version: str, rng: str) -> bool | None:
    """`a || b` 各段内空格分隔的比较符取与；任一段全满足即满足。返回 None＝形态不可判定。"""
    parsed = _parse(version)
    if not parsed:
        return None
    ver, pre = parsed
    saw_unknown = False
    for part in rng.split("||"):
        tokens = [t for t in re.split(r"\s+", part.strip()) if t]
        if not tokens:
            continue
        results = [_one(ver, pre, t) for t in tokens]
        if any(r is None for r in results):
            saw_unknown = True
            continue
        if all(r is True for r in results):
            return True
    return None if saw_unknown else False


def js_checks() -> tuple[list[Row], dict[str, list[str]], int]:
    rows: list[Row] = []
    pkgs, nfiles = js_imports()
    pkgjson = json.loads((FRONT / "package.json").read_text(encoding="utf-8"))
    declared = set(pkgjson.get("dependencies") or {}) | set(pkgjson.get("devDependencies") or {})
    lock = json.loads((FRONT / "package-lock.json").read_text(encoding="utf-8")).get("packages") or {}
    rows.append(("覆盖面：JS 扫描面与裸导入非空",
                 nfiles >= MIN_JS_FILES and len(pkgs) >= MIN_JS_PACKAGES,
                 f"files={nfiles} 下限={MIN_JS_FILES}；packages={len(pkgs)} 下限={MIN_JS_PACKAGES}"))
    missing = {k: v[0] for k, v in pkgs.items() if k not in declared}
    rows.append(("所有裸导入都在 package.json 声明", not missing,
                 "; ".join(f"{k}@{loc}" for k, loc in sorted(missing.items())) or "无"))
    notlocked = sorted(d for d in declared if f"node_modules/{d}" not in lock)
    rows.append(("每个声明依赖在 package-lock 里有解析版本", not notlocked, "; ".join(notlocked) or "无"))

    unresolved: list[str] = []
    incompatible: list[str] = []
    optional_skipped = 0
    checked = 0
    for d in sorted(declared):
        ent = lock.get(f"node_modules/{d}") or {}
        meta = ent.get("peerDependenciesMeta") or {}
        for peer, rng in (ent.get("peerDependencies") or {}).items():
            if meta.get(peer, {}).get("optional"):
                optional_skipped += 1
                continue
            resolved = (lock.get(f"node_modules/{peer}") or {}).get("version")
            checked += 1
            if not resolved:
                incompatible.append(f"{d}@{ent.get('version')} 需要非 optional peer {peer} {rng}，锁内无")
                continue
            verdict = version_ok(str(resolved), rng)
            if verdict is None:
                unresolved.append(f"{d}->{peer} 范围 `{rng}` 无法判定")
            elif not verdict:
                incompatible.append(f"{d}@{ent.get('version')} 需要 {peer} {rng}，锁内实为 {resolved}")
    rows.append(("非 optional peer 与锁内解析版本相容", not incompatible, "; ".join(incompatible) or "无"))
    rows.append(("peer 范围可判定（不可判定的必须点名）", not unresolved,
                 "; ".join(unresolved) or f"全部可判定（optional 跳过 {optional_skipped} 条）"))
    rows.append(("peer 判据确实有活干（checked>0）", checked > 0, f"checked={checked}"))
    return rows, pkgs, nfiles


def py_checks() -> tuple[list[Row], dict[str, list[str]], int]:
    rows: list[Row] = []
    mods, nfiles = python_imports()
    parse_fail = {k: v for k, v in mods.items() if k.startswith("!!parse:")}
    rows.append(("Python 侧全部可 AST 解析", not parse_fail, "; ".join(f"{k} {v}" for k, v in parse_fail.items()) or "无"))
    rows.append(("覆盖面：Python 扫描面与模块名非空",
                 nfiles >= MIN_PY_FILES and len(mods) >= MIN_PY_MODULES,
                 f"files={nfiles} 下限={MIN_PY_FILES}；modules={len(mods)} 下限={MIN_PY_MODULES}"))
    runtime_decl = declared_set(REQ)
    # 工具面（scripts/、backend/tests/）可落在 dev 或 build 任一份声明面上；运行时面必须只在
    # requirements.txt 里——这条不对称就是"生产代码不许靠 dev/构建件续命"的判据。
    tool_decl = runtime_decl | declared_set(REQ_DEV) | declared_set(REQ_BUILD)
    stdlib = set(sys.stdlib_module_names)
    local = {"app", "scripts", "backend", "tests", "conftest", "run", "selftest"}
    undeclared: list[str] = []
    for mod in sorted(mods):
        top = MODULE_TO_DIST.get(mod, mod)
        if mod in LOCAL_DYNAMIC_IMPORTS or mod in stdlib or mod in local or mod.startswith("!!parse:"):
            continue
        scope = "runtime" if any("backend/app" in loc or "run.py" in loc for loc in mods[mod]) else "tool"
        need = runtime_decl if scope == "runtime" else tool_decl
        if norm(top) not in need:
            undeclared.append(f"{mod}（{scope} 面需要 {top}）@{mods[mod][0]}")
    rows.append(("所有 import 都在声明面上（运行时面不得只在 dev 面声明）", not undeclared,
                 "; ".join(undeclared) or "无"))
    # 豁免表与锁对账：写了豁免但锁里根本没有这个包 = 豁免已失效，必须清掉而不是留着继续放过。
    lock_names = {norm(n) for n in re.findall(r"^([A-Za-z0-9._-]+)==", LOCK.read_text(encoding="utf-8"), re.M)}
    stale_allow = [m for m, why in LOCAL_DYNAMIC_IMPORTS.items() if m in mods and norm(m) in lock_names]
    rows.append(("豁免表无陈旧项（被豁免的名字不得已在锁里）", not stale_allow,
                 f"这些已在锁里、应删除豁免：{stale_allow}" if stale_allow else f"豁免 {len(LOCAL_DYNAMIC_IMPORTS)} 条，理由均在码内"))
    return rows, mods, nfiles


def run_all() -> tuple[list[Row], int]:
    py_rows, py_mods, py_n = py_checks()
    js_rows, js_pkgs, js_n = js_checks()
    rows = py_rows + js_rows
    print(f"扫描面：Py {py_n} 文件/{len(py_mods)} 模块名 | JS {js_n} 文件/{len(js_pkgs)} 包名")
    print(f"Py 模块: {', '.join(sorted(py_mods))}")
    print(f"JS 包: {', '.join(sorted(js_pkgs))}")
    return rows, sum(1 for _, ok, _ in rows if not ok)


def _floor_bites() -> bool:
    """把 JS 扫描面下限抬到不可能达到的值，验「覆盖面」判据真的会红且只有它会红。"""
    global MIN_JS_FILES
    saved = MIN_JS_FILES
    try:
        MIN_JS_FILES = 10_000
        rows = js_checks()[0]
    finally:
        MIN_JS_FILES = saved
    failed = [name for name, ok, _ in rows if not ok]
    return failed == ["覆盖面：JS 扫描面与裸导入非空"]


def selftest() -> int:
    """反例自证：每条判据都要有能把红的样本，含"解析器不能退化到零命中"的反向断言。"""
    cases: list[tuple[str, bool]] = [
        ("真实仓当前全绿", run_all()[1] == 0),
        ("peer 相容判据会咬：把 vite 范围改成不可能的值",
         not version_ok("6.4.3", "^8.0.0")),
        ("peer 相容判据不误伤：成对升后的真值必须通过",
         version_ok("8.3.1", "^8.0.0") is True),
        ("peer 判据不吞多段或", version_ok("19.3.0", "^18.0.0 || ^19.0.0") is True),
        ("peer 判据不吃不可判定形态", version_ok("1.2.3", "npm:foo@1") is None),
        ("声明面解析器不空转", "pydantic" in declared_set(REQ) and "mypy" in declared_set(REQ_DEV)),
        ("PEP503 归一：大小写/下划线与横杠视为同名",
         norm("PyYAML") == norm("pyyaml") and norm("python_dotenv") == norm("python-dotenv")),
        ("别名表真在干活：yaml/dotenv 靠它才落在声明面上",
         MODULE_TO_DIST["yaml"] == "pyyaml" and norm("PyYAML") in declared_set(REQ)
         and "python-dotenv" in declared_set(REQ)),
        ("extras 记法不破坏解析：uvicorn[standard] 的包名仍为 uvicorn",
         "uvicorn" in declared_set(REQ)),
        # 正向对照（M5④）：判据若恒真，必须有一条"它没放过不该放过的东西"来证明。
        ("判据不空转：不存在的包名确实不在声明面上",
         norm("definitely-not-a-real-dep") not in declared_set(REQ) and norm("zzz-no-such-pkg") not in declared_set(REQ_DEV)),
        ("两个扫描器都真读到东西（否则未声明判据无从生效）",
         "react" in js_imports()[0] and "starlette" in python_imports()[0]),
        # 反例要"单独证明它真的会失败"（M5④）：把下限抬过实测值，看覆盖面判据是否转红，
        # 同时确认其余判据不受影响（否则这条自证只是在测"全判红"，测不到"下限"这一件事）。
        ("覆盖面判据会咬：下限抬过实测值即转红，且不误伤别的判据", _floor_bites()),
    ]
    bad = [n for n, ok in cases if not ok]
    for name, ok in cases:
        print(f"{'ok  ' if ok else 'BAD '} :: {name}")
    print(f"[GATE:dep-completeness-selftest-{'pass' if not bad else 'fail'}] {len(cases) - len(bad)}/{len(cases)}")
    return 0 if not bad else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="依赖声明完整性（import↔声明、peer↔锁解析）")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    for p in (REQ, REQ_DEV, REQ_BUILD, LOCK, FRONT / "package.json", FRONT / "package-lock.json"):
        if not p.is_file():
            print(f"[GATE:dep-completeness-fail] 输入缺失：{p}", file=sys.stderr)
            return 2
    rows, failed = run_all()
    for name, ok, detail in rows:
        print(f"{'PASS' if ok else 'FAIL'} :: {name}" + ("" if ok else f" :: {detail}"))
    print(f"[GATE:dep-completeness-{'pass' if not failed else 'fail'}] {len(rows) - failed}/{len(rows)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
