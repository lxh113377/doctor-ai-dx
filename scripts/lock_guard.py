#!/usr/bin/env python3
"""依赖锁定门禁（第十八轮建，第二十二轮扩为多架构双锁）：证明「运行时环境本身」也可复现。

对标取证（2026-09-25 `gh api repos/<peer>/contents` 实测）：**同类项目都带锁文件** —
openemr `composer.lock` + `package-lock.json`；ragflow `pyproject.toml` + `uv.lock`；
phlox `package-lock.json`；medical-rag `environment.yml`。
我方此前 npm 侧有 `package-lock.json`，**pip 侧只有区间**（`fastapi>=0.141.1` 等），后果是实的：
① 同一个 tag 在不同时间 `pip install` 会装出不同环境；② `backend/Dockerfile` 装的是浮动版本，
镜像无法审计；③ 第十六轮 SBOM 的 pip 侧被迫走 `environment` 模式（声明式 `requirements` 模式
因无钉版只出 5 条空壳＝假门禁）。

第二十二轮扩为两把锁（`requirements.lock` = amd64、`requirements.arm64.lock` = arm64），
因为镜像要出多架构而 `--python-platform` 解析出的哈希按平台分列。同时抓到一类新漂移：
两把锁若不同时刻重算就会内容不一致（实测 amd64 停 uvicorn 0.53.0、arm64 已 0.54.0，
根因是 uv 复用输出文件里已有的钉版，看着像架构差异）⇒ 新增「各锁版本集全等」判据（第 9 条）。

判据（任一失败 exit 1；1–8 对**每一把锁**各跑一遍）：
 1. 锁文件存在且条目数 ≥ MIN_PACKAGES（空锁/半截锁不得判绿）
 2. 头注记录生成命令，含 `--generate-hashes` 与 **本平台** 的 `--python-platform`（换平台＝换判据）
 3. `requirements.txt` 每个声明包都在锁里，且为 `==` 精确版本
 4. 锁内版本必须满足声明区间（防「只改 requirements.txt 不重锁」的单向漂移）
 5. 锁内每个条目都带 ≥1 个 `--hash=sha256:`（`pip --require-hashes` 的前提）
 6. 锁内全部为精确 == 版本（无区间、无 @ url）
 7. **接线实证**：`backend/Dockerfile` 从锁安装、开 `--require-hashes`、不再装浮动 requirements
 8. **每把锁都被 Dockerfile 真引用**（多架构下新增：只 COPY 不用的锁＝死文件，arm64 仍会装不动）
 9. **各锁版本集全等**（同一时刻重算的证据；不一致即要求跑 `scripts/recompile_locks.py`）
10. 无命令行把 `--require-hashes` 与非锁需求文件混用（v1.16.0 首发即因此 14 秒判红）
11. 声明面逐行按 **pip 消费者口径**可解析（v1.17.0：`uv` 能解析而 `pip` 拒绝，生成器宽容不算通过）

可选 `--report` 只打印对账明细不判红。真装验证在 CI 的 Backend 作业里跑
（锁按 Linux 解析，Windows 本机装会因 uvloop 无 Windows 轮而失败，属预期）。
"""
from __future__ import annotations

import argparse
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(REPO, "backend", "requirements.lock")
# 路径与其头注里**应当出现**的平台三元组成对声明：新增架构就在这里加一行，
# 第 2/8/9 条会自动跟着扩（不靠人记得去改判据）。
LOCKS = (
    (os.path.join(REPO, "backend", "requirements.lock"), "x86_64-unknown-linux-gnu"),
    (os.path.join(REPO, "backend", "requirements.arm64.lock"), "aarch64-unknown-linux-gnu"),
)
REQ = os.path.join(REPO, "backend", "requirements.txt")
DOCKERFILE = os.path.join(REPO, "backend", "Dockerfile")
MIN_PACKAGES = 15  # 非空证明下限：实测每把锁 22 个包（含 uvicorn[standard] 的传递依赖）
MIN_LOCKS = 2      # 多架构交付成立的下限（只剩一把锁＝宣称多架构却不成立）
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


