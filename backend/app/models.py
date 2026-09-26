"""Pydantic 数据契约（= 前后端接口契约 + api.js 存根已按此 shape）"""
from pydantic import BaseModel, field_validator

from . import limits


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
    # case_id 在 /dx|/workup|/report 三条路由里取自 **路径参数**（与权威面 Functions 一致），
    # 所以请求体不得强制携带它：此前 `case_id: str`（必填）让镜像面对"只带路径 id"的合法请求回 422，
    # 而权威面正常 200——第二十一轮双端错误码对账（tests/error_parity_guard.mjs）首跑抓到的真实差异。
    # 只有 /intake/ask 无路径 id、需要体里的 case_id；缺/错时由引擎抛 unknown case → 双端同回 404。
    case_id: str = ""
    answer: str = ""
    history: list[dict] = []   # [{role: "user"|"assistant", content: ...}] 由前端随请求携带（stateless）
    dx: dict | None = None     # 前端已生成的诊断结果（workup/report 复用，省一次 LLM 串行调用）

    @field_validator("history")
    @classmethod
    def _bound_history(cls, v: list[dict]) -> list[dict]:
        """入站边界：条数与单条字数上限（数值单一源 = frontend/tests/fixtures/request_limits.json）。
        必须在契约层挡住：越界的请求若进到引擎，会白付一次 LLM 窗口（8s + token）。"""
        limits.check_history(v)
        return v

    @field_validator("dx")
    @classmethod
    def _bound_dx(cls, v: dict | None) -> dict | None:
        limits.check_dx(v)
        return v


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
    abstain: bool = False  # 第三态（v1.25.0 #52）：证据不足/域外时不编鉴别诊断
    scope_status: str = "in-scope"  # in-scope | insufficient-information | out-of-scope
    top_evidence_score: float = 0.0  # 与 rag.ABSTAIN_T 比较，双端同值由 abstain_guard 对账
    abstain_reason: str = ""  # 给医生看的理由文案，必须含「医生」主导口径
    scope_rule: str | None = None  # 命中的能力级规则 id（data/scope_rules.json），未命中为 None
    fhir: dict = {}  # FHIR R4 light 导出（只读派生视图，不参与决策链）


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