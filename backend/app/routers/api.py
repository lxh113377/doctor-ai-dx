"""API 路由层。全部 stateless：问诊历史由前端随请求携带，后端不做会话存储。
契约与 Cloudflare Functions 版一致：dx/workup/report 接收完整 history，返回 mode/evidence_ids/fallback_reason。
"""
import os

from fastapi import APIRouter, Header, HTTPException

from .. import chat as chat_mod
from ..models import IntakeAskRequest
from ..services import engine

router = APIRouter(prefix="/api")


@router.get("/cases")
def list_cases():
    return {"code": 0, "data": engine.get_cases()}


@router.post("/intake/ask")
def intake_ask(req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.next_intake_question(req.case_id, req.history)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.post("/dx/{case_id}")
def post_dx(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_diagnosis(case_id, req.history)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.post("/workup/{case_id}")
def post_workup(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_workup(case_id, req.history, req.dx)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


@router.post("/report/{case_id}")
def post_report(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_report(case_id, req.history, req.dx)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e)) from None


# ---- 对话面（round90）：与 Cloudflare Functions 侧同契约，见 docs/openapi.json 的 /api/chat* ----
# 刻意不对称：持久化与后台列表是 **Pages-only**（D1 绑定只在 Cloudflare 侧），镜像面不复制一份存储，
# 否则就出现两个真值。对账矩阵里这两行显式标注 Pages-only，理由写进 docs/ARCHITECTURE.md。


@router.post("/chat")
def post_chat(payload: dict):
    try:
        return {"code": 0, "data": chat_mod.handle_chat(payload)}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None


@router.get("/chat/{conversation_id}")
def get_chat(conversation_id: str):
    return {
        "code": 0,
        "data": {
            "available": False,
            "reason": "镜像面不持久化（会话存储是 Cloudflare D1 的 Pages-only 能力）",
            "conversation_id": conversation_id,
        },
    }


@router.post("/chat/{conversation_id}/feedback")
def post_chat_feedback(conversation_id: str, payload: dict):
    score = payload.get("score")
    if not isinstance(score, int) or isinstance(score, bool) or not 1 <= score <= 5:
        raise HTTPException(status_code=422, detail="评分无效或存储不可用，请稍后重试") from None
    return {
        "code": 0,
        "data": {
            "conversation_id": conversation_id,
            "satisfaction": score,
            "persisted": False,
            "reason": "镜像面不持久化",
        },
    }


def _admin_guard(x_admin_token: str | None) -> None:
    ok, status, message = chat_mod.authorize_admin(os.environ.get("ADMIN_TOKEN"), x_admin_token)
    if not ok:
        raise HTTPException(status_code=status, detail=message) from None


@router.get("/admin/conversations")
def admin_conversations(x_admin_token: str | None = Header(default=None)):
    _admin_guard(x_admin_token)
    return {"code": 0, "data": {"available": False, "reason": "镜像面不持久化", "items": []}}


@router.get("/admin/handoffs")
def admin_handoffs(x_admin_token: str | None = Header(default=None)):
    _admin_guard(x_admin_token)
    return {"code": 0, "data": {"available": False, "reason": "镜像面不持久化", "items": []}}


@router.patch("/admin/handoffs/{handoff_id}")
def admin_handoff_patch(handoff_id: str, x_admin_token: str | None = Header(default=None)):
    """镜像面同形端点（S3）：鉴权三态与权威面一致；镜像面不持久化，如实声明 available:false。"""
    _admin_guard(x_admin_token)
    return {"code": 0, "data": {"available": False, "reason": "镜像面不持久化", "id": handoff_id}}


@router.get("/admin/stats")
def admin_stats(x_admin_token: str | None = Header(default=None)):
    _admin_guard(x_admin_token)
    return {"code": 0, "data": {"available": False, "reason": "镜像面不持久化"}}