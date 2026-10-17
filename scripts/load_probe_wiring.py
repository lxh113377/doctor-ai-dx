#!/usr/bin/env python3
"""「load_probe 真进 CI」的接线自证（第一百一十二轮）。

一手缺口（r111-8 台账原文）：scripts/load_probe.mjs 已在仓内，但**没有任何作业在跑它**——
docs/OBSERVABILITY.md §七 自陈「活端点并发读数仍需人工触发」。「仓里有件」与「件在跑」是两件事
（r100「在册≠在跑」、r110-1「在盘≠可用」、r111-3「有入口≠入口如实转达」同族）。

本件判五条，缺一即红：
  1) live-smoke.yml 里有 live-concurrency 作业；
  2) 该作业真调用 scripts/load_probe.mjs --base ...；
  3) 调用行必须带 --serial（否则判的是绝对吞吐地板 20 req/s —— 那是 localhost 经验值，
     挪到公网端点会「国内恒红 / 海外恒绿」，同一阈值两处结论相反就不是一把尺）；
  4) 阈值只许住 scripts/load_probe.mjs 的 LOAD_SLO（工作流不得自写数字地板）；
  5) 判据方向与反例腿在场：probe 里必须有 serial_rps 分支 + min_conc_ratio + 至少 5 处 serial 腿。

退出码：0 PASS / 1 FAIL（缺一条即失败，不折成「部分通过」）/ 2 取数面坏。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WF = ROOT / ".github" / "workflows" / "live-smoke.yml"
PROBE = ROOT / "scripts" / "load_probe.mjs"


def _check(wf: str, probe: str) -> list[str]:
    """纯函数：给两份文本，返回不成立条目（反例腿靠它驱动，不碰盘）。"""
    fails: list[str] = []
    if "live-concurrency:" not in wf:
        fails.append("no-job")
    call = [ln for ln in wf.splitlines() if "scripts/load_probe.mjs --base" in ln]
    if not call:
        fails.append("no-call")
    elif "--serial" not in call[0]:
        fails.append("no-serial")
    if re.search(r"load_probe[^\n]*min[-_]rps", wf):
        fails.append("dup-threshold")
    if "serial_rps" not in probe:
        fails.append("no-branch")
    if "min_conc_ratio" not in probe:
        fails.append("no-ratio")
    if len(re.findall(r"serial_rps", probe)) < 5:
        fails.append("few-legs")
    return fails


def selftest() -> int:
    wf0 = WF.read_text(encoding="utf-8") if WF.exists() else ""
    pr0 = PROBE.read_text(encoding="utf-8") if PROBE.exists() else ""
    if not wf0 or not pr0:
        print("[GATE:loadprobe-wiring-selftest-fail] 取数面坏：真面文件都读不到", file=sys.stderr)
        return 2
    good = _check(wf0, pr0)
    legs = []
    legs.append(("真实面零不合规（正向对照）", good == []))
    legs.append(("删掉作业名 ⇒ 抓 to no-job", "no-job" in _check(wf0.replace("live-concurrency:", "x-y:"), pr0)))
    legs.append(("删掉调用行 ⇒ 抓 no-call", "no-call" in _check(wf0.replace("scripts/load_probe.mjs --base", "scripts/other.mjs --base"), pr0)))
    legs.append(("调用行去掉 --serial ⇒ 抓 no-serial", "no-serial" in _check(wf0.replace("--duration 20 --serial", "--duration 20"), pr0)))
    legs.append(("工作流自写吞吐地板 ⇒ 抓 dup-threshold", "dup-threshold" in _check(wf0 + "\n# load_probe min_rps 20\n", pr0)))
    legs.append(("probe 去掉 serial 分支 ⇒ 抓 no-branch", "no-branch" in _check(wf0, pr0.replace("serial_rps", "na"))))
    legs.append(("probe 去掉地板比阈值 ⇒ 抓 no-ratio", "no-ratio" in _check(wf0, pr0.replace("min_conc_ratio", "na"))))
    legs.append(("反例腿不足 ⇒ 抓 few-legs", "few-legs" in _check(wf0, "serial_rps \n min_conc_ratio")))
    bad = [n for n, ok in legs if not ok]
    for n, ok in legs:
        print(("PASS " if ok else "FAIL ") + n)
    print(f"\n[GATE:loadprobe-wiring-selftest-{'pass' if not bad else 'fail'}] {len(legs) - len(bad)}/{len(legs)}")
    return 0 if not bad else 1


def main() -> int:
    fails: list[str] = []
    if not WF.exists():
        print("[GATE:loadprobe-wiring-broken] live-smoke.yml 取不到 ⇒ 该维未验，不得记绿", file=sys.stderr)
        return 2
    if not PROBE.exists():
        print("[GATE:loadprobe-wiring-broken] scripts/load_probe.mjs 取不到 ⇒ 该维未验，不得记绿", file=sys.stderr)
        return 2
    wf = WF.read_text(encoding="utf-8")
    probe = PROBE.read_text(encoding="utf-8")
    fails = _check(wf, probe)
    legs = len(re.findall(r"serial_rps", probe))
    if fails:  # 分档打印：反例腿用同一组名字，免得「判据改了名字、腿还在测旧名字」
        print(f"[GATE:loadprobe-wiring-fail] {len(fails)} 条不成立：" + "；".join(fails))
        return 1
    print(
        f"[GATE:loadprobe-wiring-pass] 作业在场｜调用行带 --serial｜阈值单一源(LOAD_SLO)｜"
        f"判据方向 serial_rps+min_conc_ratio｜腿 {legs} 处"
    )
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
