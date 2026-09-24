"""FastAPI 侧可观测性契约：X-Request-Id 对账、500 零泄漏、日志脱敏。镜像 frontend/tests/route_guard.mjs。"""
import io
import json
import re
import sys
from contextlib import redirect_stdout

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import observe  # noqa: E402
from app.main import app  # noqa: E402
from app.routers import api as api_router  # noqa: E402

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
bad = client.post("/api/dx/c1", json={"history": []})
bad_body = bad.json()
check("缺字段 422 走 {code,message} 契约", bad.status_code == 422 and bad_body.get("code") == 422
      and "detail" not in bad_body and isinstance(bad_body.get("message"), str), json.dumps(bad_body, ensure_ascii=False)[:160])
check("422 也带 X-Request-Id", bool(ID_RE.match(bad.headers.get("x-request-id", ""))))

print("== 脱敏函数 ==")
check("sk- 形态密钥被脱敏", "sk-" not in observe.redact("header: sk-abcdefghijklmnopqrstuvwxyz"))
check("密钥原文被脱敏", "[已脱敏]" in observe.redact("failed with abc123secretkey", "abc123secretkey"))
check("内部路径被替换", "[内部路径]" in observe.redact("at run (C:\\Users\\secret\\app\\engine.py:1:1)"))
check("超长信息被截断", len(observe.redact("x" * 900)) <= 300)

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