def parse_lock(text: str) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_.\[\]-]+)==([^\s\\]+)", line)
        if m:
            pins[canon(m.group(1).split("[")[0])] = m.group(2)
    return pins


def count_hashes(text: str) -> tuple[dict[str, int], dict[str, int]]:
    """返回 (每包哈希数, 空=占位)；顺带给出总数供打印。"""
    per: dict[str, int] = {}
    pending = None
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z0-9_.\[\]-]+)==", line)
        if m:
            pending = canon(m.group(1).split("[")[0])
            per.setdefault(pending, 0)
            continue
        if re.match(r"^\s*--hash=sha256:", line) and pending:
            per[pending] += 1
    return per, {}


def run_instructions(text: str) -> str:
    """把 Dockerfile 里所有 RUN 指令（含 `\\` 续行）拼成一段文本，注释不参与。

    为什么要单独解析：判据要区分"文件被 COPY 进去"与"文件被 RUN 真的使用"，
    按全文或按单行匹配都会把前者算成后者（本轮实测反例：删掉选锁的 RUN 行仍然判绿）。
    """
    out: list[str] = []
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if current is None:
            if line.upper().startswith("RUN "):
                current = line[4:]
            elif line.upper() == "RUN":
                current = ""
            else:
                continue
        else:
            if line.endswith("\\"):
                current += " " + line[:-1].strip()
                continue
            current += " " + line
        if not line.endswith("\\"):
            out.append(current or "")
            current = None
    return "\n".join(out)


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


