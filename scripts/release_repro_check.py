#!/usr/bin/env python3
"""发布工件可复现性门禁（第十七轮）。

为什么存在：第十六轮把可复现主张写在文档里，但从未**机器验证过**"本机也能出同一个包"。
本轮实测把两个真实成因抓了出来，且都不是 git 版本差异：
  1) 行尾：Git for Windows 默认 core.autocrlf=true ⇒ `git archive` 导出时做 LF→CRLF，
     实测本机出包与 CI 出包 **119/122 个文件字节不同**（逐文件 CRC 比对；差异全部只是行尾）。
     已用仓内 .gitattributes（`* text=auto eol=lf`）钉死；但 git archive 只认**被归档 tree 内**的
     attributes，所以旧 tag 的包不受该文件保护——本判据第 3 项因此必须实测而非假设。
  2) 时间戳：zip 的 MS-DOS 时间字段按**归档进程所在时区**渲染。CI runner 是 UTC，本机 UTC+8 ⇒
     同一 commit + 同一 --mtime 仍差 284 个字节。TZ=UTC0 后消除。

实测结论：`TZ=UTC0` + `core.autocrlf=false` + `--mtime=<commit 时间>` ⇒ 本机重建与
GitHub Release 资产 **SHA256 全等**（v1.15.0 实测，见 --against 模式）。

用法：
  python scripts/release_repro_check.py [--ref v1.15.0] [--against <ci 下载的 zip 路径>]
判据（任一失败即 exit 1）：
  1. 同一 ref 连出两个包 ⇒ SHA256 必须相等（同环境确定性）
  2. 包内文本文件零 CRLF ⇒ 行尾过滤未介入（防 .gitattributes 被删/被 tree 外因素覆盖）
  3. 包内文件数 > MIN_FILES（非空证明，防空包判绿）
  4. 仅当给了 --against：本机包与外部（CI）包 SHA256 全等 ⇒ 跨环境可复现
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import UTC, datetime

MIN_FILES = 100  # 非空证明下限：与 release.yml 的 ">100" 自检保持同口径
TEXT_EXTS = (".js", ".mjs", ".jsx", ".py", ".md", ".json", ".yml", ".yaml", ".css", ".html", ".txt", ".toml", ".ini", ".sh")
REPO = os.path.dirname(os.path.abspath(os.path.dirname(__file__)))


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"[GATE:repro-fail] 命令失败 rc={r.returncode}: {' '.join(cmd)}\n{r.stderr.strip()[:400]}")
    return r.stdout


def build(ref: str, out: str) -> None:
    mt = run(["git", "log", "-1", "--format=%ct", ref]).strip()
    env = dict(os.environ, TZ="UTC0")  # zip 时间戳按归档进程时区渲染，必须钉 UTC
    r = subprocess.run(
        ["git", "-c", "core.autocrlf=false", "archive", "--format=zip", f"--mtime={mt}", "-o", out, ref],
        cwd=REPO, env=env, capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"[GATE:repro-fail] git archive 失败 rc={r.returncode}\n{r.stderr.strip()[:400]}")


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--against", default="", help="外部（如 GitHub Release）产出的同一 ref 包路径")
    args = ap.parse_args()

    # CI 在 ubuntu 上 checkout 时同样会应用 .gitattributes；本机 HEAD 若早于该文件则第 2 项会红——这是有意的
    ref = run(["git", "rev-parse", args.ref]).strip()[:12] if args.ref == "HEAD" else args.ref
    tmp = tempfile.mkdtemp(prefix="repro_")
    a, b = os.path.join(tmp, "a.zip"), os.path.join(tmp, "b.zip")
    build(ref, a)
    build(ref, b)
    sa, sb = sha256(a), sha256(b)

    checks: list[tuple[str, bool, str]] = []
    checks.append(("同环境二次构建逐字节全等", sa == sb, f"sha_a={sa[:16]} sha_b={sb[:16]}"))

    with zipfile.ZipFile(a) as z:
        names = [i.filename for i in z.infolist() if not i.filename.endswith("/")]
        crlf = [n for n in names if n.endswith(TEXT_EXTS) and b"\r\n" in z.read(n)]
    checks.append(("包内文本文件零 CRLF（行尾过滤未介入）", not crlf, f"CRLF 文件={crlf[:4]}"))
    checks.append((f"包内文件数 > {MIN_FILES}（非空证明）", len(names) > MIN_FILES, f"实测 {len(names)} 个文件"))

    print(f"== 发布工件可复现性对账（ref={ref} 构建时间戳={run(['git', 'log', '-1', '--format=%cI', ref]).strip()}）==")
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
    rc = 1 if not all(c[1] for c in checks) else 0

    if args.against:
        ext = sha256(args.against)
        cross = ext == sa
        print(f"  {'PASS' if cross else 'FAIL'} 与外部（CI）包 SHA256 全等 :: local={sa[:16]} external={ext[:16]}")
        if not cross:
            rc = 1
    else:
        print("  SKIP 跨环境对账（未给 --against；仅校同环境确定性）")

    with zipfile.ZipFile(a) as z:
        n = len([i for i in z.infolist() if not i.filename.endswith("/")])
    print(f"摘要：文件数={n} 本机包 SHA256={sa}")
    print(f"[GATE:repro-{'pass' if rc == 0 else 'fail'}] {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}Z")
    for p in (a, b):
        os.remove(p)
    os.rmdir(tmp)
    return rc


if __name__ == "__main__":
    sys.exit(main())
