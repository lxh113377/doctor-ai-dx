#!/usr/bin/env python3
"""依赖锁定门禁（第十八轮）：证明「运行时环境本身」也可复现，而不是只有源码可复现。

对标取证（2026-09-25 `gh api repos/<peer>/contents` 实测）：**4/4 同类项目都带锁文件** —
openemr `composer.lock` + `package-lock.json`；ragflow `pyproject.toml` + `uv.lock`；
phlox `package-lock.json`；medical-rag `environment.yml`。
我方此前 npm 侧有 `package-lock.json`，**pip 侧只有区间**（`fastapi>=0.141.1` 等），后果是实的：
① 同一个 tag 在不同时间 `pip install` 会装出不同环境；② `backend/Dockerfile` 装的是浮动版本，
镜像无法审计；③ 第十六轮 SBOM 的 pip 侧被迫走 `environment` 模式（声明式 `requirements` 模式
因无钉版只出 5 条空壳＝假门禁）。本门禁把 `backend/requirements.lock`
（`uv pip compile ... --python-platform x86_64-unknown-linux-gnu --generate-hashes`）钉住并接线验证。

判据（任一失败 exit 1）：
 1. 锁文件存在且条目数 ≥ MIN_PACKAGES（**空锁/半截锁不得判绿**）
 2. 头注记录生成命令，且含 `--generate-hashes` 与目标平台（换平台＝换判据；防有人悄悄去掉哈希）
 3. `requirements.txt` 每个声明包都在锁里，且为 `==` 精确版本
 4. 锁内版本必须**满足声明区间**（防「只改 requirements.txt 不重锁」的单向漂移）
 5. 锁内每个条目都带 ≥1 个 `--hash=sha256:`（`pip --require-hashes` 的前提）
 6. **接线实证**：`backend/Dockerfile` 必须从锁安装并开 `--require-hashes`，且不得再装浮动 requirements
    （锁文件沦为装饰是这类治理最常见的死法）
 7. 依赖治理声明与代码一致：`PRIVACY.md`/`README` 若声明「无锁」则判红（防文档漂移）

可选 `--report` 只打印对账明细不判红。真装验证在 CI 的 Backend 作业里跑
（本锁是按 Linux 解析的，Windows 本机装会因 uvloop 无 Windows 轮而失败，属预期）。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(REPO, "backend", "requirements.lock")
REQ = os.path.join(REPO, "backend", "requirements.txt")
DOCKERFILE = os.path.join(REPO, "backend", "Dockerfile")
MIN_PACKAGES = 15  # 非空证明下限：实测锁内 22 个包（含 uvicorn[standard] 拉出的全部传递依赖）
REQUIRED_FLAGS = ("--generate-hashes", "--python-platform")


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def canon(name: str) -> str:
    """PEP 503 规范化：小写、把 _/. 及连续 - 折叠为单个 -。"""
    return re.sub(r"[-_.]+", "-", name).lower()


def vtuple(v: str) -> tuple[int, ...]:
    """版本比较用的最小实现：取前导数字段。非数字后缀（rc/post/dev）被截断比较，
    够用于「锁内版本是否满足声明下界」这一判定，且不给门禁引入未声明依赖。"""
    parts = re.findall(r"\d+", v)
    return tuple(int(p) for p in parts[:4]) if parts else (0,)


def parse_lock(text: str) -> tuple[dict[str, str], list[str], int]:
    pins: dict[str, str] = {}
    hashes: dict[str, int] = {}
    pending: str | None = None
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_.\[\]-]+)==([^\s\\]+)", line)
        if m:
            pending = canon(m.group(1).split("[")[0])
            pins[pending] = m.group(2)
            hashes.setdefault(pending, 0)
            continue
        h = re.match(r"^\s*--hash=sha256:", line)
        if h and pending:
            hashes[pending] += 1
    header = "\n".join(text.splitlines()[:3])
    return pins, [f"{k}=={v}" for k, v in pins.items()], len(header.splitlines())


def parse_reqs(text: str) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_.\[\]-]+)\s*(>=|==|~=|>)\s*([0-9][^\s;,]*)", s)
        if m:
            out.append((canon(m.group(1).split("[")[0]), m.group(2), m.group(3)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="只打印对账明细，不判红")
    ap.add_argument("--quiet", action="store_true", help="只输出失败项与门禁结论（pre-commit / CI 用）")
    ap.add_argument("--lock", default=LOCK)
    args = ap.parse_args()

    for p in (args.lock, REQ, DOCKERFILE):
        if not os.path.exists(p):
            print(f"FAIL 缺少文件：{os.path.relpath(p, REPO)}")
            return 1

    lock_text, req_text, docker_text = read(args.lock), read(REQ), read(DOCKERFILE)
    pins, pin_list, header_lines = parse_lock(lock_text)
    declared = parse_reqs(req_text)
    checks: list[tuple[str, bool, str]] = []

    checks.append((f"锁内包数 ≥ {MIN_PACKAGES}（非空证明）", len(pins) >= MIN_PACKAGES, f"实测 {len(pins)}"))

    head = "\n".join(lock_text.splitlines()[:header_lines])
    ok_flags = "--generate-hashes" in head and all(f in head for f in REQUIRED_FLAGS) and "uv pip compile" in head
    checks.append(("头注含 uv pip compile + --generate-hashes + --python-platform", ok_flags, head[:160]))

    missing = [n for n, _op, _v in declared if n not in pins]
    checks.append(("requirements.txt 每个声明包都钉进锁", not missing, f"缺 {missing}"))

    non_strict = [f"{k}={v}" for k, v in pins.items() if not re.match(r"^\d[\w.]*$", v)]
    checks.append(("锁内全部为精确 == 版本（无区间/无 @ url）", not non_strict, f"异常 {non_strict[:4]}"))

    violates: list[str] = []
    for name, op, want in declared:
        got = pins.get(name)
        if not got:
            continue
        if op in (">=", "~=", ">") and vtuple(got) < vtuple(want):
            violates.append(f"{name}: 声明 {op}{want} 但锁内 {got}")
        if op == "==" and got != want:
            violates.append(f"{name}: 声明 =={want} 但锁内 {got}")
    checks.append(("锁内版本满足声明区间（防改声明不重锁）", not violates, "; ".join(violates[:4])))

    per: dict[str, int] = {}
    pending = None
    for line in lock_text.splitlines():
        m = re.match(r"^([A-Za-z0-9_.\[\]-]+)==", line)
        if m:
            pending = canon(m.group(1).split("[")[0])
            per.setdefault(pending, 0)
            continue
        if re.match(r"^\s*--hash=sha256:", line) and pending:
            per[pending] += 1
    nohash = [k for k, v in per.items() if v == 0]
    checks.append(("每个条目都带 ≥1 个 sha256 哈希", not nohash, f"无哈希 {nohash[:4]}"))
    total_hashes = sum(per.values())

    # 只认 Dockerfile 的**指令行**（RUN/COPY/…），注释一律不参与判定。
    # 反例实测（本轮自查）：Dockerfile 注释里写了「开 --require-hashes」而 RUN 行没有，
    # 按全文匹配时该判据仍 PASS＝**用文档字面量满足代码判据**的假通过，与 `\b`→0x08 同族。
    instructions = "\n".join(
        line for line in docker_text.splitlines() if line.strip() and not line.strip().startswith("#")
    )
    installs_lock = bool(re.search(r"pip install[^\n]*requirements\.lock", instructions))
    has_require_hashes = "--require-hashes" in instructions
    still_float = bool(re.search(r"pip install[^\n]*-r\s+requirements\.txt", instructions))
    checks.append(("Dockerfile 从锁安装（接线实证）", installs_lock, "RUN 行未搜到 pip install -r requirements.lock"))
    checks.append(("Dockerfile 的 RUN 行开 --require-hashes", has_require_hashes, "RUN 行缺 --require-hashes（注释不算）"))
    checks.append(("Dockerfile 不再安装浮动 requirements.txt", not still_float, "RUN 行仍在装 requirements.txt"))

    # 10) 同类出口补全：`--require-hashes` 会作用于该次 pip 的**全部**需求输入，
    # 任何一行把「非 .lock 需求文件」和它写在同一条命令里，pip 会直接报
    # 「all requirements must have their versions pinned with ==」（v1.16.0 首发即因此 14 秒判红）。
    mixed: list[str] = []
    wf_dir = os.path.join(REPO, ".github", "workflows")
    if os.path.isdir(wf_dir):
        for fn in sorted(os.listdir(wf_dir)):
            if not fn.endswith((".yml", ".yaml")):
                continue
            for i, line in enumerate(read(os.path.join(wf_dir, fn)).splitlines(), 1):
                if "pip install" not in line or "--require-hashes" not in line:
                    continue
                bad = [r for r in re.findall(r"-r\s+(\S+)", line) if not r.endswith(".lock")]
                if bad:
                    mixed.append(f"{fn}:{i} → {bad}")
    checks.append(("无命令行把 --require-hashes 与非锁需求文件混用", not mixed, "; ".join(mixed[:3])))

    # 11) 声明面必须按**消费者口径**可解析（v1.17.0 实测教训）：
    # 我给 requirements.txt 加的一段注释，续行漏了 `#` —— `uv pip compile` 照解析成功（生成器宽容），
    # 但 CI 里 `pip install -r ../backend/requirements.txt` 直接
    # `ERROR: Invalid requirement: '把"靠传递依赖"写成声明依赖…'`（run 36105388164，build-and-test 判红）。
    # ⇒ 生成器通过 ≠ 消费者通过。这里按 pip 的行规则逐行判，不依赖任何第三方解析库
    #   （CI 的运行时环境里没有 packaging，实测 ModuleNotFoundError，用它反而把门禁变成不可跑）。
    REQ_LINE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*(===|==|>=|<=|~=|!=|>|<|@)")
    bad_lines = []
    for no, line in enumerate(req_text.splitlines(), 1):
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        if not REQ_LINE.match(t):
            bad_lines.append(f"{no}: {t[:40]}")
    checks.append(("声明面逐行按 pip 口径可解析（生成器宽容不算通过）", not bad_lines, "; ".join(bad_lines[:3])))

    if not args.quiet:
        print(f"== 依赖锁定对账（lock={os.path.relpath(args.lock, REPO)} 锁内 {len(pins)} 包 / {total_hashes} 条哈希）==")
    rc = 0
    for name, ok, detail in checks:
        if ok and args.quiet:
            continue
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
        if not ok:
            rc = 1
    if args.report:
        print("--report 模式：强制 exit 0")
        rc = 0
    print(f"[GATE:lock-{'pass' if rc == 0 else 'fail'}] 声明 {len(declared)} 条 → 锁内 {len(pins)} 条（含传递依赖）")
    return rc


if __name__ == "__main__":
    sys.exit(main())
