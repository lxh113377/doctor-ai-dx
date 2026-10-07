#!/usr/bin/env python3
"""dep_audit_gate.py — 「已知 dev-only 项按批处置」的机器载体（医·第一百零二轮 r101-10）。

起因（不是预防性加闸）：`dep-audit.yml` 的步骤名叫「npm audit（high 即红；已知 dev-only 项按批处置）」，
而命令是裸 `npm audit --audit-level=high`——**仓内没有任何件承载「批」是哪些条、凭什么、什么时候到期**。
后果是同一个红每周重开一次，而每次处置都要人重新论证一遍（第八十七轮就抓到过这条静默红）。
peer 口径：gitleaks 用 `.gitleaksignore`、osv-scanner 用 `osv-scanner.toml`，豁免一律做成入库可追责的机器件。

五条规则（各有 --selftest 反例腿）：
  UNBASELINED        当日全树面里有一条 ≥fail-on 的 advisory 不在基线 ⇒ 红（新增项必须当场论证）
  DEV_CLAIM_REFUTED  基线写着 dev-only，但 `--omit=dev` 的生产树面里**也在场** ⇒ 红（形容词不算证据）
  EXPIRED            今天晚于该条 fix_due ⇒ 红（豁免有保质期）
  DEAD_WAIVER        基线里某条在当日全树面已不出现 ⇒ 红（死豁免不许永远绿，同 R247 双向差集口径）
  MALFORMED_WAIVER   基线条目缺 ghsa/package/reason/added/fix_due 任一字段 ⇒ 红（可追责性）
取数不可用（audit 跑不出来／JSON 解析不了／形状不认识／基线读不到）一律 **BLOCKED（rc=3）**，
既不记绿也不判红——「读不到」写成「没漏洞」正是本仓反复立规要治的形态。

退出码：0=PASS｜1=FAIL（具名逐条）｜2=参数非法｜3=BLOCKED（取数面坏）
用法：
  python scripts/dep_audit_gate.py                       # 自己跑两条面（全树＋--omit=dev）
  python scripts/dep_audit_gate.py --audit-json a.json --prod-audit-json p.json   # 喂已捕获的面（离线自证用）
  python scripts/dep_audit_gate.py --selftest            # 夹具自测，不碰网络
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import subprocess
import sys

SEV_RANK = {"low": 1, "moderate": 2, "high": 3, "critical": 4}
REQUIRED_WAIVER_FIELDS = ("ghsa", "package", "severity", "reason", "added", "fix_due")
PASS_MARK = "[GATE:depaudit-pass]"
FAIL_MARK = "[GATE:depaudit-fail]"
BLOCKED_MARK = "[GATE:depaudit-blocked]"
# 变异钩子（仅 --selftest 用，禁在正文路径改）：False 时 DEAD_WAIVER 那条腿失效
DEAD_WAIVER_GUARD = True


def parse_iso_day(s):
    """YYYY-MM-DD → date；解析不动返回 None（调用方按 BLOCKED/参数错处理，绝不当天算今天蒙过去）。"""
    try:
        return datetime.date.fromisoformat(str(s).strip())
    except (TypeError, ValueError):
        return None


def extract_advisories(face):
    """npm audit --json（auditReportVersion 2）→ [{ghsa, package, severity, range}]。

    返回 None ＝ 形状不认识（调用方必须按 BLOCKED 处理，**不许当成"零漏洞"**）。
    `via` 里的字符串条目是「经由另一包」的指针，其 advisory 本体在指到的包下已列 ⇒ 跳过，不重复计数。
    """
    if not isinstance(face, dict):
        return None
    vulns = face.get("vulnerabilities")
    if not isinstance(vulns, dict):
        return None
    out = []
    for pkg, info in vulns.items():
        via = info.get("via") if isinstance(info, dict) else None
        if not isinstance(via, list):
            continue
        for x in via:
            if not isinstance(x, dict):
                continue
            ghsa = str(x.get("url") or "").rstrip("/").split("/")[-1]
            if not ghsa.startswith("GHSA-"):
                continue
            out.append({
                "ghsa": ghsa,
                "package": str(x.get("name") or pkg),
                "severity": str(x.get("severity") or ""),
                "range": str(x.get("range") or ""),
            })
    return out


def key_of(adv):
    return (adv.get("ghsa"), adv.get("package"))


def verdict(*, full, prod, waivers, fail_on="high", today=None):
    """纯函数：两面读数＋基线 → 裁决。任一面为 None ⇒ BLOCKED（不判红不记绿）。"""
    info: list[str] = []
    if full is None or prod is None:
        missing = []
        if full is None:
            missing.append("全树面")
        if prod is None:
            missing.append("生产树面（--omit=dev）")
        return {"state": "BLOCKED", "errs": [f"取数面不可用：{'、'.join(missing)} 解析不出 advisory 名单"], "info": info}
    if today is None:
        return {"state": "BLOCKED", "errs": ["没给出可解析的日期（--now）⇒ 到期判断无从做起，不猜"], "info": info}
    errs = []
    rank = SEV_RANK.get(fail_on, 3)
    blocking = [a for a in full if SEV_RANK.get(a["severity"], 0) >= rank]
    prod_keys = {key_of(a) for a in prod}
    full_keys = {key_of(a) for a in full}
    base_keys = set()
    for i, w in enumerate(waivers or []):
        miss = [f for f in REQUIRED_WAIVER_FIELDS if not str((w or {}).get(f) or "").strip()]
        if miss:
            errs.append(f"MALFORMED_WAIVER 基线第 {i + 1} 条缺字段 {miss}（豁免必须可追责：凭什么＋何时到期）")
            continue
        base_keys.add((w["ghsa"], w["package"]))
    for a in blocking:
        k = key_of(a)
        if k not in base_keys:
            errs.append(f"UNBASELINED {a['severity']} {a['ghsa']} [{a['package']} {a['range']}] ⇒ 不在基线，须当场论证并入库（不许改判据凑绿）")
            continue
        if k in prod_keys:
            errs.append(f"DEV_CLAIM_REFUTED {a['ghsa']} [{a['package']}] ⇒ --omit=dev 的生产树面里也在场，「dev-only」这条豁免的前提已不成立")
        waiver_row: dict = next((x for x in (waivers or []) if key_of(x) == k), {})
        raw_due = waiver_row.get("fix_due")
        due = parse_iso_day(raw_due)
        if due is None:
            errs.append(f"MALFORMED_WAIVER {k[0]} 的 fix_due 不可解析（实测 {raw_due!r}）")
        elif today > due:
            errs.append(f"EXPIRED {k[0]} [{k[1]}] ⇒ 到期日 {due} 已过（今天 {today}），要么升版本要么重新论证，不许自动续期")
    if DEAD_WAIVER_GUARD:
        for k in sorted(base_keys - full_keys):
            errs.append(f"DEAD_WAIVER {k[0]} [{k[1]}] ⇒ 当日全树面里已不出现，豁免条目该随漏洞一起消失（死豁免不许永远绿）")
    info.append(f"全树 advisory {len(full)} 条｜生产树 advisory {len(prod)} 条｜≥{fail_on} 的阻断级 {len(blocking)} 条｜基线在册 {len(base_keys)} 条")
    return {"state": "FAIL" if errs else "PASS", "errs": errs, "info": info}


def run_npm_audit(frontend_dir, extra_args, npm_cmd="npm", registry=None):
    """跑一条面。返回 (dict|None, 诊断文本)——**rc≠0 不是失败**（有漏洞时 rc 本来就是 1），
    认的是「stdout 能不能解析成 JSON」。

    两处一手实测的形状（第一百零二轮）：
      ① Windows 下 subprocess 不走 shell，`npm` 解析不到（npm 实为 npm.cmd）⇒ `FileNotFoundError WinError 2`。
         这里按 PATHEXT 逐个试（npm → npm.cmd），并把**实际用的命令**印进诊断，不留"静默换命令"的暗道；
         Linux runner 上第一发就中，走不到回退。
      ② 本机 npm 全局把 registry 指到 registry.npmmirror.com，镜像不实现 audit 端点（实测 404 NOT_IMPLEMENTED）
         ⇒ 需要 `--registry` 显式覆盖，不靠改用户全局配置（那是共享状态）。
    """
    args = list(extra_args) + ([f"--registry={registry}"] if registry else [])
    tried = []
    for cmd in [npm_cmd] + (["npm.cmd", "npm.exe"] if os.name == "nt" else []):
        tried.append(cmd)
        try:
            p = subprocess.run([cmd, "audit", "--json"] + args, cwd=frontend_dir, capture_output=True,
                               text=True, encoding="utf-8", errors="replace", timeout=300)
        except (OSError, subprocess.SubprocessError):
            continue   # 换下一个 PATHEXT 形态再试；两个都不行才在下面如实报 BLOCKED
        txt = (p.stdout or "").strip()
        used = f"cmd={os.path.basename(cmd)}" + (f" registry={registry}" if registry else " registry=默认")
        if not txt:
            return None, f"{used} rc={p.returncode} 且 stdout 为空｜stderr: {(p.stderr or '')[:120]}"
        try:
            return json.loads(txt), f"{used} rc={p.returncode} bytes={len(txt)}"
        except ValueError as e:
            return None, f"{used} rc={p.returncode} 但 stdout 不是 JSON（{str(e)[:60]}）｜首行: {txt.splitlines()[0][:80]}"
    return None, f"npm 起不来（依次试过 {tried}；Win 下需 npm.cmd，Linux runner 上第一发即中）"


def load_baseline(path):
    """读基线件。返回 (waivers|None, state, 诊断)。读不到/解析不动 ⇒ None（调用方记 BLOCKED）。"""
    if not os.path.isfile(path):
        return None, "absent", f"基线文件不在场：{path}"
    try:
        with open(path, encoding="utf-8-sig") as f:
            doc = json.load(f)
    except ValueError as e:
        return None, "broken", f"基线 JSON 解析失败：{str(e)[:80]}"
    w = doc.get("waivers")
    if not isinstance(w, list):
        return None, "broken", f"基线缺 waivers 数组（实测顶层键 {sorted(doc.keys())[:8]}）"
    return w, "loaded", f"基线在册 {len(w)} 条（version={doc.get('version')}）"


def selftest():
    cases = []
    def push(name, ok, detail):
        cases.append((name, ok, detail))

    A1 = {"ghsa": "GHSA-aaaa-bbbb-cccc", "package": "undici", "severity": "high", "range": ">=1.0.0 <2.0.0"}
    A2 = {"ghsa": "GHSA-dddd-eeee-ffff", "package": "eslint", "severity": "high", "range": ">=9.0.0"}
    W_OK = {"ghsa": "GHSA-aaaa-bbbb-cccc", "package": "undici", "severity": "high", "range": ">=1.0.0 <2.0.0",
            "reason": "仅 dev 链", "added": "2026-10-06", "fix_due": "2026-11-02"}
    today = datetime.date(2026, 10, 6)

    v = verdict(full=[A1], prod=[], waivers=[W_OK], fail_on="high", today=today)
    push("正例-已批且 dev-only 且未到期 ⇒ PASS", v["state"] == "PASS", f'{v["state"]}｜{v["info"][0]}')
    v = verdict(full=[A2], prod=[], waivers=[W_OK], fail_on="high", today=today)
    push("反例-新增高危没进基线 ⇒ UNBASELINED", v["state"] == "FAIL" and any("UNBASELINED" in e for e in v["errs"]), str(v["errs"])[:100])
    v = verdict(full=[A1], prod=[A1], waivers=[W_OK], fail_on="high", today=today)
    push("反例-生产树里也在场 ⇒ DEV_CLAIM_REFUTED（dev-only 不能靠形容词）",
        v["state"] == "FAIL" and any("DEV_CLAIM_REFUTED" in e for e in v["errs"]), str(v["errs"])[:100])
    v = verdict(full=[A1], prod=[], waivers=[dict(W_OK, fix_due="2026-10-01")], fail_on="high", today=today)
    push("反例-过了 fix_due ⇒ EXPIRED", v["state"] == "FAIL" and any("EXPIRED" in e for e in v["errs"]), str(v["errs"])[:100])
    v = verdict(full=[], prod=[], waivers=[W_OK], fail_on="high", today=today)
    push("反例-漏洞已消失而豁免还留着 ⇒ DEAD_WAIVER", v["state"] == "FAIL" and any("DEAD_WAIVER" in e for e in v["errs"]), str(v["errs"])[:100])
    v = verdict(full=[A1], prod=[], waivers=[{k: W_OK[k] for k in ("ghsa", "package", "severity", "fix_due")}], fail_on="high", today=today)
    push("反例-基线条目缺 reason/added ⇒ MALFORMED_WAIVER", v["state"] == "FAIL" and any("MALFORMED_WAIVER" in e for e in v["errs"]), str(v["errs"])[:110])
    v = verdict(full=[A1], prod=[], waivers=[dict(W_OK, fix_due="以后再说")], fail_on="high", today=today)
    push("反例-fix_due 写成散文 ⇒ MALFORMED_WAIVER（不可解析不许当成没到期）",
        v["state"] == "FAIL" and any("fix_due 不可解析" in e for e in v["errs"]), str(v["errs"])[:110])
    v = verdict(full=[A1], prod=[], waivers=[], fail_on="high", today=today)
    push("反例-基线为空而面里有高危 ⇒ UNBASELINED，绝不静默绿", v["state"] == "FAIL" and any("UNBASELINED" in e for e in v["errs"]), str(v["errs"])[:90])
    v = verdict(full=None, prod=[], waivers=[W_OK], fail_on="high", today=today)
    push("取数坏-全树面 None ⇒ BLOCKED（不是 PASS 也不是 FAIL）", v["state"] == "BLOCKED", str(v["errs"])[:90])
    v = verdict(full=[], prod=None, waivers=[], fail_on="high", today=today)
    push("取数坏-生产树面 None ⇒ BLOCKED（缺这条就无从证 dev-only）", v["state"] == "BLOCKED" and any("生产树" in e for e in v["errs"]), str(v["errs"])[:90])
    v = verdict(full=[A1], prod=[], waivers=[W_OK], fail_on="high", today=None)
    push("取数坏-没有可解析日期 ⇒ BLOCKED（不拿今天蒙）", v["state"] == "BLOCKED", str(v["errs"])[:80])
    v = verdict(full=[{"ghsa": "GHSA-aaaa-bbbb-cccc", "package": "undici", "severity": "moderate", "range": "x"}],
                prod=[], waivers=[dict(W_OK, severity="moderate")], fail_on="high", today=today)
    push("门槛-modest 不达 high ⇒ 不列阻断（分母仍如实印）", v["state"] == "PASS" and "阻断级 0 条" in v["info"][0], v["info"][0])
    # 抽取器自己的形状腿：不认识的面必须回 None（"解析不出"≠"没有漏洞"）
    push("抽取-空 dict 面 ⇒ None", extract_advisories({}) is None, str(extract_advisories({})))
    push("抽取-非 dict ⇒ None", extract_advisories("boom") is None, "字符串面不得当成零漏洞")
    real = {"vulnerabilities": {"undici": {"via": [{"url": "https://github.com/advisories/GHSA-3wwx-pv8p-q78v",
             "name": "undici", "severity": "moderate", "range": ">=7.28.0 <7.29.1"}, "miniflare"]},
             "miniflare": {"via": ["undici"]}}}
    got = extract_advisories(real)
    push("抽取-真形状（auditReportVersion 2）⇒ 1 条且指针不重复计数",
        got is not None and len(got) == 1 and got[0]["ghsa"] == "GHSA-3wwx-pv8p-q78v", str(got)[:110])
    global DEAD_WAIVER_GUARD
    DEAD_WAIVER_GUARD = False
    mut = verdict(full=[], prod=[], waivers=[W_OK], fail_on="high", today=today)
    DEAD_WAIVER_GUARD = True
    push("变异体-撤掉 DEAD_WAIVER 判据后该反例不再红", mut["state"] == "PASS", f'{mut["state"]}｜{str(mut["errs"])[:60]}')
    push("变异体-钩子已复原", verdict(full=[], prod=[], waivers=[W_OK], fail_on="high", today=today)["state"] == "FAIL",
        "复原失败＝自检把判据永久关掉了")

    bad = 0
    for name, ok, detail in cases:
        print(f"[{'PASS' if ok else 'FAIL'}] {name} | {detail}")
        bad += 0 if ok else 1
    neg = sum(1 for n, _o, _d in cases if n.startswith(("反例", "取数坏", "变异体")))
    print(f"dep_audit_gate selftest: {len(cases) - bad}/{len(cases)}（反例与取数坏腿 {neg} 条，按名现算）")
    print(FAIL_MARK if bad else PASS_MARK)
    return 1 if bad else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dep_audit_gate.py", description="Dependency audit 的按批处置机器基线判据")
    ap.add_argument("--audit-json", help="已捕获的全树面 JSON 路径（不给就自己跑 npm audit）")
    ap.add_argument("--prod-audit-json", help="已捕获的生产树面（--omit=dev）JSON 路径")
    ap.add_argument("--baseline", help="基线件路径（默认 frontend/.npm-audit-baseline.json）")
    ap.add_argument("--frontend-dir", help="跑 npm audit 的目录（默认 <本脚本>/../frontend）")
    ap.add_argument("--fail-on", default="high", choices=sorted(SEV_RANK), help="阻断级门槛（默认 high）")
    ap.add_argument("--registry", help="覆盖 npm registry（本机 npmmirror 不实现 audit 端点，实测 404；CI 用默认值不填此项）")
    ap.add_argument("--now", help="到期判断用的日期 YYYY-MM-DD（默认系统当天；CI 上随跑动时刻）")
    ap.add_argument("--selftest", action="store_true", help="夹具自测，不碰网络与 npm")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    frontend = args.frontend_dir or os.path.join(repo, "frontend")
    baseline_path = args.baseline or os.path.join(frontend, ".npm-audit-baseline.json")

    waivers, bstate, bwhy = load_baseline(baseline_path)
    if waivers is None:
        print(f"{BLOCKED_MARK} 基线取不到（state={bstate}）⇒ {bwhy}。本判据不猜、不记绿：缺基线等于「没有一条豁免被论证过」")
        return 3

    def face(label, path, npm_extra):
        if path:
            if not os.path.isfile(path):
                return None, f"{label} 指定文件不在场：{path}"
            try:
                with open(path, encoding="utf-8-sig") as f:
                    return json.load(f), f"{label} 取自 {os.path.basename(path)}"
            except (OSError, ValueError) as e:
                return None, f"{label} 读不到/解析失败：{type(e).__name__} {str(e)[:70]}"
        doc, why = run_npm_audit(frontend, npm_extra, registry=args.registry)
        return doc, f"{label} 现跑 npm audit（{why}）"

    full_face, why_full = face("全树面", args.audit_json, [])
    prod_face, why_prod = face("生产树面", args.prod_audit_json, ["--omit=dev"])
    full = extract_advisories(full_face) if full_face is not None else None
    prod = extract_advisories(prod_face) if prod_face is not None else None
    print(why_full)
    print(why_prod)
    if full is None or prod is None:
        who = []
        if full is None:
            who.append("全树面")
        if prod is None:
            who.append("生产树面")
        print(f"{BLOCKED_MARK} {'、'.join(who)} 拿不到可解析的 advisory 名单 ⇒ 本维未验（不是「没有漏洞」）。"
              f"本机若走 npmmirror 镜像，请加 --registry=https://registry.npmjs.org（镜像不实现 audit 端点，实测 404 NOT_IMPLEMENTED）")
        return 3

    today = parse_iso_day(args.now) if args.now else datetime.date.today()
    if today is None:
        print(f"{BLOCKED_MARK} --now 不可解析（实测 {args.now!r}）⇒ 到期判断无从做起")
        return 2
    v = verdict(full=full, prod=prod, waivers=waivers, fail_on=args.fail_on, today=today)
    print(v["info"][0])
    for e in v["errs"]:
        print("  - " + e)
    if v["state"] == "FAIL":
        print(f"{FAIL_MARK} 逐条具名 {len(v['errs'])} 项｜基线={os.path.relpath(baseline_path, repo)}（处置＝升版本或重新论证并改基线，禁改判据凑绿；禁 --no-verify）")
        return 1
    print(f"{PASS_MARK} {v['info'][0]}｜today={today} fail_on={args.fail_on}｜基线在册条目全部由两面差集重证 dev-only，无一过期、无一死豁免")
    return 0


if __name__ == "__main__":
    sys.exit(main())
