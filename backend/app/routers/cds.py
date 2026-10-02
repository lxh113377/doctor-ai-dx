"""CDS Hooks 2.0 端点（镜像面）：GET /cds-services · POST /cds-services/{service}。

与权威面 `frontend/functions/cds-services/index.js` + `[service].js` 逐字段同形：
成功响应是规范要求的**裸对象**（{services:[...]} / {cards:[...]}，不套本仓自研的 {code,data} 信封），
错误响应仍走仓内既有 {code,message} 契约（由 main.py 的处理器统一拼装，含 404 的 `not found: <path>` 文案）。
状态码口径与 /api 面同源：400＝JSON 解析不了、413＝超字节上界、422＝结构不合、404＝未知路径**或方法**。

方法用 api_route 显式接六种再自己分流，而不是让 FastAPI 的默认 405 冒出来：
第八十五轮双端对账实测——同一台机同一分钟，POST /cds-services 在权威面是 404、在镜像面是 FastAPI
自动给的 405。本仓既有契约是"路径/方法不在名册里就是 404"（route_guard 钉着 /api 面这条），
而 405 会成为 docs/ERRORS.md ⇄ openapi 双向对账里的第四个新码。差异要么修掉、要么记账，
不能靠"两边各自都对"糊过去。
"""
import json
from typing import Any, NoReturn

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import limits
from ..observe import log_event, new_request_id
from ..services import cds_hooks

router = APIRouter()

_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"]


def _not_found() -> NoReturn:
    # detail 留默认 "Not Found"，由 main.http_error 拼成 `not found: <path>`——与权威面同一句话
    raise StarletteHTTPException(status_code=404)


@router.api_route("/cds-services", methods=_METHODS)
def cds_discovery(request: Request) -> JSONResponse:
    if request.method != "GET":
        _not_found()
    return JSONResponse(status_code=200, content=cds_hooks.discovery_document())


async def _parse_bounded_body(request: Request) -> dict[str, Any]:
    """镜像 functions/lib/limits.js 的 parseBoundedBody：空体→{}，坏 JSON/非对象→400，超字节→413。"""
    raw = await request.body()
    if len(raw) > limits.MAX_BODY_BYTES:
        raise limits.RequestTooLarge(f"body {len(raw)} > {limits.MAX_BODY_BYTES}")
    if not raw:
        return {}
    try:
        parsed: Any = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise StarletteHTTPException(
            status_code=limits.STATUS_BAD_JSON, detail=limits.BAD_JSON_PUBLIC_MESSAGE
        ) from None
    if not isinstance(parsed, dict):
        raise StarletteHTTPException(
            status_code=limits.STATUS_BAD_JSON, detail=limits.BAD_JSON_PUBLIC_MESSAGE
        )
    return parsed


@router.api_route("/cds-services/{service_id}", methods=_METHODS)
async def cds_invoke(service_id: str, request: Request) -> JSONResponse:
    if request.method != "POST":
        _not_found()
    body = await _parse_bounded_body(request)
    try:
        result = cds_hooks.invoke_service(service_id, body)
    except cds_hooks.CdsServiceNotFound:
        _not_found()
    except cds_hooks.CdsInputError as exc:
        rid = getattr(request.state, "request_id", None) or new_request_id()
        # reason 只进日志不进响应体（对外只出医生可理解文案＋故障编号），与权威面 RequestBadShape 同口径
        log_event("warn", req=rid, path=request.url.path, method=request.method, kind=type(exc).__name__, msg=exc.reason)
        raise StarletteHTTPException(
            status_code=limits.STATUS_BAD_SHAPE,
            detail=f"{limits.BAD_SHAPE_PUBLIC_MESSAGE}（故障编号 {rid}）",
        ) from exc
    return JSONResponse(status_code=200, content=result)
