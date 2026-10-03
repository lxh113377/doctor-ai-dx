"""FastAPI 侧可观测性契约：X-Request-Id 对账、500 零泄漏、日志脱敏。镜像 frontend/tests/route_guard.mjs。"""
import io
import json
import os
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

print("== 4xx 可观测性双端对称（台账 #42，第三十八轮补）==")
# 权威面（Functions console）一直给 4xx 落 warn，镜像面这条处理器此前**一行都不打** ⇒
# "对外行为两侧一致"掩盖了"运维可见性两侧不一致"（从镜像侧看不出 404 风暴）。
# 本块钉三件事：有 warn、级别不是 error、字段仍在归因白名单内（新键 status 已登记）。
buf4 = io.StringIO()
with redirect_stdout(buf4):
    r404_case = client.post("/api/dx/nope", json=FORGED)
    r404_path = client.get("/api/nope")
rows4 = [json.loads(ln) for ln in buf4.getvalue().splitlines() if ln.startswith("{")]
w4 = [e for e in rows4 if e.get("lvl") == "warn" and e.get("status") == 404]
check("两次 404 各落一条 warn（镜像面与权威面可观测性对称；读空即红）",
      len(w4) == 2 and r404_case.status_code == 404 and r404_path.status_code == 404,
      f"warn(404) 条数={len(w4)} 实得状态={r404_case.status_code}/{r404_path.status_code} "
      f"捕获行={[(e.get('lvl'), e.get('status')) for e in rows4][:4]}")
check("warn 行带归因最小集（path/method/req 齐，msg 是医生可读文案）",
      all(e.get("path") and e.get("method") and e.get("req") and isinstance(e.get("msg"), str) for e in w4),
      json.dumps(w4[:1], ensure_ascii=False)[:160])
check("4xx 绝不落 error 级（客户端错误不得挤占真故障信号）",
      not [e for e in rows4 if e.get("lvl") == "error"], str([e.get("lvl") for e in rows4][:6]))
check("warn 字段仍落在白名单内（本条新增的 status 已登记，不是随手加键）",
      all(set(e) <= {"app", "lvl", "req", "path", "method", "ms", "kind", "msg", "status"} for e in w4),
      str(sorted(w4[0])) if w4 else "无 warn 行可比")

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

print("== 对话面镜像端点契约（S 系列把 api.py 打到 66%，本段把覆盖补回地板而不是放宽地板） ==")
chat_hit = client.post("/api/chat", json={"text": "压榨样胸痛向左肩臂放射，伴出冷汗"})
check("POST /api/chat 红旗句仍走红线出口（intent=red_flag）",
      chat_hit.status_code == 200 and chat_hit.json()["data"]["intent"] == "red_flag",
      f"{chat_hit.status_code} {str(chat_hit.json())[:120]}")
chat_empty = client.post("/api/chat", json={})
check("POST /api/chat 空载荷的 ValueError 落 422 而不是 500", chat_empty.status_code == 422,
      str(chat_empty.status_code))
chat_read = client.get("/api/chat/cv-1")
read_data = chat_read.json()["data"]
check("GET /api/chat/{id} 如实声明镜像面不持久化（available=false＋回显 id）",
      chat_read.status_code == 200 and read_data["available"] is False
      and read_data["conversation_id"] == "cv-1", str(read_data)[:160])
fb_ok = client.post("/api/chat/cv-1/feedback", json={"score": 4})
fb_data = fb_ok.json()["data"]
check("POST feedback 合法评分落 200 且 persisted=false",
      fb_ok.status_code == 200 and fb_data["satisfaction"] == 4 and fb_data["persisted"] is False,
      str(fb_data)[:160])
for fb_payload, fb_case in (({"score": "4"}, "字符串"), ({"score": True}, "布尔冒充整数"),
                            ({"score": 0}, "下界外"), ({"score": 6}, "上界外"), ({}, "缺字段")):
    fb_bad = client.post("/api/chat/cv-1/feedback", json=fb_payload)
    check(f"POST feedback {fb_case}评分 → 422", fb_bad.status_code == 422,
          f"{fb_payload} 实得 {fb_bad.status_code}")

print("== 后台鉴权四态（未配置/缺令牌/错令牌/正确令牌） ==")
for guard_path in ("/api/admin/conversations", "/api/admin/handoffs", "/api/admin/stats"):
    unconfigured = client.get(guard_path)
    check(f"{guard_path} 未配置 ADMIN_TOKEN → 503（既不是 401 也不是放行 200）",
          unconfigured.status_code == 503, str(unconfigured.status_code))
prev_admin_token = os.environ.get("ADMIN_TOKEN")
os.environ["ADMIN_TOKEN"] = "r97-guard-token"
try:
    no_header = client.get("/api/admin/handoffs")
    wrong_header = client.patch("/api/admin/handoffs/h-1", headers={"X-Admin-Token": "not-it"})
    check("配置令牌后不带 X-Admin-Token → 401", no_header.status_code == 401, str(no_header.status_code))
    check("带错令牌 PATCH → 403（与 401 分档，医生能知道是哪种失败）", wrong_header.status_code == 403,
          str(wrong_header.status_code))
    good = {"X-Admin-Token": "r97-guard-token"}
    adm_conv = client.get("/api/admin/conversations", headers=good)
    adm_hand = client.get("/api/admin/handoffs", headers=good)
    adm_patch = client.patch("/api/admin/handoffs/h-9", headers=good)
    adm_stats = client.get("/api/admin/stats", headers=good)
    check("四个后台镜像端点带正确令牌均 200 且 available=false（镜像面不复制存储＝两个真值的防线）",
          all(x.status_code == 200 and x.json()["data"]["available"] is False
              for x in (adm_conv, adm_hand, adm_patch, adm_stats)),
          str([x.status_code for x in (adm_conv, adm_hand, adm_patch, adm_stats)]))
    check("PATCH /admin/handoffs/{id} 回显 handoff_id（S3 与权威面同形契约）",
          adm_patch.json()["data"]["id"] == "h-9", str(adm_patch.json())[:120])
finally:
    if prev_admin_token is None:
        os.environ.pop("ADMIN_TOKEN", None)
    else:
        os.environ["ADMIN_TOKEN"] = prev_admin_token
check("ADMIN_TOKEN 判后复原为进入前的值（测试不得把令牌留在环境里）",
      os.environ.get("ADMIN_TOKEN") == prev_admin_token, str(os.environ.get("ADMIN_TOKEN")))

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
