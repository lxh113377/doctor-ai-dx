"""FastAPI 侧可观测性契约：X-Request-Id 对账、500 零泄漏、日志脱敏。镜像 frontend/tests/route_guard.mjs。"""
import io
import json
import re
import sys
from contextlib import redirect_stdout

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from app import main as main_module  # noqa: E402
from app import observe  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import api as api_router  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ID_RE = re.compile(r"^[0-9a-f]{4,12}$")
LEAK_RE = re.compile(r"(Traceback|file://|[A-Za-z]:\\|sk-[A-Za-z0-9]{8,}|abc123secretkey)")

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


client = TestClient(app, raise_server_exceptions=False)

print("== 正常链路 ==")
r = client.get("/api/cases")
rid = r.headers.get("x-request-id", "")
check("GET /api/cases 200", r.status_code == 200)
check("响应头带 X-Request-Id", bool(ID_RE.match(rid)), repr(rid))
rid2 = client.get("/api/health").headers.get("x-request-id", "")
check("相邻请求编号不重复", bool(ID_RE.match(rid2)) and rid2 != rid)

print("== 500 兜底与脱敏 ==")


def _boom(*args, **kwargs):
    raise RuntimeError("upstream rejected sk-abcdefghijklmnopqrstuvwxyz for abc123secretkey at run (C:\\Users\\x\\app\\engine.py:1)")


_original = api_router.engine.build_diagnosis
api_router.engine.build_diagnosis = _boom
_saved_key = __import__("os").environ.get("DEEPSEEK_API_KEY")
__import__("os").environ["DEEPSEEK_API_KEY"] = "abc123secretkey"  # 模拟密钥已在环境中，验证日志不会把它带出去
try:
    buf = io.StringIO()
    with redirect_stdout(buf):
        err = client.post("/api/dx/c1", json={"case_id": "c1", "history": []})
    err_id = err.headers.get("x-request-id", "")
    payload = err.json()
    lines = [ln for ln in buf.getvalue().splitlines() if ln.startswith("{")]
finally:
    api_router.engine.build_diagnosis = _original
    if _saved_key is None:
        __import__("os").environ.pop("DEEPSEEK_API_KEY", None)
    else:
        __import__("os").environ["DEEPSEEK_API_KEY"] = _saved_key

check("未预期异常返回 500", err.status_code == 500, f"实测 {err.status_code}")
check("500 文案含可对账故障编号", err_id in str(payload.get("message", "")) and bool(ID_RE.match(err_id)), json.dumps(payload, ensure_ascii=False))
check("500 响应体零泄漏", not LEAK_RE.search(json.dumps(payload, ensure_ascii=False)), json.dumps(payload, ensure_ascii=False)[:160])

log = next((json.loads(ln) for ln in lines if '"error"' in ln), None)
check("服务端落了一条 error 结构化日志且 req 对得上", bool(log) and log.get("req") == err_id, str(lines[:2]))
check("日志已脱敏（无密钥/内部路径）", bool(log) and not LEAK_RE.search(log.get("msg", "")), log.get("msg", "") if log else "")
check("日志不带堆栈字段", bool(log) and "stack" not in log and "traceback" not in log)

print("== 错误契约对称（FastAPI 默认 detail 数组不外泄）==")
# 第二十一轮改判：`/dx/{case_id}` 的病例 id 取自**路径**，镜像面此前还强制体里再带一个 case_id，
# 于是"只带路径 id"的合法请求在镜像面回 422、权威面回 200（tests/error_parity_guard.mjs 首跑抓到）。
# 现在这里断言 200，422 的用例换成真正的形状违规——两条都是契约，缺一条就退回旧差异。
ok_path_only = client.post("/api/dx/c1", json={"history": []})
check("只带路径 case_id 的合法请求 → 200（不再额外索要体字段）",
      ok_path_only.status_code == 200 and ok_path_only.json().get("code") == 0,
      f"实测 {ok_path_only.status_code}")
bad = client.post("/api/dx/c1", json={"history": "boom"})
bad_body = bad.json()
check("history 非数组 422 走 {code,message} 契约", bad.status_code == 422 and bad_body.get("code") == 422
      and "detail" not in bad_body and isinstance(bad_body.get("message"), str), json.dumps(bad_body, ensure_ascii=False)[:160])
check("422 也带 X-Request-Id", bool(ID_RE.match(bad.headers.get("x-request-id", ""))))
malformed = client.post("/api/dx/c1", content="{oops", headers={"content-type": "application/json"})
check("请求体不是合法 JSON → 400（与权威面 parseBoundedBody 同码，不再按 422 混报）",
      malformed.status_code == 400 and malformed.json().get("code") == 400,
      f"实测 {malformed.status_code} {json.dumps(malformed.json(), ensure_ascii=False)[:120]}")

