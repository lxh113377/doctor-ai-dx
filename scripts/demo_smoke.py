#!/usr/bin/env python
"""一键演示启动链的常驻烟测（第三十八轮，台账 #44）。

对标取证（2026-09-27 实测，`gh api` 现取，peer 一律写全名）：`openemr/openemr` 有
`.github/actions/` 六个 composite 与 `windows-ci.yml`——**它把"评审第一条命令"本身当成被测对象**；
`cqframework/clinical_quality_language`（333★，HL7 CQL 规范实现）有 `check-pr.yml`＋`issue-matcher.yml`。
我方此前 `start-demo.sh` / `start-demo.ps1` 是 README 承诺给评审跑的第一条命令，而全仓**没有任何文件引用过它**
（实测 `grep -rl "start-demo" frontend/tests scripts/ backend/tests .github/workflows` = 0 命中）——
即"文档承诺有一键启动、CI 从没跑过这条链"。e2e 作业测的是我自己手写的 `wrangler pages dev` 等价命令，
不是这两份脚本：脚本里的路径／端口／依赖分支烂掉也不会有任何东西变红。

本脚本把断言面从"线上 URL"（`live_smoke.py` 的职责）挪到"这条命令真的起得来、起来后的东西真的可用"：

  腿 1 配对对账（离线，恒跑）：两份脚本按键表**同时**命中，端口从两侧现取后逐字全等；
        只有一侧有的标志也算漂移（本轮就抓到 `.sh` 带 `--no-audit --no-fund` 而 `.ps1` 不带）。
  腿 2 真起服务（默认开）：直接跑 `bash start-demo.sh`（被测对象就是它，不是等价重写），
        等 `GET /api/health` 就绪 → `GET /` 拿到 SPA 壳 → `POST /api/dx/c1` 走红线断言；
        拆除按平台分支并复验端口释放。
  腿 3 `--selftest`：纯离线，把合成文本喂给腿 1 与腿 2 的归因函数，要求**每条判据都有能让它红的样本**。

红线断言一律 `import live_smoke` 复用（`check_health`／`check_dx`／`kb_ids`／`repo_version`），
本文件不写第二套口径——同一判断只有一处实现，否则两侧会各自漂移。

用法：
  python scripts/demo_smoke.py                     # 腿 1 ＋ 腿 2（需要 node 与 Git Bash）
  python scripts/demo_smoke.py --pair-only         # 只跑离线腿 1（零网络零子进程，出包预检用）
  python scripts/demo_smoke.py --wired             # 附带腿 1b：核对本判据真挂在两条阻断链上
  python scripts/demo_smoke.py --selftest          # 只跑腿 3（反例自证）
退出码：0 全绿 / 1 判红 / 2 环境不可用（缺 bash、缺 node、服务没起来都算 2，**不许记成通过**）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
SH = REPO / "start-demo.sh"
PS1 = REPO / "start-demo.ps1"
PORT_RE = re.compile(r"--port\s+(\d+)")
LOCAL_RE = re.compile(r"--local\b")
# 两份脚本必须**同时**具备的口径。正则取的是"这条链对外承诺的东西"，不是实现细节：
# 端口写法、构建步、条件安装步、一体化托管、零云端、无 Key 降级说明、退出方式。
PAIR_KEYS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("演示病例提示（张建国·胸痛红旗全流程）", re.compile(r"张建国\s*·\s*胸痛红旗全流程")),
    ("无 Key 自动降级的对外说明", re.compile(r"无 DeepSeek Key 时自动进入【规则引擎降级模式】")),
    ("构建前端 dist", re.compile(r"npm run build")),
    ("条件安装依赖", re.compile(r"npm install")),
    ("安装步静音（--no-audit --no-fund）", re.compile(r"--no-audit --no-fund")),
    ("一体化托管 dist + functions", re.compile(r"pages dev dist")),
    ("零云端 --local 模式", LOCAL_RE),
    ("三步进度标号 [1/3]", re.compile(r"\[1/3\]")),
    ("监听 127.0.0.1（不外露）", re.compile(r"127\.0\.0\.1")),
    ("退出方式 Ctrl+C", re.compile(r"Ctrl\+C")),
)
Row = tuple[str, bool, str]
DEFAULT_BOOT_TIMEOUT = 240.0
POLL_INTERVAL = 2.0


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""


def pair_rows(sh_text: str, ps1_text: str) -> tuple[list[Row], int]:
    """腿 1：逐键要求两份脚本同时命中，外加端口/--local 现取值全等。返回 (判据行, 命中键数)。"""
    rows: list[Row] = []
    hit = 0
    for label, pattern in PAIR_KEYS:
        in_sh, in_ps1 = bool(pattern.search(sh_text)), bool(pattern.search(ps1_text))
        hit += 1 if (in_sh and in_ps1) else 0
        rows.append((f"两份脚本同时具备：{label}", in_sh and in_ps1,
                     f"sh={'有' if in_sh else '无'} ps1={'有' if in_ps1 else '无'}"))
    p_sh, p_ps1 = PORT_RE.search(sh_text), PORT_RE.search(ps1_text)
    v_sh = p_sh.group(1) if p_sh else ""
    v_ps1 = p_ps1.group(1) if p_ps1 else ""
    rows.append(("端口由两侧现取且逐字全等（不抄常量）", bool(v_sh) and v_sh == v_ps1, f"sh={v_sh!r} ps1={v_ps1!r}"))
    rows.append(("端口现取来源可信（两侧都真写了 --port）", bool(v_sh) and bool(v_ps1), f"sh={v_sh!r} ps1={v_ps1!r}"))
    rows.append((f"对账键表确有输入（命中 ≥6 键，实测 {hit}/{len(PAIR_KEYS)}）", hit >= 6,
                 "命中 0 键＝两份脚本都没读进来，判红而不是跳过"))
    return rows, int(v_sh) if v_sh else 0


def fetch(url: str, timeout: float = 5.0) -> tuple[int, str]:
    """只取状态码与原文（HTML 不是 JSON，不能走 live_smoke.call）。"""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "doctor-ai-dx-demo-smoke"}),
                                    timeout=timeout) as resp:
            return int(resp.status), resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return int(exc.code), exc.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError):
        return 0, ""


def attribute_boot(log_text: str, timed_out: bool) -> tuple[str, str]:
    """把"没起来"归因成可读原因——失败分支只读文本，无能力抛异常。

    根因不是设想：`EADDRINUSE` 与 npm 安装失败在输出里的形状不同，而两者都不该被统一报成"超时"，
    否则下一轮排查还得再手工读一遍日志（同族教训：归因第一步是脚本自己落的全文 log）。
    """
    low = log_text.lower()
    if not timed_out:
        return "ready", ""
    if "eaddrinuse" in low or "address already in use" in low:
        return "port-in-use", "端口被占：先释放或换端口"
    if "npm error" in low or "could not determine executable" in low or "command not found" in low:
        return "install-failed", "依赖或可执行文件缺失"
    if "error" in low and "wrangler" in low:
        return "wrangler-error", "wrangler 自身报错"
    return "boot-timeout", "未在时限内应答 /api/health（日志尾部见输出）"


def spawn_demo(bash: str, log_handle: object) -> subprocess.Popen[bytes]:
    """真跑 start-demo.sh 本身（被测对象就是它）。日志落受管根之外，句柄由调用方负责关。"""
    popen_kw: dict[str, Any] = {
        "cwd": str(REPO),
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        # 走 getattr 而不是直写：mypy 的 subprocess 桩按平台分文件，Linux 侧没有 CREATE_NEW_PROCESS_GROUP
        # ⇒ 直写会让 CI 的 type_gate 判 attr-defined 而本机全绿（本轮实测：本机 0 error、CI 1 error）。
        # 与 stop_demo 里 os.killpg/getpgid 同一族，两处一律走 getattr。
        popen_kw["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_kw["start_new_session"] = True
    return subprocess.Popen([bash, str(SH)], **popen_kw)


def wait_ready(port: int, timeout: float) -> tuple[bool, str, float]:
    """轮询 /api/health 直到应答；返回 (是否就绪, 最后一次原文, 耗时)。"""
    started = time.monotonic()
    body = ""
    while time.monotonic() - started < timeout:
        status, body = fetch(f"http://127.0.0.1:{port}/api/health")
        if status == 200:
            return True, body, time.monotonic() - started
        time.sleep(POLL_INTERVAL)
    return False, body, time.monotonic() - started


def mode_not_overclaim(llm_mode: str, mode: str) -> bool:
    """界面标注的档位不许比服务自报的档位更"高级"。

    服务自己说没 Key（`health.llm_mode != live`）却给出 `dx.mode == live`，等于把规则降级结果
    冒充成模型结论——这才是脚本里那句"无 Key 自动降级并明确标注"的可机器判形态（可观测性先于调参）。
    """
    return llm_mode == "live" or mode != "live"


# 本判据必须挂上的两条阻断链。写在这里而不是"记得去加"——`--wired` 会逐面核对，漏一面即判红
# （规矩在案：判据没进阻断链＝半成品；同族先例 suite_guard 核「清单↔CI」、branch_guard 核「保护↔作业图」）。
WIRE_FACES: tuple[tuple[str, Path], ...] = (
    ("CI 阻断链（e2e 作业真跑 start-demo.sh）", REPO / ".github" / "workflows" / "ci.yml"),
    ("出包预检链（release.yml 跑离线两腿）", REPO / ".github" / "workflows" / "release.yml"),
)


def wired_rows(texts: dict[str, str]) -> list[Row]:
    """腿 1b：核对每份面上都真的写着对 `demo_smoke` 的调用。纯函数，便于反例自证。"""
    rows: list[Row] = []
    for label, path in WIRE_FACES:
        text = texts.get(str(path), "")
        hit = "demo_smoke" in text
        rows.append((f"已接线：{label}", hit,
                     f"{path.relative_to(REPO)} {'含 demo_smoke 调用' if hit else '未见调用（写了不接＝没写）'}"))
    n = len(WIRE_FACES)
    rows.append((f"接线面声明非空（≥2 面，实测 {n}）", n >= 2, "0 面＝本腿无从判定，判红而不是跳过"))
    return rows


def read_wire_texts() -> dict[str, str]:
    return {str(path): _read(path) for _label, path in WIRE_FACES}


def stop_demo(proc: subprocess.Popen[bytes]) -> None:
    """平台分支拆除整棵进程树（wrangler 会再 fork，杀父不杀子＝端口没释放）。"""
    if proc.poll() is not None:
        return
    killpg = getattr(os, "killpg", None)
    getpgid = getattr(os, "getpgid", None)
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
    elif killpg is not None and getpgid is not None:
        # getattr 而非直写 os.killpg：Windows 的类型桩里没有这两个 POSIX 符号，
        # 直写会让 type_gate 在本机报 attr-defined（判据不能依赖运行平台）。
        try:
            killpg(getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            proc.terminate()
    else:
        proc.terminate()
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()


def port_free(port: int, timeout: float = 15.0) -> bool:
    """拆除后复验端口不再应答——"我杀了"不等于"端口还回来了"。"""
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        status, _ = fetch(f"http://127.0.0.1:{port}/api/health", timeout=2.0)
        if status == 0:
            return True
        time.sleep(1.0)
    return False


def boot_rows(port: int, quiet: bool) -> tuple[list[Row], int]:
    """腿 2：起服务→断言→拆除。返回 (判据行, 退出码基线：0 可继续／2 环境不可用)。"""
    bash = shutil.which("bash")
    if not bash:
        print("[GATE:demo-smoke-blocked] 缺 bash（Git Bash）⇒ 本机无法跑一键脚本，判环境不可用而不是通过",
              file=sys.stderr)
        return [("一键脚本可执行（bash 在场）", False, "which bash = 空")], 2
    if not shutil.which("node"):
        print("[GATE:demo-smoke-blocked] 缺 node ⇒ 判环境不可用（rc=2），不记通过", file=sys.stderr)
        return [("运行时 node 在场", False, "which node = 空")], 2
    log_path = Path(tempfile.gettempdir()) / f"demo_smoke_{os.getpid()}.log"
    logf = log_path.open("wb")
    proc = spawn_demo(bash, logf)
    logf.close()  # 子进程已继承自己的副本；父侧句柄留着就是泄漏（Windows 上还会挡住 unlink）
    try:
        ready, health_body, secs = wait_ready(port, DEFAULT_BOOT_TIMEOUT)
        log_text = _read(log_path)
        reason, hint = attribute_boot(log_text, timed_out=not ready)
        if not ready:
            tail = "\n".join(log_text.splitlines()[-15:])
            print(f"[GATE:demo-smoke-blocked] 一键服务未就绪 reason={reason} {hint}\n--- 日志尾部 ---\n{tail}",
                  file=sys.stderr)
            return [(f"服务就绪（reason={reason}）", False, hint or reason)], 2
        rows: list[Row] = [(f"服务就绪（跑的就是 start-demo.sh，{secs:.1f}s）", True, "GET /api/health=200")]
        rows += live_smoke.check_health(json.loads(health_body) if health_body.strip().startswith("{") else {},
                                        live_smoke.repo_version())
        st_html, html = fetch(f"http://127.0.0.1:{port}/")
        has_root = 'id="root"' in html
        rows.append(("评审打开首页即拿到 SPA 壳（非 404/白屏）", st_html == 200 and has_root,
                     f"GET / → {st_html}，root 容器={'在' if has_root else '不在'}"))
        allowed = live_smoke.kb_ids()
        st, body, call_secs = live_smoke.call(f"http://127.0.0.1:{port}", "POST", "/api/dx/c1", live_smoke.valid_case(), timeout=40.0)
        rows.append((f"/api/dx/c1 返回 200（实得 {st}）", st == 200, json.dumps(body, ensure_ascii=False)[:160]))
        if st == 200:
            rows += live_smoke.check_dx(body, allowed, call_secs)
        mode = str(live_smoke.obj(body.get("data")).get("mode", ""))
        llm_mode = str(live_smoke.obj(json.loads(health_body).get("data")).get("llm_mode", "")) if health_body.strip().startswith("{") else ""
        rows.append(("降级口径不自夸（health.llm_mode≠live 时 dx.mode 不得为 live）",
                     mode_not_overclaim(llm_mode, mode), f"health.llm_mode={llm_mode!r} dx.mode={mode!r}"))
    finally:
        stop_demo(proc)
        released = port_free(port)
        try:
            log_path.unlink(missing_ok=True)
        except OSError:
            pass
    rows.append(("拆除后端口确已释放（杀父≠杀子树）", released, f"port={port} free={released}"))
    return rows, 0


def selftest() -> int:
    """腿 3：每条判据都要有能让它红的合成样本＋一个必须绿的对照。不起服务、不联网。"""
    ok_sh, ok_ps1 = _read(SH), _read(PS1)
    good, _ = pair_rows(ok_sh, ok_ps1)
    bad_rows = [n for n, k, _ in good if not k]
    cases: list[tuple[str, bool]] = [
        ("现网两份脚本的配对对账必须全绿（否则本腿无从谈反例）", not bad_rows),
    ]
    m1, _ = pair_rows(ok_sh, PORT_RE.sub("--port 9999", ok_ps1))
    cases.append(("端口漂移会被咬：ps1 侧改成 9999 ⇒ 端口判据判红",
                  any("端口" in n and not k for n, k, _ in m1)))
    m2, _ = pair_rows(PORT_RE.sub("", ok_sh), ok_ps1)
    cases.append(("端口一侧缺失会被咬：sh 侧删掉 --port ⇒ 判红而不是跳过",
                  any("端口" in n and not k for n, k, _ in m2)))
    m3, _ = pair_rows(LOCAL_RE.sub("", ok_sh), ok_ps1)
    cases.append(("--local 只有一侧有会被咬", any("--local" in n and not k for n, k, _ in m3)))
    empty, _ = pair_rows("", "")
    cases.append(("读空不许记绿：两份都空 ⇒ 覆盖面判据判红",
                  any("确有输入" in n and not k for n, k, _ in empty)))
    cases.append(("归因不混谈：EADDRINUSE 日志归因 port-in-use 而非 boot-timeout",
                  attribute_boot("listen EADDRINUSE 127.0.0.1:8788", timed_out=True)[0] == "port-in-use"))
    cases.append(("归因不混谈：npm error 日志归因 install-failed",
                  attribute_boot("npm error code ETARGET", timed_out=True)[0] == "install-failed"))
    cases.append(("归因兜底：无特征的超时才是 boot-timeout",
                  attribute_boot("wrangler started", timed_out=True)[0] == "boot-timeout"))
    cases.append(("就绪路径不被归因（timed_out=False 恒 ready）", attribute_boot("anything", timed_out=False)[0] == "ready"))
    # 断言链自身的反向对照：红旗缺失必须被咬（复用 live_smoke 的同一组判据）
    ids_one: list[str] = sorted(live_smoke.kb_ids())[:1] or ["kb-001"]
    allowed_one: set[str] = set(ids_one)
    cases.append(("红线断言确有牙齿：flags 置空即判红",
                  any(not k for _, k, _ in live_smoke.check_dx(
                      live_smoke.good_dx_payload(ids_one, flags=[]), allowed_one, 1.0))))
    cases.append(("红线断言不误伤：合规合成响应全绿",
                  all(k for _, k, _ in live_smoke.check_dx(
                      live_smoke.good_dx_payload(ids_one), allowed_one, 1.0))))
    cases.append(("降级自夸会被咬：没 Key 却报 mode=live ⇒ 判红", not mode_not_overclaim("rule", "live")))
    cases.append(("降级不误伤：真 live（有 Key）与 rule-fallback 都放行",
                  mode_not_overclaim("live", "live") and mode_not_overclaim("rule", "rule-fallback")))
    real_wire = wired_rows(read_wire_texts())
    cases.append(("现网接线两面都在（漏一面本腿就无从谈反例）", all(k for _, k, _ in real_wire)))
    missing = {str(path): ("run: python3 scripts/demo_smoke.py\n" if i else "")
               for i, (_label, path) in enumerate(WIRE_FACES)}
    cases.append(("只接一条链会被咬：另一面清空 ⇒ 判红并点名是哪一面",
                  any(not k and "未见调用" in d for _n, k, d in wired_rows(missing))))
    cases.append(("两面全空（＝工作流文件没读进来）判红而不是跳过",
                  sum(1 for _n, k, _d in wired_rows({}) if not k) == len(WIRE_FACES)))
    bad = [n for n, k in cases if not k]
    for name, k in cases:
        print(f"{'ok  ' if k else 'BAD '} :: {name}")
    print(f"[GATE:demo-smoke-selftest-{'pass' if not bad else 'fail'}] {len(cases) - len(bad)}/{len(cases)}")
    return 0 if not bad else 1


def emit(rows: list[Row], quiet: bool) -> int:
    """打印并给结论：判红行始终可见，成功行受 --quiet 控制。"""
    fails = [(n, d) for n, k, d in rows if not k]
    for n, k, d in rows:
        if k and not quiet:
            print(f"  PASS {n} :: {d}")
        elif not k:
            print(f"  FAIL {n} :: {d}", file=sys.stderr)
    if fails:
        print(f"[GATE:demo-smoke-fail] 判红 {len(fails)}/{len(rows)} 项", file=sys.stderr)
        return 1
    print(f"[GATE:demo-smoke-pass] {len(rows)} 项全绿")
    return 0


# 红线判据的唯一实现处：本文件只搬运、不重写（同一判断两处实现必然各自漂移，#51 同族）。
sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_smoke  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="一键演示启动链烟测（腿 1 配对对账／腿 2 真起服务／腿 3 反例自证）")
    ap.add_argument("--pair-only", action="store_true", help="只跑离线腿（配对对账＋接线核对，零网络零子进程）")
    ap.add_argument("--wired", action="store_true", help="附带检查本判据是否真挂在 CI 与出包预检两条链上")
    ap.add_argument("--selftest", action="store_true", help="只跑反例自证")
    ap.add_argument("--quiet", action="store_true", help="只输出失败项与门禁结论")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    for path in (SH, PS1):
        if not path.is_file():
            print(f"[GATE:demo-smoke-blocked] 缺文件 {path}（一键入口不在场，无从对账）", file=sys.stderr)
            return 2
    rows, port = pair_rows(_read(SH), _read(PS1))
    if args.wired:
        rows += wired_rows(read_wire_texts())
    rc = emit(rows, args.quiet)
    if args.pair_only or rc:
        return rc if rc else 0
    if not port:
        print("[GATE:demo-smoke-blocked] 两份脚本都没写出端口 ⇒ 判环境不可用，不用默认端口蒙混", file=sys.stderr)
        return 2
    boot, env_rc = boot_rows(port, args.quiet)
    rc2 = emit(boot, args.quiet)
    return rc2 if rc2 else env_rc


if __name__ == "__main__":
    sys.exit(main())
