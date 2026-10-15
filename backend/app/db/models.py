"""MySQL 侧表结构的**唯一定义处**（ORM metadata）。

三个数据面各自成组，`scripts/mysql_schema.py` 由本文件单向生成 DDL，`docs` 与 CI 判据都读生成物：

| 面 | 表 | 与既有单源的关系 |
|---|---|---|
| 会话与反馈 | conversations / messages / intent_events / handoffs / feedback | 列名与可空性**逐列对齐** `scripts/d1_schema.sql`（权威源），漂移由 `tests/test_mysql_schema_guard.py` 判红 |
| 配置与语料 | corpus_entries | 是 `data/*.json` 的**派生下游**，不是第二个可编辑真值（仓规 #92：JSON 唯一权威） |
| 评测结果 | eval_reports / eval_case_modes | 是 `eval_report*.json` 的落库副本，带原文 sha256 供回查 |

为什么默认值放在应用层而不是 `server_default`：MySQL 禁止 TEXT/BLOB 列带字面量 `DEFAULT`
（8.0.13 起只接受 `DEFAULT (expr)` 表达式默认），而 D1/SQLite 那侧 `redacted_hits TEXT NOT NULL
DEFAULT '[]'` 是合法的。所以本文件对这些列只做 Python 侧默认，**列名与可空性仍与 D1 全等**；
这条方言差异是刻意的，判据按「列名+可空性」对账、不按默认机制对账（见 `dialect_divergence()`）。
"""
from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# MySQL 的 utf8mb4 单列索引上限：InnoDB 索引键前缀 767 字节（COMPACT 行格式），
# 767 // 4 = 191。取 191 是为了让 id 类字符串主键在 5.7/8.0 两侧都能建索引而不被静默截断。
ID_LEN = 191

# 逐表声明引擎与字符集：中文临床文本进了 latin1（MySQL 5.7 的默认）会在第一次写症状描述时
# 直接报错或被截断，而"能连上、能建表"两步都是绿的——所以宁可每张表都写死。
TABLE_OPTS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"}

# 表名按数据面分组：schema 守卫与导入器都从这里取名单，不在别处再抄第二份。
CONVERSATION_FACE = ("conversations", "messages", "intent_events", "handoffs", "feedback")
CORPUS_FACE = ("corpus_entries",)
EVAL_FACE = ("eval_reports", "eval_case_modes")


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)
    turn_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    handed_off: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    satisfaction: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expires_at: Mapped[str | None] = mapped_column(String(32), nullable=True)

    __table_args__ = (Index("idx_conversations_updated", "updated_at"), TABLE_OPTS)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(ID_LEN), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    redacted_hits: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    red_flag: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    intent: Mapped[str | None] = mapped_column(String(64), nullable=True, default="general_medical")
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True, default=0)
    kb_hits: Mapped[str | None] = mapped_column(Text, nullable=True, default="[]")
    source_refs: Mapped[str | None] = mapped_column(Text, nullable=True, default="[]")
    provider: Mapped[str | None] = mapped_column(String(32), nullable=True, default="rule")
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("role IN ('user','assistant')", name="ck_messages_role"),
        Index("idx_messages_conv", "conversation_id", "created_at"),
        Index("idx_messages_intent", "intent"),
        Index("idx_messages_provider", "provider"),
        Index("idx_messages_created", "created_at"),
        TABLE_OPTS,
    )


class IntentEvent(Base):
    __tablename__ = "intent_events"

    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(ID_LEN), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    intent: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    matched: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        Index("idx_intent_events_conv", "conversation_id", "created_at"),
        Index("idx_intent_events_intent", "intent"),
        TABLE_OPTS,
    )