print("== 路由级 404 契约（未知病例 / 未知路径）==")
# 第十四轮补：此前 api.py 只跑过 /cases 与 /health，四条业务路由的 404 分支与 200 主体从未执行。
FORGED = {"case_id": "nope", "history": []}
for route_name, path in [("intake/ask", "/api/intake/ask"), ("dx", "/api/dx/nope"),
                         ("workup", "/api/workup/nope"), ("report", "/api/report/nope")]:
    r = client.post(path, json=FORGED)
    body = r.json()
    check(f"{route_name} 未知病例 404 且为 {{code,message}}（与 Functions 同形，不吐 detail）",
          r.status_code == 404 and body.get("code") == 404 and "detail" not in body
          and isinstance(body.get("message"), str), json.dumps(body, ensure_ascii=False)[:140])
    check(f"{route_name} 404 响应带 X-Request-Id", bool(ID_RE.match(r.headers.get("x-request-id", ""))))
    check(f"{route_name} 404 不外泄内部路径/堆栈", not LEAK_RE.search(json.dumps(body, ensure_ascii=False)))

nf = client.get("/api/nope")
check("未知路径 404 同样走 {code,message} 契约且文案与 Functions 同形",
      nf.status_code == 404 and nf.json().get("code") == 404 and "detail" not in nf.json()
      and nf.json().get("message") == "not found: /api/nope", json.dumps(nf.json(), ensure_ascii=False)[:140])

print("== 路由级全链路 200（抽取→诊断→检查→报告）==")
HIST = [{"role": "user", "content": c} for c in
        ["压榨样/紧缩感", "向左肩臂放射", "活动/劳累时加重", "出冷汗", "高血压，吸烟"]]
ask = client.post("/api/intake/ask", json={"case_id": "c1", "history": []})
ask_body = ask.json()
check("intake/ask 200 且 code=0 且回追问文本",
      ask.status_code == 200 and ask_body.get("code") == 0 and isinstance((ask_body.get("data") or {}).get("question"), str),
      json.dumps(ask_body, ensure_ascii=False)[:140])
dx_res = client.post("/api/dx/c1", json={"case_id": "c1", "history": HIST})
dx_body = dx_res.json()
check("dx 200 且带证据与红旗字段", dx_res.status_code == 200 and dx_body.get("code") == 0
      and isinstance((dx_body.get("data") or {}).get("evidence"), list), json.dumps(dx_body, ensure_ascii=False)[:140])
workup_res = client.post("/api/workup/c1", json={"case_id": "c1", "history": HIST, "dx": dx_body.get("data")})
wb = workup_res.json().get("data") or {}
check("workup 200 且三组检查建议非空", workup_res.status_code == 200 and workup_res.json().get("code") == 0
      and all(wb.get(k) for k in ("essential", "suggested", "optional")),
      json.dumps(wb, ensure_ascii=False)[:140])
report_res = client.post("/api/report/c1", json={"case_id": "c1", "history": HIST, "dx": dx_body.get("data")})
rep = report_res.json().get("data") or {}
soap = rep.get("soap") or {}
check("report 200 且 SOAP 四段齐 + 执业医生终审口径免责",
      report_res.status_code == 200 and all(soap.get(k) for k in ("subjective", "objective", "assessment", "plan"))
      and "执业资质的医生" in str(rep.get("disclaimer", "")), json.dumps(rep, ensure_ascii=False)[:140])
for name, res in (("intake", ask), ("dx", dx_res), ("workup", workup_res), ("report", report_res)):
    check(f"{name} 响应带 X-Request-Id", bool(ID_RE.match(res.headers.get("x-request-id", ""))))

print("== 慢请求归因日志（SLOW_MS 分支，第十四轮补：该分支此前零执行）==")
_saved_slow = main_module.SLOW_MS
main_module.SLOW_MS = -1  # 强制判慢；真跑一次 8 秒超时无意义也不该进 CI
try:
    buf = io.StringIO()
    with redirect_stdout(buf):
        slow = client.get("/api/cases")
    logged = [json.loads(ln) for ln in buf.getvalue().splitlines() if ln.startswith("{")]
finally:
    main_module.SLOW_MS = _saved_slow
warn = next((entry for entry in logged if entry.get("lvl") == "warn"), None)
check("慢请求落一条 warn 且带 path/method/ms", bool(warn) and warn.get("path") == "/api/cases"
      and warn.get("method") == "GET" and isinstance(warn.get("ms"), int),
      json.dumps(warn, ensure_ascii=False)[:140] if warn else f"实测行={logged[:2]}")
check("warn 字段落在归因白名单内（不外泄请求体/堆栈键）",
      bool(warn) and set(warn) <= {"app", "lvl", "req", "path", "method", "ms", "mode", "kind", "msg"},
      str(sorted(warn or {})))
check("SLOW_MS 判后复原为生产值 8000", main_module.SLOW_MS == 8000, str(main_module.SLOW_MS))
check("被判慢的请求本身仍 200（慢不等于错）", slow.status_code == 200, str(slow.status_code))

print("== 脱敏函数 ==")
check("sk- 形态密钥被脱敏", "sk-" not in observe.redact("header: sk-abcdefghijklmnopqrstuvwxyz"))
check("密钥原文被脱敏", "[已脱敏]" in observe.redact("failed with abc123secretkey", "abc123secretkey"))
check("内部路径被替换", "[内部路径]" in observe.redact("at run (C:\\Users\\secret\\app\\engine.py:1:1)"))
check("超长信息被截断", len(observe.redact("x" * 900)) <= 300)

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
