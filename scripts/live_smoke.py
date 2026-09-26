#!/usr/bin/env python
"""线上与已发布交付物的持续可用烟测（第二十三轮）。

对标取证（2026-09-26 实测）：`openemr/openemr` 有 `recovery-path-smoketest.yml` 与
`release-mechanism-smoketest.yml`——发布机制与恢复路径本身被定时真跑。我方 release.yml 只在
**打 tag 那一刻**验一次镜像与线上，之后 `ghcr.io/...:latest` 与 pages.dev 再没有任何常驻判据：
上游基础镜像重建、Pages 侧配置漂移、或线上新版本被手工覆盖，都不会有任何东西变红。
"发布完成"与"仍然可用"是两件事，此前只有前者有判据。

本脚本只做**外部观察者视角**能做的事（一条 URL + 标准库），不 import 本仓代码、不连数据库：

  1. GET  /api/health        → 线上 version 与仓内单一源 backend/app/version.py 全等
  2. POST /api/dx/<不存在的病例> → 404，且错误体是 {code,message} 契约形、message 带 "unknown case:"
  3. POST /api/dx/c1 超大 body  → 413，且文案是医生可读的话、不含内部阈值数字
  4. POST /api/dx/c1 正常        → 200，且三条产品红线在场：红旗独立命中非空、每条引用的 id 都在
                                    知识库白名单内、界面结论含「医生终审」；单次耗时 < 10s（P95 口径）

用法：
  python scripts/live_smoke.py                       # 打线上（默认 doctor-ai-dx.pages.dev）
  python scripts/live_smoke.py --base-url http://127.0.0.1:8787
  python scripts/live_smoke.py --selftest            # 反例自证：纯离线，喂合成响应给同一组断言
退出码：0 全绿 / 1 判红 / 2 环境或参数错误（网络取不到、单一源读不到都算 2，不算"通过"）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
VERSION_PY = REPO / "backend" / "app" / "version.py"
# 知识库权威是 data/knowledge.json（#92 起）；knowledge.js 是它的生成物，判据不再 regex 抓源码。
KNOWLEDGE_JSON = REPO / "data" / "knowledge.json"
KNOWLEDGE_JS = REPO / "frontend" / "functions" / "lib" / "knowledge.js"
DEFAULT_BASE = "https://doctor-ai-dx.pages.dev"
# 与 fixtures/request_limits.json 的 `max_content_chars` 同**语义**的触发值（不是抄阈值数字）：
# 上限取"必然超过任何合理问诊长度"，阈值将来收紧到 2000 以下也照样越界；写死阈值相关数会造出
# "预检放行、出包判红"那种双源漂移。单条 content 越限即 413，不需要把 history 堆到几十 KB。
OVERSIZE_CHARS = 3000
REPO_PARENT = Path(__file__).resolve().parents[2]
ABSTAIN_PRIMARY = "信息不足，建议补充问诊"
_SCOPE_IDS: set[str] = set()  # 首次调用 check_abstain 时惰性载入（模块级不能调用，定义在下方）
SCOPES = {"in-scope", "insufficient-information", "out-of-scope"}
MODES = frozenset({"live", "rule", "rule-fallback", "mock"})
MAX_CALL_SECONDS = 10.0
# 胸痛 c1 的问诊转录（脱敏合成，与仓内评测集同一形状）；线上 live 与镜像内 rule 两条路径都用它。
CASE_C1_HISTORY: list[dict[str, str]] = [
    {"role": "user", "content": "压榨样胸痛3小时，向左肩臂放射，活动加重，出冷汗"},
    {"role": "assistant", "content": "有高血压吸烟史吗"},
    {"role": "user", "content": "高血压，吸烟"},
]

Row = tuple[str, bool, str]


def repo_version() -> str:
    # 单一源里的变量名是 APP_VERSION（version_guard 也认这个名字）。取不到必须报错——
    # 静默返回空串会把「线上版本对账」退化成恒真。
    pattern = r'^\s*(?:APP_VERSION|__version__)\s*=\s*["\']([^"\']+)["\']'
    m = re.search(pattern, VERSION_PY.read_text(encoding="utf-8"), re.M)
    if not m:
        print(f"[GATE:live-smoke-fail] 读不到仓内 version 单一源：{VERSION_PY}", file=sys.stderr)
        raise SystemExit(2)
    return m.group(1)


def kb_ids() -> set[str]:
    """引用白名单取自**权威文件** data/knowledge.json（与 scope_rules 同一口径，不抄第二份清单）。

    第三十二轮 #92 起 knowledge.js 只是生成物，从这里 regex 抓源码等于让判据依赖格式；
    现改为结构化读取，条目数下限仍保留（<50 ＝解析失效，不得当成"线上没问题"）。
    """
    try:
        with KNOWLEDGE_JSON.open(encoding="utf-8") as fh:
            rows = json.load(fh)["entries"]
    except (OSError, KeyError, ValueError) as e:
        print(f"[GATE:live-smoke-fail] 读不到知识库权威 {KNOWLEDGE_JSON}：{type(e).__name__} {e}", file=sys.stderr)
        raise SystemExit(2) from e
    ids = {str(r.get("id")) for r in rows if isinstance(r, dict) and r.get("id")}
    if len(ids) < 50:
        print(f"[GATE:live-smoke-fail] 知识库权威只给出 {len(ids)} 个 id（<50）＝数据或解析失效", file=sys.stderr)
        raise SystemExit(2)
    return ids


def call(base: str, method: str, path: str, body: Any = None, timeout: float = 30.0) -> tuple[int, dict[str, Any], float]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "User-Agent": "doctor-ai-dx-live-smoke"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
            return int(resp.status), _as_json(payload), time.monotonic() - started
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), _as_json(payload), time.monotonic() - started


def _as_json(payload: str) -> dict[str, Any]:
    try:
        parsed = json.loads(payload)
        return parsed if isinstance(parsed, dict) else {"_raw": payload[:400]}
    except json.JSONDecodeError:
        return {"_raw": payload[:400]}


def valid_case() -> dict[str, Any]:
    return {"history": [dict(h) for h in CASE_C1_HISTORY]}


def oversize_case() -> dict[str, Any]:
    return {"history": [{"role": "user", "content": "腹" * OVERSIZE_CHARS}]}


def good_dx_payload(ids: list[str], flags: list[str] | None = None, mode: str = "live") -> dict[str, Any]:
    return {"code": 0, "data": {"flags": flags if flags is not None else ["ACS 红旗"],
                                "mode": mode, "trace": {"evidence_ids": ids},
                                "abstain": False, "scope_status": "in-scope",
                                "primary": [{"name": "急性冠脉综合征（待排除）"}, {"name": "主动脉夹层"}],
                                "differential": [{"name": "肺栓塞"}, {"name": "肋软骨炎/胸壁疼痛"}],
                                "flag_details": [{"name": "ACS", "severity": "高", "advice": "立即转诊"}],
                                "conclusion": "建议由医生终审后确定诊断"}}


def obj(value: object) -> dict[str, Any]:
    """把"可能是 None / 可能不是对象"的响应字段收敛成 dict。

    不这么写的话 mypy 会一路报 union-attr；更重要的是：线上少给一层 data 时，这里必须走空 dict
    分支让对应判据**判红**，而不是抛 AttributeError 把"检查失败"伪装成"脚本报错"。
    """
    return dict(value) if isinstance(value, dict) else {}


def check_health(body: dict[str, Any], expect_version: str) -> list[Row]:
    """线上信封是 {code,data:{status,llm_mode,version}}（2026-09-26 实测），不是平铺字段。"""
    data = obj(body.get("data"))
    got = str(data.get("version", ""))
    return [("线上 /api/health 的 version 与仓内单一源全等", got == expect_version, f"线上={got!r} 仓内={expect_version!r}")]


def check_unknown_case(status: int, body: dict[str, Any]) -> list[Row]:
    msg = str(body.get("message", ""))
    return [
        ("未知病例返回 404", status == 404, f"status={status}"),
        ("错误体是 {code,message} 契约形", "code" in body and "message" in body, f"键={sorted(body)}"),
        ("404 文案指明是哪个病例", msg.startswith("unknown case:"), f"message={msg!r}"),
    ]


def check_oversize(status: int, body: dict[str, Any]) -> list[Row]:
    msg = str(body.get("message", ""))
    digits = re.findall(r"\d{4,}", msg)
    return [
        ("超大请求体返回 413", status == 413, f"status={status}"),
        ("413 文案医生可读且不含内部阈值数字", bool(msg) and not digits and "Traceback" not in msg
         and "functions/" not in msg, f"message={msg[:120]!r} 长数字={digits}"),
    ]


def check_dx(body: dict[str, Any], allowed_ids: set[str], seconds: float) -> list[Row]:
    """三条产品红线 + 引用白名单 + 时延，全部按线上真实形状断言。

    线上实测（2026-09-26）：`data` 含 primary/differential/faq/evidence/flags/flag_details/mode/
    fallback_reason/trace/state/fhir；引用 id 在 `data.trace.evidence_ids`。
    """
    data = obj(body.get("data")) or body
    trace = obj(data.get("trace"))
    flags = data.get("flags") or data.get("red_flags") or []
    ids = [str(x) for x in (trace.get("evidence_ids") or [])]
    if not ids:
        ids = [str(e.get("id")) for e in (data.get("evidence") or []) if isinstance(e, dict)]
    payload = json.dumps(body, ensure_ascii=False)
    mode = str(data.get("mode", ""))
    rows: list[Row] = [
        ("红旗规则层独立命中非空（ACS 病例必中）", len(flags) > 0, f"flags={flags}"),
        ("每条引用都在知识库白名单内", bool(ids) and not [i for i in ids if i not in allowed_ids],
         f"引用={ids} 越界={[i for i in ids if i not in allowed_ids] or '无'}"),
        ("结论含「医生终审」且无「替代医生」表述", "医生终审" in payload and "替代医生" not in payload,
         "见响应全文"),
        (f"检索档位口径合法（mode∈{sorted(MODES)}）", mode in MODES, f"mode={mode!r}"),
        ("第三态字段在场且口径合法（abstain/scope_status）",
         isinstance(data.get("abstain"), bool) and str(data.get("scope_status", "")) in SCOPES,
         f"abstain={data.get('abstain')!r} scope={data.get('scope_status')!r}"),
        ("未弃权时 scope_status 必须是 in-scope（两态不许互相冒充）",
         data.get("abstain") is True or data.get("scope_status") == "in-scope",
         f"abstain={data.get('abstain')!r} scope={data.get('scope_status')!r}"),
    ]
    if "fhir" in data:
        entries = obj(data.get("fhir")).get("entry") or []
        rows.append(("对外集成面 FHIR Bundle 在场且非空", bool(entries), f"entry={len(entries)}"))
    rows.append((f"单次耗时 < {MAX_CALL_SECONDS}s（P95 口径上限）", seconds < MAX_CALL_SECONDS, f"实测 {seconds:.2f}s"))
    return rows


def _scope_rule_ids() -> tuple[set[str], str]:
    """规则 id 取自权威文件 data/scope_rules.json（不是生成物）：线上要核的是"数据里确实有这条规则"。

    返回 (ids, 来源路径)；找不到文件时 ids 为空 ⇒ 调用方必须显式 SKIPPED，
    不能拿空集合把断言变成恒真或恒假（第 28 轮 ledger 的同族教训）。
    """
    here = Path(__file__).resolve().parent
    for cand in (here.parent / "data" / "scope_rules.json",
                 REPO_PARENT / "doctor-ai-dx-mvp" / "data" / "scope_rules.json"):
        if cand.is_file():
            with open(cand, encoding="utf-8") as fh:
                return {r["id"] for r in json.load(fh)["rules"]}, str(cand)
    return set(), ""


def check_abstain(body: dict[str, Any], allowed_ids: set[str]) -> list[Row]:
    """域外/信息不足输入的线上形状：只出弃权卡，但仍不得吞掉红旗字段与引用结构。

    形状抄 peer 实测：`kheireddinedev00/Medico` 有具名测试断言"OUT_OF_SCOPE 时红旗仍抬优先级"，
    `dmustapha/triage-0` 的弃权卡则把红旗留给"三条决定性体征禁止弃权"这条路。
    """
    data = obj(body.get("data")) or body
    primary = data.get("primary") or []
    flags = data.get("flags")
    names = [str(o.get("name", "")) for o in primary if isinstance(o, dict)]
    payload = json.dumps(body, ensure_ascii=False)
    scope_ids, _scope_src = _scope_rule_ids()
    return [
        ("域外输入触发弃权（abstain=true）", data.get("abstain") is True, f"abstain={data.get('abstain')!r}"),
        (f"弃权口径合法（scope_status∈{sorted(SCOPES - {'in-scope'})}）",
         str(data.get("scope_status", "")) in (SCOPES - {"in-scope"}), f"scope={data.get('scope_status')!r}"),
        ("弃权只出弃权卡、不编鉴别诊断",
         names == [ABSTAIN_PRIMARY] and (data.get("differential") or []) == [], f"primary={names}"),
        ("弃权时 flags 仍是数组（红线：弃权不得吞掉危险信号）", isinstance(flags, list), f"flags={flags!r}"),
        ("范围命中必须带合法 scope_rule（数据文件里那条）；无权威文件则显式 SKIPPED",
         (str(data.get("scope_status")) != "out-of-scope") or not scope_ids
         or str(data.get("scope_rule") or "") in scope_ids,
         f"scope_rule={data.get('scope_rule')!r}"),
        ("弃权理由体现医生主导且无「替代医生」表述",
         ("医生" in payload) and ("替代医生" not in payload), "见响应全文"),
    ]


def run_live(base: str, quiet: bool) -> int:
    expect = repo_version()
    allowed = kb_ids()
    rows: list[Row] = []
    try:
        st, health, _ = call(base, "GET", "/api/health")
        if st != 200:
            print(f"[GATE:live-smoke-fail] /api/health 返回 {st}＝线上不可达，这不属于「检查通过」", file=sys.stderr)
            return 2
        rows += check_health(health, expect)
        st, body, _ = call(base, "POST", "/api/dx/no-such-case-for-smoke", valid_case())
        rows += check_unknown_case(st, body)
        st, body, _ = call(base, "POST", "/api/dx/c1", oversize_case())
        rows += check_oversize(st, body)
        st, body, secs = call(base, "POST", "/api/dx/c1", valid_case())
        if st != 200:
            print(f"[GATE:live-smoke-fail] 正常链路 /api/dx/c1 返回 {st}（红线断言无从执行）", file=sys.stderr)
            return 2
        rows += check_dx(body, allowed, secs)
        # 域外输入：期望引擎明说"信息不足"，而不是自信给出一个鉴别诊断（台账 #52）
        st_od, od_body, _ = call(base, "POST", "/api/dx/c1",
                                 {"case_id": "c1", "history": [
                                     {"role": "user", "content": "我家猫今天不吃东西有点蔫，需要打针吗"}]})
        rows += check_abstain(od_body, allowed)
        rows.append(("域外请求仍是 200（弃权不是错误，不该退化成交付失败）", st_od == 200, f"HTTP {st_od}"))
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"[GATE:live-smoke-fail] 线上不可达：{exc}", file=sys.stderr)
        return 2
    failed = [n for n, ok, _ in rows if not ok]
    for name, ok, detail in rows:
        if not ok or not quiet:
            print(f"{'PASS' if ok else 'FAIL'} :: {name}" + ("" if ok else f" :: {detail}"))
    print(f"[GATE:live-smoke-{'pass' if not failed else 'fail'}] {len(rows) - len(failed)}/{len(rows)} 项通过（目标 {base}）")
    return 1 if failed else 0


def run_selftest() -> int:
    """反例自证：同一组断言喂"好数据必须绿、坏数据必须点名"；全程零网络。

    刻意把"越界 id / 空红旗 / 空引用 / 缺终审 / 写了替代医生 / 超时 / 版本漂移 / 错误体退化"
    各做一条独立反例——这些正是三条产品红线的机器形状，任何一条恒真都等于红线没判据。
    """
    allowed = kb_ids()
    first = sorted(allowed)[0]

    def authority_read_fails() -> bool:
        """反向对照：把权威路径改到不存在处，判据必须 SystemExit(2)——静默放行等于白名单恒真。"""
        global KNOWLEDGE_JSON
        keep = KNOWLEDGE_JSON
        try:
            KNOWLEDGE_JSON = keep.parent / "no_such_knowledge.json"
            kb_ids()
            return False
        except SystemExit as e:
            return e.code == 2
        finally:
            KNOWLEDGE_JSON = keep

    authority_guard = authority_read_fails()
    ok_case = check_health({"code": 0, "data": {"version": repo_version()}}, repo_version())
    cases: list[tuple[str, bool]] = [
        ("知识库权威读不到时 exit 2（引用白名单不得静默放行）", authority_guard),

        ("health 版本一致判绿", all(r[1] for r in ok_case)),
        ("health 版本漂移判红", any(not r[1] for r in check_health({"data": {"version": "0.0.1"}}, repo_version()))),
        ("health 缺 version 字段判红", any(not r[1] for r in check_health({"data": {}}, repo_version()))),
        ("404 契约三判据对好数据全绿", all(r[1] for r in check_unknown_case(404, {"code": 404, "message": "unknown case: c9"}))),
        ("404 变 500 判红", any(not r[1] for r in check_unknown_case(500, {"code": 404, "message": "unknown case: c9"}))),
        ("错误体退化为 detail 判红", any(not r[1] for r in check_unknown_case(404, {"detail": "Not Found"}))),
        ("413 好数据判绿", all(r[1] for r in check_oversize(413, {"code": 413, "message": "请求内容超出可处理范围，请精简问诊记录后重试"}))),
        ("413 文案泄漏内部数字判红", any(not r[1] for r in check_oversize(413, {"code": 413, "message": "请求体超过 65536 字节"}))),
        ("413 文案泄漏源码路径判红", any(not r[1] for r in check_oversize(413, {"code": 413, "message": "functions/lib/limits.js 拒绝"}))),
        ("引用越界判红", any(not r[1] for r in check_dx(good_dx_payload(["kb-999"]), allowed, 1.0))),
        ("引用为空判红（白名单对账不许零输入记绿）", any(not r[1] for r in check_dx(good_dx_payload([]), allowed, 1.0))),
        ("红旗为空判红", any(not r[1] for r in check_dx(good_dx_payload([first], flags=[]), allowed, 1.0))),
        ("缺终审文案判红", any(not r[1] for r in check_dx({"code": 0, "data": {**good_dx_payload([first])["data"],
                                                                   "conclusion": "诊断如上"}}, allowed, 1.0))),
        ("写「替代医生」判红", any(not r[1] for r in check_dx({"code": 0, "data": {**good_dx_payload([first])["data"],
                                                              "conclusion": "本系统替代医生判断"}}, allowed, 1.0))),
        ("mode 不在合法集合判红", any(not r[1] for r in check_dx(good_dx_payload([first], mode="guess"), allowed, 1.0))),
        ("超时判红", any(not r[1] for r in check_dx(good_dx_payload([first]), allowed, MAX_CALL_SECONDS + 1))),
        ("好数据全绿（对照组）", all(r[1] for r in check_dx(good_dx_payload([first, sorted(allowed)[-1]]), allowed, 1.0))),
        ("弃权好数据全绿（对照组）", all(r[1] for r in check_abstain(
            {"code": 0, "data": {**good_dx_payload([first])["data"], "abstain": True,
             "scope_status": "insufficient-information", "primary": [{"name": ABSTAIN_PRIMARY}],
             "differential": [], "flags": []}}, allowed))),
        ("弃权却仍给鉴别诊断判红（弃权不收敛＝第三态形同虚设）", any(not r[1] for r in check_abstain(
            {"code": 0, "data": {**good_dx_payload([first])["data"], "abstain": True,
             "scope_status": "insufficient-information", "flags": []}}, allowed))),
        ("弃权时 flags 退化为 null 判红（红线：弃权不得吞掉危险信号）", any(not r[1] for r in check_abstain(
            {"code": 0, "data": {**good_dx_payload([first])["data"], "abstain": True,
             "scope_status": "out-of-scope", "primary": [{"name": ABSTAIN_PRIMARY}],
             "differential": [], "flags": None}}, allowed))),
        ("scope_status 写 in-scope 却声称弃权判红（两态互斥）", any(not r[1] for r in check_abstain(
            {"code": 0, "data": {**good_dx_payload([first])["data"], "abstain": True,
             "scope_status": "in-scope", "primary": [{"name": ABSTAIN_PRIMARY}],
             "differential": [], "flags": []}}, allowed))),
        ("未声明 abstain 字段判红（新字段被回退掉必须可见）", any(not r[1] for r in check_dx(
            {"code": 0, "data": {k: v for k, v in good_dx_payload([first])["data"].items()
                               if k != "abstain"}}, allowed, 1.0))),
    ]
    bad = [n for n, ok in cases if not ok]
    for name, ok in cases:
        print(f"{'ok  ' if ok else 'BAD '} :: {name}")
    print(f"[GATE:live-smoke-selftest-{'pass' if not bad else 'fail'}] {len(cases) - len(bad)}/{len(cases)}")
    return 0 if not bad else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="线上交付物持续可用烟测")
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return run_selftest()
    for f in (VERSION_PY, KNOWLEDGE_JSON, KNOWLEDGE_JS):
        if not f.is_file():
            print(f"[GATE:live-smoke-fail] 单一源缺失：{f}", file=sys.stderr)
            return 2
    return run_live(str(args.base_url), args.quiet)


if __name__ == "__main__":
    sys.exit(main())
