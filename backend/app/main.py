"""FastAPI 入口：应用组装 + CORS + 路由注册 + 请求标识与结构化日志。"""
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import limits
from .config import current_api_key, get_settings
from .limits import RequestTooLarge
from .observe import SLOW_MS, log_event, new_request_id, redact
from .routers import api
from .version import APP_VERSION

app = FastAPI(
    title="医 · AI 辅助诊断 API",
    version=APP_VERSION,
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
    # 入站边界第一道：Content-Length 超限直接 413，不进解析（镜像 Functions 侧 assertDeclaredSize）
    declared = request.headers.get("content-length")
    if declared:
        # 单一实现放 limits.check_declared_size（含"非法值不误拦"的口径），中间件只负责翻译响应体。
        # 此前这里自己手写 int() 比较，limits 里那份同名函数沦为死代码＝两套实现漂移的开端。
        try:
            limits.check_declared_size(declared)
        except RequestTooLarge as exc:
            return JSONResponse(status_code=exc.status,
                                content={"code": exc.status, "message": str(exc)},
                                headers={"X-Request-Id": request.state.request_id})
    response = await call_next(request)
    response.headers["X-Request-Id"] = request.state.request_id
    ms = int((time.perf_counter() - request.state.started) * 1000)
    if ms > SLOW_MS:
        log_event("warn", req=request.state.request_id, path=request.url.path, method=request.method, ms=ms)
    return response


@app.exception_handler(RequestTooLarge)
async def too_large(request: Request, exc: RequestTooLarge):
    """入站边界拒绝：客户端错误不得伪装成 500，也不得记成 error 级日志
    （滥用流量会把错误日志刷成噪声、掩盖真故障）。与 Functions 侧 413/400 同形同码。"""
    request_id = getattr(request.state, "request_id", None) or new_request_id()
    started = getattr(request.state, "started", None)
    log_event("warn", req=request_id, path=request.url.path, method=request.method,
              ms=int((time.perf_counter() - started) * 1000) if started else None,
              kind=type(exc).__name__, msg=exc.reason)
    return JSONResponse(
        status_code=exc.status,
        content={"code": exc.status, "message": exc.public_message},
        headers={"X-Request-Id": request_id},
    )


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


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    """业务级 HTTP 错误（未知病例 404 / 未匹配路径 404）：对齐 Functions 端 {code,message} 契约。
    此前 FastAPI 默认吐 {"detail": ...}，与线上权威面（Functions）不同形 —— 双端契约对账
    只覆盖引擎输出与 OpenAPI，路由错误体形态无判据，故第十四轮补此处理器并由 test_api_observe 钉住。
    注：必须注册在 Starlette 基类上，FastAPI 的 HTTPException 是其子类；只注册子类会漏掉
    路由未匹配时 Starlette 自己抛的 404（实测 {"detail":"Not Found"} 仍外泄）。"""
    request_id = getattr(request.state, "request_id", None) or new_request_id()
    headers = dict(exc.headers or {})
    headers["X-Request-Id"] = request_id
    detail = str(exc.detail)
    if exc.status_code == 404 and detail == "Not Found":
        detail = f"not found: {request.url.path}"  # 与 Functions 侧 fail(404, `not found: ${path}`) 同文案
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "message": redact(detail, current_api_key())},
        headers=headers,
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
    return {"status": "ok", "llm_mode": "live" if llm_available() else "mock-fallback", "version": APP_VERSION}


@app.get("/health")
def health():
    return _health_data()


@app.get("/api/health")
def api_health():
    return {"code": 0, "data": _health_data()}