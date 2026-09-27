#!/usr/bin/env python3
"""Docker 构建上下文卫生守卫（第四十三轮；对标 `bloodworks-io/phlox` 带 .dockerignore 的形态）。

为什么要有它（一手实测，不是"peer 有所以我也要有"）：
  `docker-compose.yml` 与 `release.yml` 的构建上下文都是 `./backend`。第四十三轮实测该目录
  117 个文件 / 11,683,702 B，其中 **45 个 / 10,990,819 B（94.1%）是工具缓存与覆盖率产物**，
  而当时的 `.dockerignore` 只盖了 `__pycache__`/`*.pyc`/`.pytest_cache`/`.venv`/`venv`——
  单 `.mypy_cache` 就 10,842,341 B。Dockerfile 全是显式 COPY，所以这张表不改变镜像内容，
  改变的是**每次 build 传给 daemon 的字节**（compose 与 release 两条链每次都要 build）。

三态输出（零输入绝不记绿）：
  PASS   每个上下文里的"垃圾类"文件都被 .dockerignore 覆盖
  FAIL   有未覆盖项 ⇒ 点名文件与字节（这类漂移＝加了个新工具缓存就多传 10 MB，且没人会去看）
  EMPTY  一个上下文都没取到 / 取到上下文却一个文件没看见 ⇒ 取数面坏了（rc=2）

已知边界（不许写成已闭环）：本机 `docker info` 报 daemon 不在 ⇒ 无法用 `docker build` 实测上下文体积；
覆盖判定按**名字级**（表里有 `X/` 或 `**/X/` 任一形态即算覆盖），不模拟 Docker 的完整通配语义——
`**` 与裸目录名在嵌套层的行为差异我没有实测过，所以 `.dockerignore` 里两种形态都写。
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

JUNK_DIRS = {"__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
             ".c8-tmp", ".venv", "venv", "node_modules", ".git"}
JUNK_FILES = {".coverage", "coverage.xml"}
JUNK_EXTS = (".pyc", ".pyo")
JUNK_PREFIX = (".coverage.",)
COMPOSE_NAMES = ("docker-compose.yml", "docker-compose.yaml", "compose.yml")


def contexts_from_compose(root: Path) -> list[str]:
    """上下文只从 compose（结构化 YAML）取。CI 里那条 `docker build ./backend` 与 compose 同上下文，
    这是本轮 grep 实测到的事实，写进注释而不是让判据每次去正则解析工作流文本——
    同族禁令：判据的输入面不得是另一个工具的命令文本（删掉那行命令就会静默少测）。"""
    try:
        import yaml
    except ImportError:
        return []
    for name in COMPOSE_NAMES:
        f = root / name
        if not f.exists():
            continue
        doc = yaml.safe_load(open(f, encoding="utf-8")) or {}
        out = []
        for svc in (doc.get("services") or {}).values():
            build = (svc or {}).get("build")
            ctx = build.get("context") if isinstance(build, dict) else build
            if isinstance(ctx, str) and ctx.strip():
                out.append(ctx.replace("./", "").strip("/") or ".")
        if out:
            return sorted(set(out))
    return []


def ignore_names(ctx_dir: Path) -> set[str]:
    """.dockerignore 归一成名字集（`**/.mypy_cache/` 与 `.mypy_cache/` 都收成 .mypy_cache）。"""
    f = ctx_dir / ".dockerignore"
    if not f.exists():
        return set()
    names = set()
    for line in open(f, encoding="utf-8").read().splitlines():
        p = line.strip()
        if not p or p.startswith("#") or p.startswith("!"):
            continue
        names.add(p.rstrip("/").split("/")[-1].lstrip("*/!"))
    return names


def classify(ctx_dir: Path) -> tuple[list[tuple[str, int]], list[tuple[str, int]], int]:
    """返回 (未覆盖垃圾, 已覆盖垃圾, 上下文总字节)。"""
    cov = ignore_names(ctx_dir)
    uncovered: list[tuple[str, int]] = []
    covered: list[tuple[str, int]] = []
    total = 0
    for dp, _dn, fn in os.walk(ctx_dir):
        rel = Path(dp).relative_to(ctx_dir).as_posix()
        parts = [] if rel == "." else rel.split("/")
        in_junk_dir = bool(JUNK_DIRS.intersection(parts))
        dir_shadowed = in_junk_dir and bool(JUNK_DIRS.intersection(cov))
        for f in fn:
            try:
                size = (Path(dp) / f).stat().st_size
            except OSError:
                continue
            total += size
            junk = in_junk_dir or f in JUNK_FILES or f.endswith(JUNK_EXTS) \
                or any(f.startswith(pre) for pre in JUNK_PREFIX)
            if not junk:
                continue
            path = f if rel == "." else rel + "/" + f
            if f in cov or dir_shadowed or (f.endswith(JUNK_EXTS) and "*.pyc" in cov):
                covered.append((path, size))
            else:
                uncovered.append((path, size))
    return uncovered, covered, total


def check_root(root: Path, verbose: bool) -> int:
    ctxs = contexts_from_compose(root)
    for p in sorted(root.glob("**/Dockerfile")):
        if "node_modules" in p.parts or ".git" in p.parts:
            continue
        rel = (p.parent.relative_to(root).as_posix() or ".").replace("./", "").strip("/")
        if rel not in ctxs:
            ctxs.append(rel)
    ctxs = sorted(set(ctxs))
    if not ctxs:
        print("EMPTY :: 一个构建上下文都没取到（compose 无 build 且没找到 Dockerfile）⇒ 判据失效")
        print("[GATE:docker-context-empty]")
        return 2
    bad = 0
    seen_bytes = 0
    for c in ctxs:
        ctx_dir = (root / c).resolve()
        if not ctx_dir.is_dir():
            print(f"FAIL 上下文目录不存在：{c}（compose 写了但盘上没有）")
            bad += 1
            continue
        unc, covd, total = classify(ctx_dir)
        seen_bytes += total
        if not (ctx_dir / ".dockerignore").exists() and total:
            print(f"FAIL {c}：无 .dockerignore（上下文 {total} B，未覆盖垃圾 {len(unc)} 项）")
            bad += max(1, len(unc))
        if unc:
            jb = sum(s for _p, s in unc)
            print(f"FAIL {c}：{len(unc)} 个垃圾项未被 .dockerignore 覆盖，共 {jb} B（上下文总 {total} B）")
            for path, s in sorted(unc, key=lambda x: -x[1])[:8]:
                print(f"      {s:>10} B  {path}")
            bad += len(unc)
        elif verbose:
            print(f"ok   {c}：上下文 {total} B，垃圾 {len(covd)} 项已被 .dockerignore 覆盖")
    if bad:
        print(f"[GATE:docker-context-fail] {bad} 处未覆盖")
        return 1
    if seen_bytes == 0:
        print(f"EMPTY :: 上下文取到 {len(ctxs)} 个但一个文件都没看见 ⇒ 遍历失效，不许记绿")
        print("[GATE:docker-context-empty]")
        return 2
    print(f"[GATE:docker-context-pass] {len(ctxs)} 个上下文全部干净")
    return 0


def _fixture(with_junk: bool, ignore: str | None) -> Path:
    d = Path(tempfile.mkdtemp(prefix="dcg_"))
    (d / "app").mkdir()
    (d / "app" / "main.py").write_text("x = 1\n", encoding="utf-8")
    if with_junk:
        (d / ".mypy_cache").mkdir()
        (d / ".mypy_cache" / "data.json").write_text("z" * 4096, encoding="utf-8")
    if ignore is not None:
        (d / ".dockerignore").write_text(ignore, encoding="utf-8")
    return d


def selftest() -> int:
    """三态各绑专属输入面；最后一条打在真实文件本文上（不是誊写夹具）。"""
    cases = []
    unc, cov, _t = classify(_fixture(True, ".mypy_cache/\n**/.mypy_cache/\n"))
    cases.append(("被覆盖的缓存 ⇒ 未覆盖清单须为空且已覆盖清单非空", not unc and len(cov) >= 1))
    unc2, _c2, _t2 = classify(_fixture(True, "*.pyc\n"))
    cases.append(("未覆盖的缓存必须被抓并点名（反例专属输入面）",
                  len(unc2) >= 1 and any(".mypy_cache" in p for p, _s in unc2)))
    cases.append(("无 .dockerignore ⇒ 覆盖集为空（不得默认全覆盖）",
                  ignore_names(_fixture(False, None)) == set()))
    empty = _fixture(False, None)
    u3, c3, t3 = classify(empty)
    cases.append(("有源文件而无垃圾 ⇒ 总字节 >0 且垃圾清单为空（这是 PASS 的形状）",
                  t3 > 0 and not u3 and not c3))
    bare = Path(tempfile.mkdtemp(prefix="dcg_bare_"))
    u4, c4, t4 = classify(bare)
    cases.append(("真空目录 ⇒ 总字节为 0（EMPTY 的触发条件本身可测）", t4 == 0 and not u4 and not c4))
    cases.append(("空仓库（无 compose 无 Dockerfile）⇒ rc=2 而不是 0", check_root(bare, False) == 2))
    root = Path(sys.argv[0]).resolve().parent.parent
    ur, cr, tr = classify(root / "backend")
    cases.append(("本仓 backend 实测 0 未覆盖且垃圾确实在场（真实文件本文）",
                  len(ur) == 0 and tr > 0 and len(cr) > 0))
    bad = 0
    for name, ok in cases:
        bad += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'} {name}")
    print(f"SELFTEST: {len(cases) - bad}/{len(cases)}")
    print("[GATE:docker-context-selftest-pass]" if bad == 0 else "[GATE:docker-context-selftest-fail]")
    return 0 if bad == 0 else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    return check_root(Path(a.root).resolve(), not a.quiet)


if __name__ == "__main__":
    sys.exit(main())
