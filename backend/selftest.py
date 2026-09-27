#!/usr/bin/env python3
"""镜像/CI 通用自证 runner：从 tests/suite.json 驱动，逐套执行并在任一失败时 fail-fast。

为什么要有它（第二十轮）：清单此前在 `docker-compose.yml` 与 `frontend/package.json` 各抄一份，
新增套件漏挂 ⇒ 发布的镜像自证的是过期套件。改由单一源驱动后，漏挂由 `scripts/suite_guard.py` 判红。

为什么 v1.41.0 要加"作用域"这一层（第四十四轮一手实测）：镜像内的 selftest 从来没绿过，
而这件事在加 `workflow_run` 触发器之前无人知晓——`event=schedule` 全仓 0 条 run。
真因不是套件写错，是**构建上下文只有 `backend/`**：9 个套件里有若干个用
`Path(__file__).resolve().parents[2]` 去仓库根取 `data/*.json` 与 `frontend/**` 的对照文件，
在镜像里那个位置是 `/srv/`，Dockerfile 从没往那儿放过东西 ⇒ 第一次读就
`FileNotFoundError: '/srv/data/knowledge.json'`，fail-fast 把后面所有套件一起带走。
一条永远不可能绿的判据比没有判据更糟（它会把"跑过了"当成"验过了"）。

划界规则（不写死条目名单，豁免由事实推导）：
  · 静态扫每套源码里指向仓库根的引用（内联链 `parents[2] / "a" / "b"`，或先 `ROOT = ...parents[2]`
    再 `ROOT / "a" / "b"`）；
  · 「在不在」有两种取法：盘上探测（镜像内／CI 内自动判定）与按 Dockerfile 的 COPY 目标推算（本机无
    docker 守护进程时用它出回执，见 --simulate-image）；
  · 引用不在 ⇒ 该条 SKIP 并点名缺失路径；一条都不跑 ⇒ rc=2，绝不记绿。

用法：
  python selftest.py                  # 逐套跑；仓库根在场时全跑，镜像内自动 SKIP 取不到的那些
  python selftest.py --simulate-image # 按 backend/Dockerfile 推算镜像里有什么，只报告不执行
  python selftest.py --coverage       # 每套前面套 coverage run --append（供覆盖率地板门禁接续）
  python selftest.py --only tests/test_fhir.py   # 只跑指定套件（本地调试）
  python selftest.py --selftest       # 离线自证这条划界规则本身（含会红的反例）
退出码：0=该跑的全绿；1=有套件失败；2=清单/作用域判据失效（缺文件、空清单、零可跑套件）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
MANIFEST = os.path.join(HERE, "tests", "suite.json")
DOCKERFILE = os.path.join(HERE, "Dockerfile")

#: 套件用「仓库根」解析跨树依赖的写法：先 `NAME = Path(__file__).resolve().parents[2] [/ "子路径"...]`
#: 起一个前缀别名，再在该名字上续接链。v1.41.0 实测：只认「直接 parents[2]」会把
#: `FIX_DIR / "x.json"` 里的 x.json 算到仓库根头上（错指成 /srv/x.json），证据行本身就是错的。
_ASSIGN_RE = re.compile(r'(\w+)\s*=\s*Path\(__file__\)\.resolve\(\)\.parents\[2\]((?:\s*/\s*"[^"]+")*)')
_INLINE_RE = re.compile(r'parents\[2\]((?:\s*/\s*"[^"]+")+)')


def _chain_to_rel(chain: str) -> str:
    return "/".join(re.findall(r'"([^"]+)"', chain))


def required_repo_paths(src: str) -> list[str]:
    """静态扫出一份套件源码引用到的「仓库根相对路径」，别名前缀按其自身深度还原。"""
    bases = {m.group(1): _chain_to_rel(m.group(2)) for m in _ASSIGN_RE.finditer(src)}
    found = {_chain_to_rel(m.group(1)) for m in _INLINE_RE.finditer(src)}
    for name, base in bases.items():
        if base:
            found.add(base)
        for m in re.finditer(rf'\b{re.escape(name)}((?:\s*/\s*"[^"]+")+)', src):
            tail = _chain_to_rel(m.group(1))
            found.add(f"{base}/{tail}" if base else tail)
    return sorted(found)


def _posix_norm(path: str) -> str:
    """容器内路径一律按 POSIX 归一——**不能用 os.path.normpath**：本机是 Windows，
    它会把 /srv/backend 改写成 \\srv\\backend，判据就从"和镜像一致"退化成"只在这台机器成立"。"""
    return "/" + "/".join(p for p in path.split("/") if p not in ("", "."))


def image_paths_from_dockerfile(text: str) -> list[str]:
    """从 Dockerfile 推出「镜像里会出现哪些绝对路径」（WORKDIR + COPY 目标）。

    只认目录/文件目标的**前缀**语义：`COPY app ./app` 在 WORKDIR /srv/backend 下 ⇒ /srv/backend/app
    及其子路径都在镜像里。不模拟 .dockerignore 与构建失败（那是 docker_context_guard 的判据面）。
    """
    workdir = "/"
    dests: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("WORKDIR"):
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[1].strip().startswith("/"):
                workdir = parts[1].strip()
        elif line.startswith("COPY") and "--from=" not in line:
            args = [a for a in line.split()[1:] if not a.startswith("--")]
            if not args:
                continue
            dest = args[-1].rstrip("/")
            if not dest.startswith("/"):
                dest = workdir if dest in (".", "./") else f"{workdir.rstrip('/')}/{dest}"
            dest = _posix_norm(dest)
            if dest not in dests:
                dests.append(dest)
    return dests


def in_image(path: str, dests: list[str]) -> bool:
    return any(path == d or path.startswith(d + "/") for d in dests)


def probe_path(ref: str, mode: str) -> str:
    """把「仓库根相对引用」换成两种模式下**真正被探的那个路径**（单独成函数是为了可注入自测）。

    v1.41.0 发布日志实测到 disk 模式回显过 `data/knowledge.json -> data/knowledge.json`
    （两侧同一串，读起来像判据没算路径）：结论没错，但证据行失去了定位信息。
    镜像里跑 plain `python selftest.py` 走的就是 disk 这条。
    """
    if mode == "image":
        return _posix_norm(f"/srv/{ref}")          # 镜像内 parents[2] == /srv
    return os.path.join(REPO_ROOT, *ref.split("/"))


def scope_plan(suites: list[str], mode: str) -> list[tuple[str, bool, list[str]]]:
    """返回 [(套件, 可跑?, 缺失引用)]。mode="disk" 按盘上存在性；"image" 按 Dockerfile 推算。"""
    dests: list[str] = []
    if mode == "image":
        if not os.path.exists(DOCKERFILE):
            raise SystemExit(f"[GATE:selftest-fail] 取不到 {DOCKERFILE} ⇒ 无法推算镜像内容，不猜")
        with open(DOCKERFILE, encoding="utf-8") as f:
            dests = image_paths_from_dockerfile(f.read())
    plan = []
    for rel in suites:
        src_path = os.path.join(HERE, rel)
        if not os.path.exists(src_path):
            plan.append((rel, False, [f"<套件文件缺失:{rel}>"]))
            continue
        with open(src_path, encoding="utf-8") as f:
            refs = required_repo_paths(f.read())
        missing = []
        for ref in refs:
            probe = probe_path(ref, mode)
            ok = in_image(probe, dests) if mode == "image" else os.path.exists(probe)
            if not ok:
                missing.append(f"{ref} -> {probe}")
        plan.append((rel, not missing, missing))
    return plan


def load_suites(only: list[str]) -> list[str]:
    if not os.path.exists(MANIFEST):
        print(f"FAIL 缺清单：{MANIFEST}")
        sys.exit(2)
    with open(MANIFEST, encoding="utf-8") as f:
        suites = [s.replace("\\", "/") for s in (json.load(f).get("suites") or [])]
    if not suites:
        print("FAIL 清单为空（空清单不得判绿）")
        sys.exit(2)
    if only:
        unknown = [o for o in only if o not in suites]
        if unknown:
            print(f"FAIL --only 指定了清单外的条目：{unknown}")
            sys.exit(2)
        return only
    return suites


def selftest() -> int:
    """离线自证：分类器认得两种写法、Dockerfile 解析认得真实那份、缺文件必须进 SKIP。"""
    cases: list[tuple[str, bool, str]] = []
    inline = 'X = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures" / "a.json"'
    cases.append(("内联链被识别", required_repo_paths(inline) == ["frontend/tests/fixtures/a.json"],
                  f"实测 {required_repo_paths(inline)}"))
    alias = ('ROOT = Path(__file__).resolve().parents[2]\n'
             'auth = json.load(open(ROOT / "data" / "knowledge.json", encoding="utf-8"))')
    cases.append(("ROOT 别名式被识别", required_repo_paths(alias) == ["data/knowledge.json"],
                  f"实测 {required_repo_paths(alias)}"))
    nested = ('FIX_DIR = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures"\n'
              'spec = json.loads((FIX_DIR / "red_flag_mutations.json").read_text(encoding="utf-8"))')
    got_nested = required_repo_paths(nested)
    cases.append(("别名自带前缀 ⇒ 续接链按该前缀还原（不得错指仓库根）",
                  "frontend/tests/fixtures/red_flag_mutations.json" in got_nested
                  and "red_flag_mutations.json" not in got_nested,
                  f"实测 {got_nested}"))
    cases.append(("无跨树引用 ⇒ 空集（不误判成需要仓库根）", required_repo_paths("import os\nx=1") == [],
                  "实测非空"))
    with open(DOCKERFILE, encoding="utf-8") as f:
        dests = image_paths_from_dockerfile(f.read())
    cases.append(("真实 Dockerfile 解析出 /srv/backend/tests",
                  in_image("/srv/backend/tests", dests), f"实测 dests={dests}"))
    cases.append(("解析结果不得含反斜杠（os.path.normpath 在 Windows 上会把 /srv 改写成 \\\\srv，"
                  "判据就只在单机成立）",
                  not any("\\" in d for d in dests), f"实测 dests={dests}"))
    cases.append(("反向：仓库根 data/ 不在镜像里 ⇒ 判为取不到",
                  not in_image("/srv/data/knowledge.json", dests), f"实测 dests={dests}"))
    cases.append(("反向：改 Dockerfile 若把 data 放进镜像，同一判据必须转可跑",
                  in_image("/srv/data/knowledge.json", dests + ["/srv/data"]),
                  "注入 /srv/data 后仍判取不到 ⇒ 判据与 Dockerfile 脱钩"))
    d_probe = probe_path("data/knowledge.json", "disk")
    cases.append(("disk 模式证据行须给**真正探过的绝对路径**（不得两侧同一串）",
                  d_probe == os.path.join(REPO_ROOT, "data", "knowledge.json") and d_probe != "data/knowledge.json",
                  f"实测 {d_probe!r}（REPO_ROOT={REPO_ROOT!r}）"))
    cases.append(("image 模式证据行须给 /srv 前缀（镜像内 parents[2] 的真实位置）",
                  probe_path("data/knowledge.json", "image") == "/srv/data/knowledge.json",
                  f"实测 {probe_path('data/knowledge.json', 'image')!r}"))
    fake = scope_plan(["tests/不存在的套件.py"], "image")
    cases.append(("套件文件缺失 ⇒ 点名且不判可跑", fake[0][1] is False and "套件文件缺失" in fake[0][2][0],
                  f"实测 {fake[0]}"))
    real = scope_plan(load_suites([]), "image")
    ran = [p for p in real if p[1]]
    cases.append(("镜像口径下仍有一条以上可跑（零可跑不得记绿）", len(ran) >= 1,
                  f"实测可跑 {len(ran)}/{len(real)}"))
    fails = 0
    for name, ok, detail in cases:
        print(f"  {'PASS' if ok else 'FAIL'} {name}" + ("" if ok else f" :: {detail}"))
        fails += 0 if ok else 1
    print(f"SELFTEST: {len(cases) - fails}/{len(cases)}")
    print("[GATE:selftest-classifier-fail]" if fails else "[GATE:selftest-classifier-pass]")
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage", action="store_true")
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--simulate-image", action="store_true",
                    help="按 backend/Dockerfile 推算镜像内容，只报告不执行（本机无 docker 守护进程时的回执面）")
    ap.add_argument("--selftest", action="store_true", help="离线自证作用域分类器")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    suites = load_suites(args.only)
    mode = "image" if args.simulate_image else "disk"
    plan = scope_plan(suites, mode)
    skipped = [p for p in plan if not p[1]]
    runnable = [p for p in plan if p[1]]
    head = "镜像推算（--simulate-image，未执行）" if args.simulate_image else "实跑"
    print(f"== 后端自证 runner：{head}，清单 {len(suites)} 套 ⇒ 可跑 {len(runnable)} / SKIP {len(skipped)} ==")
    for rel, _ok, missing in skipped:
        print(f"  SKIP {rel} :: 跨树引用在镜像内取不到 → {missing}")
    if args.simulate_image:
        print(f"SIMULATE SUMMARY: 可跑 {len(runnable)}/{len(suites)}，SKIP {len(skipped)} 条（原因逐条点名）")
        return 0 if runnable else 2
    if not runnable:
        print("FAIL 没有任何套件可跑（清单或作用域判据失效，绝不记绿）")
        return 2
    for rel, _ok, _m in runnable:
        cmd = [sys.executable]
        if args.coverage:
            cmd += ["-m", "coverage", "run", "--append", "--source=app"]
        cmd += [rel]
        r = subprocess.run(cmd, cwd=HERE)
        if r.returncode != 0:
            print(f"FAIL {rel} 退出码 {r.returncode}（fail-fast，后续套件不再执行）")
            return 1
        print(f"  OK {rel}")
    print(f"SELFTEST SUMMARY: {len(runnable)}/{len(suites)} 套件 exit0"
          + (f"（{len(skipped)} 条 SKIP：跨树引用不在镜像内）" if skipped else ""))
    print("[GATE:selftest-pass]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
