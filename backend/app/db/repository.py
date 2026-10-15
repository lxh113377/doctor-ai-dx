"""会话面读写仓储（MySQL 侧）。

调用方形态与 `frontend/functions/lib/chat_store.js` 对齐：**每个写操作返回 bool，
引擎不可用返回 False 并带上原因**，绝不做「看起来成功」的静默 no-op。
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .engine import current_engine
from .models import Conversation, Feedback, Handoff, IntentEvent, Message

# 会话默认存活 30 天：与 d1_cleanup.mjs 的 TTL 语义同形（过期行由清理任务删，不静默丢）。
TTL_DAYS = 30


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _expiry() -> str:
    from datetime import timedelta

    return (datetime.now(UTC) + timedelta(days=TTL_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")


class PersistResult:
    """写操作回执：ok 与 reason 恰有一个有意义，调用方把 reason 原样带进健康读数。"""

    __slots__ = ("ok", "reason")

    def __init__(self, ok: bool, reason: str = ""):
        self.ok = ok
        self.reason = reason

    def __bool__(self) -> bool:
        return self.ok

    def __repr__(self) -> str:
        return f"PersistResult(ok={self.ok}, reason={self.reason!r})"


def _session():
    engine, reason = current_engine()
    if engine is None:
        return None, reason
    return Session(engine), ""


def save_message(conversation_id: str, message_id: str, role: str, content: str,
                 red_flag: int = 0, redacted_hits: str = "[]", intent: str = "general_medical",
                 confidence: float = 0, kb_hits: str = "[]", source_refs: str = "[]",
                 provider: str = "rule", latency_ms: int = 0) -> PersistResult:
    """落一条消息，顺带把会话的 turn_count/updated_at 推进（与 chat_store.js 的同一次写入同形）。"""
    session, reason = _session()
    if session is None:
        return PersistResult(False, reason)
    now = _now()
    try:
        conv = session.get(Conversation, conversation_id)
        if conv is None:
            conv = Conversation(id=conversation_id, created_at=now, updated_at=now,
                                turn_count=0, handed_off=0, expires_at=_expiry())
            session.add(conv)
        session.add(Message(
            id=message_id, conversation_id=conversation_id, role=role, content=content,
            redacted_hits=redacted_hits, red_flag=red_flag, intent=intent, confidence=confidence,
            kb_hits=kb_hits, source_refs=source_refs, provider=provider,
            latency_ms=latency_ms, created_at=now,
        ))
        conv.turn_count = int(conv.turn_count or 0) + 1
        conv.updated_at = now
        session.commit()
        return PersistResult(True)
    except SQLAlchemyError as exc:
        session.rollback()
        return PersistResult(False, f"WRITE_FAILED {type(exc).__name__}")
    finally:
        session.close()


def save_intent_event(conversation_id: str, event_id: str, intent: str,
                      confidence: float = 0, matched: str = "[]") -> PersistResult:
    session, reason = _session()
    if session is None:
        return PersistResult(False, reason)
    try:
        session.add(IntentEvent(id=event_id, conversation_id=conversation_id, intent=intent,
                                confidence=confidence, matched=matched, created_at=_now()))
        session.commit()
        return PersistResult(True)
    except SQLAlchemyError as exc:
        session.rollback()
        return PersistResult(False, f"WRITE_FAILED {type(exc).__name__}")
    finally:
        session.close()


def open_handoff(conversation_id: str, handoff_id: str, reason_code: str,
                 reason_text: str = "", context_digest: str = "") -> PersistResult:
    session, reason = _session()
    if session is None:
        return PersistResult(False, reason)
    now = _now()
    try:
        session.add(Handoff(id=handoff_id, conversation_id=conversation_id, reason_code=reason_code,
                            reason_text=reason_text, context_digest=context_digest,
                            status="open", created_at=now))
        conv = session.get(Conversation, conversation_id)
        if conv is not None:
            conv.handed_off = 1
            conv.updated_at = now
        session.commit()
        return PersistResult(True)
    except SQLAlchemyError as exc:
        session.rollback()
        return PersistResult(False, f"WRITE_FAILED {type(exc).__name__}")
    finally:
        session.close()


def save_feedback(conversation_id: str, feedback_id: str, score: int,
                  tag: str = "", comment: str = "") -> PersistResult:
    if not isinstance(score, int) or not 1 <= score <= 5:
        return PersistResult(False, f"SCORE_OUT_OF_RANGE {score!r} 不在 1..5")
    session, reason = _session()
    if session is None:
        return PersistResult(False, reason)
    now = _now()
    try:
        existing = session.scalar(select(Feedback).where(Feedback.conversation_id == conversation_id))
        if existing is None:
            session.add(Feedback(id=feedback_id, conversation_id=conversation_id, score=score,
                                 tag=tag, comment=comment, created_at=now))
        else:
            existing.score = score
            existing.tag = tag
            existing.comment = comment
        conv = session.get(Conversation, conversation_id)
        if conv is not None:
            conv.satisfaction = score
            conv.updated_at = now
        session.commit()
        return PersistResult(True)
    except SQLAlchemyError as exc:
        session.rollback()
        return PersistResult(False, f"WRITE_FAILED {type(exc).__name__}")
    finally:
        session.close()


def conversation_transcript(conversation_id: str) -> dict | None:
    """按会话取回整段记录（形状对齐 chat_store.js 的 getConversation 返回）。"""
    session, reason = _session()
    if session is None:
        return None
    try:
        conv = session.get(Conversation, conversation_id)
        if conv is None:
            return None
        messages = session.scalars(
            select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at)
        ).all()
        events = session.scalars(
            select(IntentEvent).where(IntentEvent.conversation_id == conversation_id)
            .order_by(IntentEvent.created_at)
        ).all()
        handoffs = session.scalars(
            select(Handoff).where(Handoff.conversation_id == conversation_id).order_by(Handoff.created_at)
        ).all()
        fb = session.scalar(select(Feedback).where(Feedback.conversation_id == conversation_id))
        return {
            "conversation": {
                "id": conv.id, "created_at": conv.created_at, "updated_at": conv.updated_at,
                "turn_count": conv.turn_count, "handed_off": conv.handed_off,
                "satisfaction": conv.satisfaction, "expires_at": conv.expires_at,
            },
            "messages": [
                {"role": m.role, "content": m.content, "red_flag": m.red_flag,
                 "created_at": m.created_at, "intent": m.intent, "confidence": m.confidence,
                 "kb_hits": m.kb_hits, "source_refs": m.source_refs, "provider": m.provider,
                 "latency_ms": m.latency_ms}
                for m in messages
            ],
            "intent_events": [
                {"intent": e.intent, "confidence": e.confidence, "matched": e.matched,
                 "created_at": e.created_at} for e in events
            ],
            "handoffs": [
                {"reason_code": h.reason_code, "reason_text": h.reason_text, "status": h.status,
                 "created_at": h.created_at} for h in handoffs
            ],
            "feedback": None if fb is None else {"score": fb.score, "tag": fb.tag,
                                                 "created_at": fb.created_at},
        }
    finally:
        session.close()
