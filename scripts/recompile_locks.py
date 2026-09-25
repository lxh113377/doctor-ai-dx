#!/usr/bin/env python3
"""一条命令**同一时刻**重算两把依赖锁（amd64 + arm64）。

为什么必须"同刻"（第二十二轮实测结论）：本仓镜像从 v1.18 起对外发布，锁按平台解析
（`--python-platform` + `--generate-hashes`，见 `scripts/lock_guard.py`）。要出多架构镜像就得有两把锁，
而**分别、先后重算**会引入一类新漂移：两个时刻的可解析版本不同 ⇒ 同一 tag 的 amd64 与 arm64
装着不同版本的依赖（本轮实测就是这么抓到的：仓内 amd64 锁还是 uvicorn 0.53.0，
当时新算的 arm64 锁已是 0.54.0；而把 amd64 立刻重算，两者完全一致 ⇒ 差异纯属"不同时刻"而非架构）。
所以：① 重算只能走本脚本（一次跑完两个平台）；② `lock_guard` 有一条"两锁版本集必须全等"的判据兜底，
忘记跑本脚本、只手改一把锁 ⇒ 判红。

跑法：python scripts/recompile_locks.py   （需 `uv` 在 PATH；只影响 backend/requirements*.lock）
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
BACKEND = REPO / "backend"
# (目标平台三元组, 输出文件名) —— 顺序即执行顺序；两把锁必须在这里成对出现
TARGETS = (
    ("x86_64-unknown-linux-gnu", "requirements.lock"),
    ("aarch64-unknown-linux-gnu", "requirements.arm64.lock"),
)
VERSION_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^ \;\\]+)")


def compile_lock(platform: str, out: pathlib.Path, python_version: str) -> None:
    cmd = [
        "uv", "pip", "compile", "requirements.txt",
        "--python-version", python_version,
        "--python-platform", platform,
        "--generate-hashes",
        # `--upgrade` 是**必须**的：uv 的 pip compile 会复用输出文件里已有的钉版（in-source caching），
        # 于是"写已存在的锁"= 保持旧版本、"写新文件"= 取当前最新版本——同一命令两种结果。
        # 第二十二轮实测就是这么抓到的：仓内 amd64 锁停在 uvicorn 0.53.0，而新建的 arm64 锁是 0.54.0，
        # 看起来像"架构差异"，实为缓存语义；加上 --upgrade 后两平台重解析完全一致（只动这 1 个包）。
        "--upgrade",
        "-o", out.name,
    ]
    print(f"  $ uv pip compile ... --python-platform {platform} -o {out.name}")
    r = subprocess.run(cmd, cwd=str(BACKEND), capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(f"uv 解析失败（platform={platform}）rc={r.returncode}:\n{(r.stderr or r.stdout)[-1500:]}", file=sys.stderr)
        raise SystemExit(2)


def versions_of(path: pathlib.Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        m = VERSION_RE.match(line)
        if m:
            out[m.group(1).lower().replace("_", "-").replace(".", "-")] = m.group(2)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="同刻重算 amd64 + arm64 两把依赖锁")
    ap.add_argument("--python-version", default="3.12")
    ap.add_argument("--check", action="store_true", help="只比对现有两把锁是否同刻（不重算）")
    args = ap.parse_args()

    produced: list[pathlib.Path] = []
    if not args.check:
        for platform, name in TARGETS:
            compile_lock(platform, BACKEND / name, args.python_version)
    for _, name in TARGETS:
        p = BACKEND / name
        if not p.exists():
            print(f"缺锁文件 {p.name} ⇒ 多架构交付不成立（lock_guard 同样会判红）", file=sys.stderr)
            return 1
        produced.append(p)

    tables = {p.name: versions_of(p) for p in produced}
    base_name, base = next(iter(tables.items()))
    drift: dict[str, dict[str, tuple[str | None, str | None]]] = {}
    for name, table in tables.items():
        if name == base_name:
            continue
        diff = {
            k: (base.get(k), table.get(k))
            for k in sorted(set(base) | set(table))
            if base.get(k) != table.get(k)
        }
        if diff:
            drift[f"{base_name} vs {name}"] = diff
    print(f"锁数={len(tables)} 基准={base_name}({len(base)} 包) " +
          " ".join(f"{n}={len(t)}" for n, t in tables.items() if n != base_name))
    if drift:
        print("::error::两锁版本集不一致 ⇒ 不是同一时刻重算的（请跑 python scripts/recompile_locks.py）")
        for pair, diff in drift.items():
            print(f"  {pair}: {diff}")
        return 1
    print(f"[GATE:locks-sync-pass] {len(base)} 个包版本集全等（同一时刻重算），哈希按各平台 wheel 分列")
    return 0


if __name__ == "__main__":
    sys.exit(main())
