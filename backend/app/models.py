"""Pydantic 数据契约（= 前后端接口契约 + api.js 存根已按此 shape）"""
from pydantic import BaseModel


class Vital(BaseModel):
    key: str
    value: str


class CaseSummary(BaseModel):
    id: str
    name: str
    age: int
    gender: str
    occupation: str
    chief: str
    scene: str
    vitals: list[Vital]


class IntakeAskRequest(BaseModel):
    case_id: str
    answer: str = ""
    history: list[dict] = []   # [{role: "user"|"assistant", content: ...}] 由前端随请求携带（stateless）


class IntakeAskResp(BaseModel):
    reply: str
    question: str = ""
    source: str = "intake-question"
    chips: list[str] = []
    done: bool = False
    mode: str = "rule"


class DxItem(BaseModel):
    name: str
    prob: str
    strength: str  # high | mid | low
    reasons: list[str]
    evidence_ids: list[str] = []
    refs: list[str] = []


class DiffItem(BaseModel):
    name: str
    note: str
    evidence_ids: list[str] = []


class FaqItem(BaseModel):
    q: str
    a: str


class EvidenceItem(BaseModel):
    id: str
    title: str
    source: str
    year: str = ""
    url: str = ""
    scope: str = ""
    section: str = ""
    text: str
    score: float = 0


class DxResult(BaseModel):
    flags: list[str]
    primary: list[DxItem]
    differential: list[DiffItem]
    faq: list[FaqItem]
    evidence: list[EvidenceItem] = []
    mode: str = "rule-fallback"
    fallback_reason: str = ""


class WorkupItem(BaseModel):
    item: str
    why: str
    evidence_ids: list[str] = []


class Workup(BaseModel):
    essential: list[WorkupItem]
    suggested: list[WorkupItem]
    optional: list[WorkupItem]
    mode: str = "rule-fallback"
    fallback_reason: str = ""
    evidence_ids: list[str] = []


class Soap(BaseModel):
    subjective: str
    objective: str
    assessment: str
    plan: str


class Report(BaseModel):
    soap: Soap
    conclusion: str
    disclaimer: str
    mode: str = "rule-fallback"
    fallback_reason: str = ""
    evidence_ids: list[str] = []