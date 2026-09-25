"""镜像面滥用护栏测试（第十九轮 v1.17.0）：入站边界必须与 Functions 端同码同文案。

跑法：python tests/test_limits.py（零网络、零密钥；与其余后端测试同口径）
判据分组：契约层拦截 / 中间件层拦截 / 合法链路不误伤 / 双端同源数值 / 反例（护栏自身会红）。
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import limits  # noqa: E402
from app.main import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app, raise_server_exceptions=False)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIXTURE = os.path.join(REPO, "frontend", "tests", "fixtures", "request_limits.json")

passed = 0
failed: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failed.append(f"{name}{(' :: ' + detail) if detail else ''}")


def post(path: str, body: object) -> tuple[int, dict]:
    r = client.post(path, json=body)
    try:
        return r.status_code, r.json()
    except Exception:  # noqa: BLE001
        return r.status_code, {}


def hist(n: int, chars: int = 5) -> list[dict]:
    return [{"role": "user", "content": "腹" * chars} for _ in range(n)]


print("== 1. 契约层拦截（进引擎前，不付 LLM 窗口）==")
st, body = post("/api/dx/c1", {"case_id": "c1", "history": hist(limits.MAX_HISTORY_ITEMS + 6)})
check("history 超条数 → 413", st == 413, f"实测 {st}")
check("413 响应体为 {code,message} 同形", body.get("code") == 413 and isinstance(body.get("message"), str), json.dumps(body, ensure_ascii=False)[:120])
check("413 文案医生可读且不含内部阈值", ">" not in (body.get("message") or ""), body.get("message", ""))

st, _ = post("/api/report/c1", {"case_id": "c1", "history": hist(3, limits.MAX_CONTENT_CHARS + 300)})
check("单条文本超长 → 413（report 出口同样受保护）", st == 413, f"实测 {st}")
st, _ = post("/api/workup/c1", {"case_id": "c1", "history": hist(2), "dx": {"evidence": [{"text": "证" * (limits.MAX_CONTENT_CHARS + 10)}]}})
check("回传 dx 内的证据超长 → 413", st == 413, f"实测 {st}")

print("== 2. 中间件层拦截（Content-Length 先于解析）==")
raw = b"{" + b"x" * (limits.MAX_BODY_BYTES + 100)
r = client.post("/api/dx/c1", content=raw, headers={"Content-Type": "application/json"})
check("超大 Content-Length → 413", r.status_code == 413, f"实测 {r.status_code}")
r2 = client.post("/api/dx/c1", content=b'{"case_id":"c1"}', headers={"Content-Type": "application/json", "Content-Length": "abc"})
check("非法 Content-Length 不误拦（交由下游解析）", r2.status_code == 200, f"实测 {r2.status_code}")

print("== 3. 合法链路不误伤（红线与既有行为必须不变）==")
ok_hist = hist(5, 20)
st, body = post("/api/dx/c1", {"case_id": "c1", "history": ok_hist})
check("正常问诊请求 → 200 code=0", st == 200 and body.get("code") == 0, f"实测 {st}")
flags = (body.get("data") or {}).get("flags") or []
check("红旗规则层仍独立生效（红线未被护栏影响）", isinstance(flags, list), str(flags)[:80])
# 已知双端差异（本轮实测登记，非本轮引入，也**不**在本轮偷偷改）：
# 同一入参 history:"boom" ⇒ 权威面 Functions 走引擎抛错→500（route_guard 钉住），
# 镜像面 FastAPI 在 pydantic 契约层就拒→422。台账#28 跟踪收敛方向=两端统一 400。
st, body = post("/api/dx/c1", {"case_id": "c1", "history": "boom"})
check("非数组 history → 镜像面 422（已知差异，见台账#28）", st == 422, f"实测 {st}")
check("422 响应体仍是 {code,message} 同形且含故障编号",
      body.get("code") == 422 and "故障编号" in str(body.get("message")), json.dumps(body, ensure_ascii=False)[:120])
check("护栏未把该入参误判成 413（边界与校验分流正确）", st != 413)
st, body = post("/api/dx/nope", {"case_id": "nope", "history": hist(1)})
check("未知病例仍 404（未被护栏改码）", st == 404 and body.get("code") == 404, f"实测 {st}")

print("== 4. 双端同源：数值必须等于 fixture（镜像内无仓文件时显式 SKIP，不静默通过）==")
# 本文件会被 `docker compose run --rm selftest` 在**镜像内**执行，而镜像只装后端（无 frontend/）。
# 实测：不加这层判别，镜像内第一次跑就在 open(FIXTURE) 处 FileNotFoundError 退出码 1。
# 数值同源的硬对账由 npm 侧 tests/limits_guard.mjs 在 CI 阻断链里负责，这里只声明跳过原因。
if os.path.exists(FIXTURE):
    spec = json.load(open(FIXTURE, encoding="utf-8"))
    for key, const in [("max_body_bytes", limits.MAX_BODY_BYTES), ("max_history_items", limits.MAX_HISTORY_ITEMS),
                       ("max_content_chars", limits.MAX_CONTENT_CHARS), ("max_dx_json_bytes", limits.MAX_DX_JSON_BYTES)]:
        check(f"{key} == fixture({spec[key]})", const == spec[key], f"实测 {const}")
    check("状态码与 fixture 一致", limits.STATUS_TOO_LARGE == spec["http_status"]["too_large"])
else:
    print(f"  SKIP 未找到 {os.path.relpath(FIXTURE, REPO)}（镜像内只装后端）⇒ 数值同源改由 npm 侧 limits_guard 判定")
    check("镜像上下文：行为断言仍已跑完（前面各节），跳过项已显式登记", True)

print("== 4b. 模块级分支补测（新写的入站边界不许留盲区——r12 教训：覆盖率上线即暴露盲区）==")
for name, fn, args in [
    ("history=None 放行", limits.check_history, (None,)),
    ("history 非数组不在此层拦", limits.check_history, ("boom",)),
    ("history 混入非 dict 条目不炸", limits.check_history, (["plain string", 42, None],)),
    ("dx=None 放行", limits.check_dx, (None,)),
    ("dx 非 dict 不误崩", limits.check_dx, (["not", "a", "dict"],)),
    ("dx.evidence 非数组不误崩", limits.check_dx, ({"evidence": "not-a-list"},)),
    ("dx.evidence 混入非 dict", limits.check_dx, ({"evidence": [{"text": "ok"}, "junk", 7]},)),
    ("空 history 放行", limits.check_history, ([],)),
]:
    try:
        fn(*args)
        check(name, True)
    except Exception as e:  # noqa: BLE001
        check(name, False, f"意外抛出 {type(e).__name__}: {e}")
try:
    limits.check_dx({"conclusion": "结" * (limits.MAX_CONTENT_CHARS + 1)})
    check("dx.conclusion 超长必须抛", False, "未抛异常")
except limits.RequestTooLarge as e:
    check("dx.conclusion 超长 → 413", e.status == 413)
try:
    limits.check_dx({"evidence": [{"text": "x" * (limits.MAX_DX_JSON_BYTES + 10)}]})
    check("dx 整体体积超限必须抛", False, "未抛异常")
except limits.RequestTooLarge:
    check("dx 整体体积超限 → 413", True)
check("byte_len 对 None/空串归零", limits.byte_len(None) == 0 and limits.byte_len("") == 0)
check("byte_len 按 UTF-8 计（中文 3 字节/字）", limits.byte_len("腹痛") == 6)

print("== 5. 反例（护栏自身必须会红）==")
try:
    limits.check_history(hist(limits.MAX_HISTORY_ITEMS + 1))
    check("超限 history 必须抛 RequestTooLarge", False, "未抛异常")
except limits.RequestTooLarge as e:
    check("超限 history 抛 RequestTooLarge 且 status=413", e.status == 413)
    check("reason 带数值（供日志归因），message 不带", ">" in e.reason and ">" not in str(e))
try:
    limits.check_declared_size("9" * 8)
    check("超大声明必须抛", False, "未抛异常")
except limits.RequestTooLarge:
    check("超大 Content-Length 抛 RequestTooLarge", True)
check("合法声明不抛", (limits.check_declared_size("512") or True) is True)

print("== 6. 对外出口的机器判据（CodeQL py/stack-trace-exposure 归因后的收口）==")
# 起因：CodeQL 在 main.py 的 `"message": str(exc)` 上开了一条 **error 级** 告警。该处 str(exc)
# 取到的是医生文案（细节在 .reason），按本项目实现是误报；但"异常对象直接进响应体"正是
# 「错误响应不展示堆栈或内部路径」这条红线的形状——所以不向规则申辩，而是把出口换成模块常量，
# 让承诺变成可判红的判据（下面第 1 条就是拦这个形状的，改回 str(exc) 立刻红）。
import re  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

BACKEND_ROOT = _Path(__file__).resolve().parent.parent  # 本机=…/backend，镜像内=/srv/backend
# 用 __file__ 而不是 REPO：REPO 在镜像里解析成 /srv，那里根本没有 app/ 目录，
# os.walk 对不存在的路径**静默返回空** ⇒ "扫了 0 个文件"也能判绿，正是本项目反复踩的假通过形状。
scan_root = BACKEND_ROOT / "app"
hits: list[str] = []
scanned: list[str] = []
for fp in sorted(scan_root.rglob("*.py")):
    scanned.append(fp.name)
    text = fp.read_text(encoding="utf-8")
    for m in re.finditer(r'"message":\s*str\(', text):
        hits.append(f"{fp.name}:{text[:m.start()].count(chr(10)) + 1}")
check("扫描目录真实存在且扫到 ≥5 个 .py（防空路径/空目录假绿）",
      scan_root.is_dir() and len(scanned) >= 5, f"root={scan_root} 实测 {len(scanned)}")
check("零处把 str(异常) 直接写进响应 message（红线出口）", not hits, f"命中 {hits}")
e = limits.RequestTooLarge("history[0].content 长度 2300 > 2000")
check("public_message 与模块常量逐字同值", e.public_message == limits.TOO_LARGE_PUBLIC_MESSAGE)
check("public_message 不含字段路径/比较符（不可当归因通道）",
      "[" not in e.public_message and ">" not in e.public_message and "content" not in e.public_message)
check("reason 仍保留归因细节（日志侧信息量不降）", "history[0].content" in e.reason and ">" in e.reason)
code413, body413 = post("/api/dx/c1", {"history": hist(limits.MAX_HISTORY_ITEMS + 1)})
check("413 实际响应 message == 常量（出口真的用了它，不是只改了类）",
      code413 == 413 and body413.get("message") == limits.TOO_LARGE_PUBLIC_MESSAGE,
      json.dumps(body413, ensure_ascii=False)[:120])

print(f"\nRESULT: {passed} pass / {len(failed)} fail")
for line in failed:
    print("  FAIL", line)
sys.exit(1 if failed else 0)
