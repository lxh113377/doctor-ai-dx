"""API 路由层。全部 stateless：问诊历史由前端随请求携带，后端不做会话存储。
契约与 Cloudflare Functions 版一致：dx/workup/report 接收完整 history，返回 mode/evidence_ids/fallback_reason。
"""
from fastapi import APIRouter, HTTPException

from ..services import engine
from ..models import IntakeAskRequest

router = APIRouter(prefix="/api")


@router.get("/cases")
def list_cases():
    return {"code": 0, "data": engine.get_cases()}


@router.post("/intake/ask")
def intake_ask(req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.next_intake_question(req.case_id, req.history)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/dx/{case_id}")
def post_dx(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_diagnosis(case_id, req.history)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/workup/{case_id}")
def post_workup(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_workup(case_id, req.history, req.dx)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/report/{case_id}")
def post_report(case_id: str, req: IntakeAskRequest):
    try:
        return {"code": 0, "data": engine.build_report(case_id, req.history, req.dx)}
    except engine.UnknownCase as e:
        raise HTTPException(status_code=404, detail=str(e))