class Handoff(Base):
    __tablename__ = "handoffs"

    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(ID_LEN), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    reason_code: Mapped[str] = mapped_column(String(64), nullable=False)
    reason_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    context_digest: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("status IN ('open','assigned','closed')", name="ck_handoffs_status"),
        Index("idx_handoffs_status", "status", "created_at"),
        TABLE_OPTS,
    )


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(ID_LEN), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    tag: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    comment: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("score BETWEEN 1 AND 5", name="ck_feedback_score"),
        UniqueConstraint("conversation_id", name="uq_feedback_conversation"),
        Index("idx_feedback_score", "score"),
        TABLE_OPTS,
    )


class CorpusEntry(Base):
    """`data/*.json` 六个语料面在 MySQL 里的统一落点（派生下游）。

    一张表带 `source_file` 判别列，而不是六张近重复表：六个面的结构差异留在 JSON 原文里，
    库侧只做「原文可回查 + 条数可对账」，避免为每个面各写一套列而造出第二份结构真值。
    """

    __tablename__ = "corpus_entries"

    source_file: Mapped[str] = mapped_column(String(64), primary_key=True)
    entry_key: Mapped[str] = mapped_column(String(191), primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    payload: Mapped[str] = mapped_column(Text(length=2 ** 24 - 1), nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    corpus_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    loaded_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        # 主键三元组必须含 entry_key：同一份 JSON 里多个顶层键的 seq 各自从 0 起数
        # （实测 cds_services.json 的 specVersion/source/indicatorMap 全是 seq=0），
        # 只用 (source_file, seq) 会在第一次真灌时就主键冲突。唯一约束由主键自身承担，不另设。
        Index("idx_corpus_source", "source_file", "seq"),
        TABLE_OPTS,
    )


class EvalReport(Base):
    __tablename__ = "eval_reports"

    run_id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    report_file: Mapped[str] = mapped_column(String(191), nullable=False)
    report_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    report_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    base: Mapped[str | None] = mapped_column(String(191), nullable=True)
    case_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    summary: Mapped[str] = mapped_column(Text(length=2 ** 24 - 1), nullable=False)
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        UniqueConstraint("report_file", "report_sha256", name="uq_eval_report_identity"),
        Index("idx_eval_created", "created_at"),
        TABLE_OPTS,
    )


class EvalCaseMode(Base):
    __tablename__ = "eval_case_modes"

    run_id: Mapped[str] = mapped_column(
        String(ID_LEN), ForeignKey("eval_reports.run_id", ondelete="CASCADE"), primary_key=True
    )
    case_id: Mapped[str] = mapped_column(String(ID_LEN), primary_key=True)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    abstain: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cause: Mapped[str | None] = mapped_column(String(191), nullable=True)
    has_cause_field: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (Index("idx_eval_case_mode", "run_id", "mode"), TABLE_OPTS)


def metadata():
    return Base.metadata


def dialect_divergence() -> tuple[tuple[str, str], ...]:
    """D1(SQLite) ⇄ MySQL 两侧**已声明且刻意**的差异，逐条枚举。

    为什么要显式列出来：不列的话，schema 守卫只有两个选择——要么按「完全一致」判红（把方言差异
    误报成漂移），要么干脆不比（把真漂移放过去）。把它成名册，守卫就能反过来断言
    「名册之外的差异一律判红」，也能断言名册里每条在两侧**确实**成立。
    """
    return (
        ("defaults", "TEXT/BLOB 列的字面量 DEFAULT 只存在于 D1 侧；MySQL 侧由 ORM Python 默认承载"),
        ("pragma", "D1 侧的 PRAGMA foreign_keys = ON 无 MySQL 对应物；MySQL 由引擎 InnoDB 强制外键"),
        ("text_length", "D1 侧 TEXT 无长度语义；MySQL 侧语料/评测正文取 LONGTEXT（payload 上限实测 4 KB 级，余量为形态兼容留）"),
        ("index_desc", "D1 侧 idx_conversations_updated 用 DESC；MySQL 8.0 反向索引实现不同，守卫只比列集合不比方向"),
    )