def lock_checks(path: str, want_platform: str, declared: list[tuple[str, str, str]]) -> tuple[list, dict[str, str], int]:
    """对**一把**锁跑 1–6 号判据；返回 (判据列表, 版本表, 哈希总数)。"""
    tag = os.path.basename(path)
    text = read(path)
    pins = parse_lock(text)
    checks: list[tuple[str, bool, str]] = []

    checks.append((f"[{tag}] 锁内包数 ≥ {MIN_PACKAGES}（非空证明）", len(pins) >= MIN_PACKAGES, f"实测 {len(pins)}"))

    head = "\n".join(text.splitlines()[:3])
    ok_flags = ("uv pip compile" in head and "--generate-hashes" in head
                and all(f in head for f in REQUIRED_FLAGS) and want_platform in head)
    checks.append((f"[{tag}] 头注含 uv pip compile + --generate-hashes + 平台 {want_platform}",
                   ok_flags, head[:170]))

    missing = [n for n, _op, _v in declared if n not in pins]
    checks.append((f"[{tag}] requirements.txt 每个声明包都钉进锁", not missing, f"缺 {missing}"))

    non_strict = [f"{k}={v}" for k, v in pins.items() if not re.match(r"^\d[\w.]*$", v)]
    checks.append((f"[{tag}] 锁内全部为精确 == 版本（无区间/无 @ url）", not non_strict, f"异常 {non_strict[:4]}"))

    violates: list[str] = []
    for name, op, want in declared:
        got = pins.get(name)
        if not got:
            continue
        if op in (">=", "~=", ">") and vtuple(got) < vtuple(want):
            violates.append(f"{name}: 声明 {op}{want} 但锁内 {got}")
        if op == "==" and got != want:
            violates.append(f"{name}: 声明 =={want} 但锁内 {got}")
    checks.append((f"[{tag}] 锁内版本满足声明区间（防改声明不重锁）", not violates, "; ".join(violates[:4])))

    per, _ = count_hashes(text)
    nohash = [k for k, v in per.items() if v == 0]
    checks.append((f"[{tag}] 每个条目都带 ≥1 个 sha256 哈希", not nohash, f"无哈希 {nohash[:4]}"))
    return checks, pins, sum(per.values())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="只打印对账明细，不判红")
    ap.add_argument("--quiet", action="store_true", help="只输出失败项与门禁结论（pre-commit / CI 用）")
    ap.add_argument("--lock", default="", help="只查指定锁（默认查 LOCKS 里全部；单锁调试用）")
    args = ap.parse_args()

    targets: tuple[tuple[str, str], ...] = LOCKS
    if args.lock:
        pair = [(p, plat) for p, plat in LOCKS if os.path.abspath(p) == os.path.abspath(args.lock)]
        if not pair:
            pair = [(args.lock, "x86_64-unknown-linux-gnu")]
        targets = tuple(pair)

    for p, _plat in targets:
        if not os.path.exists(p):
            print(f"FAIL 缺少锁文件：{os.path.relpath(p, REPO)}")
            return 1
    for p in (REQ, DOCKERFILE):
        if not os.path.exists(p):
            print(f"FAIL 缺少文件：{os.path.relpath(p, REPO)}")
            return 1

    req_text, docker_text = read(REQ), read(DOCKERFILE)
    declared = parse_reqs(req_text)
    checks: list[tuple[str, bool, str]] = []
    all_pins: dict[str, dict[str, str]] = {}
    total_hashes = 0

    for path, platform in targets:
        cs, pins, hashes = lock_checks(path, platform, declared)
        checks.extend(cs)
        all_pins[os.path.basename(path)] = pins
        total_hashes += hashes

    # 7) 接线实证：Dockerfile 必须真的从锁安装。
    # 只认**指令行**（RUN/COPY/…），注释一律不参与判定。
    # 反例实测（第十八轮自查）：Dockerfile 注释里写了「开 --require-hashes」而 RUN 行没有，
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

    # 8) 多架构新增：每把**非基准**锁都必须进入 RUN 指令（真正的选锁/安装路径）。
    # 只 COPY 进镜像而没人用它 = arm64 装的仍是 amd64 锁（`--require-hashes` 必装不动），
    # 但"锁文件存在"和"COPY 里有它"两条判据都会绿——正是本仓反复出现的"死文件假绿"形态。
    # 实测反例：删掉 `RUN if [ "$TARGETARCH" = "arm64" ]; then cp ...; fi` 一行，
    # 若只按"是否出现在指令行里"判，rc 仍为 0（假绿）；改按 RUN 判后 rc=1。
    docker_run_text = run_instructions(docker_text)
    base_lock_name = os.path.basename(LOCKS[0][0])
    unused = [name for name in all_pins if name != base_lock_name and name not in docker_run_text]
    checks.append((f"每把额外平台的锁都被 RUN 真的选用（锁数 {len(all_pins)}）",
                   not unused and len(all_pins) >= MIN_LOCKS,
                   f"未出现在任何 RUN 里 {unused}" if unused else (
                       f"锁数 {len(all_pins)} < {MIN_LOCKS}（宣称多架构却不成立）" if len(all_pins) < MIN_LOCKS else "")))

    # 9) 各锁版本集全等（同一时刻重算的证据）。
    base_name = next(iter(all_pins))
    base = all_pins[base_name]
    drift: list[str] = []
    for name, table in all_pins.items():
        if name == base_name:
            continue
        for k in sorted(set(base) | set(table)):
            if base.get(k) != table.get(k):
                drift.append(f"{base_name}:{k}={base.get(k)} vs {name}:{k}={table.get(k)}")
    checks.append((f"各锁版本集全等（基准 {base_name}，{len(base)} 包）", not drift, "; ".join(drift[:5])))

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
        print(f"== 依赖锁定对账（{len(all_pins)} 把锁 / 锁内 {len(base)} 包 / 合计 {total_hashes} 条哈希）==")
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
    print(f"[GATE:lock-{'pass' if rc == 0 else 'fail'}] 声明 {len(declared)} 条 → 每锁 {len(base)} 条（含传递依赖）")
    return rc


if __name__ == "__main__":
    sys.exit(main())
