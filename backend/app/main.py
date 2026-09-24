"""FastAPI 入口：应用组装 + CORS + 路由注册 + 请求标识与结构化日志。"""
import time

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

from .config import current_api_key, get_settings
from .observe import SLOW_MS, log_event, new_request_id, redact
from .routers import api

app = FastAPI(
    title="医 · AI 辅助诊断 API",
    version="0.2.0",
    description="基层 AI 辅助诊断 MVP 后端：问诊 / 危险信号规则层 / RAG 知识库引用 / 结构化结论。",
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings["cors_origins"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api.router)


@app.middleware("http")
async def request_identity(request: Request, call_next):
    """每请求一个编号：响应头 X-Request-Id 让前端故障编号与服务端日志可对账。"""
    request.state.request_id = new_request_id()
    request.state.started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    ms = int((time.perf_counter() - request.state.started) * 1000)
    if ms > SLOW_MS:
        log_event("warn", req=request.state.request_id, path=request.url.path, method=request.method, ms=ms)
    return response


@app.exception_handler(Exception)
async def unhandled_exception(request: Request, exc: Exception):
    """未预期异常：日志落归因最小集（无堆栈/路径/密钥），响应只给医生可理解文案。"""
    request_id = getattr(request.state, "request_id", None) or new_request_id()
    started = getattr(request.state, "started", None)
    log_event("error", req=request_id, path=request.url.path, method=request.method,
              ms=int((time.perf_counter() - started) * 1000) if started else None,
              kind=type(exc).__name__, msg=redact(exc, current_api_key()))
    return JSONResponse(
        status_code=500,
        content={"code": 500, "message": f"服务暂时不可用，请稍后重试（故障编号 {request_id}）"},
        headers={"X-Request-Id": request_id},
    )


@app.exception_handler(RequestValidationError)
async def invalid_request(request: Request, exc: RequestValidationError):
    """请求体校验失败：对齐 Functions 端 {code,message} 契约，不外泄字段路径数组。"""
    request_id = getattr(request.state, "request_id", None) or new_request_id()
    return JSONResponse(
        status_code=422,
        content={"code": 422, "message": f"请求参数不完整，请刷新后重试（故障编号 {request_id}）"},
        headers={"X-Request-Id": request_id},
    )


def _health_data():
    from .config import llm_available
    return {"status": "ok", "llm_mode": "live" if llm_available() else "mock-fallback"}


@app.get("/health")
def health():
    return _health_data()


@app.get("/api/health")
def api_health():
    return {"code": 0, "data": _health_data()}