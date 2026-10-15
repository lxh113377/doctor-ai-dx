"""引擎工厂与能力开关（缺省关闭）。

沿用 `frontend/functions/lib/chat_store.js` 的 `unavailable(reason)` 形态：**建不出引擎就返回原因，
不假装成功**。理由不是风格——是这个仓反复判红过的「假交付」形态：写操作静默 no-op 而调用方读到
rc=0，下次没人知道库里其实没东西。
"""
from __future__ import annotations

import os
import re

from .models import Base

# 生产库名的可识别形态：dev/staging 连上它就是踩 R196 环境隔离红线，必须在建引擎前拦下。
PROD_NAME_RE = re.compile(r"(^|[^A-Za-z0-9])(prod|production|线上)([^A-Za-z0-9]|$)", re.I)
PRODUCTION_ROLE = "production"

_engine = None
_engine_key: tuple[str, str] | None = None


def requested_backend() -> str:
    # 字面量直读是刻意的：env_guard 对「应用面读取的环境变量」做登记对账，
    # 走常量间接读会让该判据失明（实测：BACKEND_VAR 形态被判「漏登记」）。
    return (os.getenv("PERSIST_BACKEND") or "off").strip().lower()


def database_name(url: str) -> str:
    """取 URL 路径段的库名（不含 query）：用于「角色⇄库名」红线判定，不打印整条 URL。"""
    tail = url.rsplit("/", 1)[-1]
    return tail.split("?", 1)[0].split(";", 1)[0]


def redline_reason(url: str, role: str) -> str:
    """R196：dev/staging 禁连 production 库。命中返回原因串，未命中返回空串。"""
    if role == PRODUCTION_ROLE or not PROD_NAME_RE.search(database_name(url)):
        return ""
    return f"ENV_ROLE={role or '未设'} 连production 库（红线 R196：dev/staging 禁止连接生产库）"


def current_engine():
    """返回 (engine, reason)：二者恰有一个非空，调用方据此如实报状态。

    三种关闭态各自的 reason 必须可归因、可 grep：
      - `SWITCH_OFF`：开关没打开（现状，也是默认）
      - `URL_MISSING`：开关打开了但没给连接串
      - `REDLINE_REFUSED` / `CONNECT_FAILED`：给了但不许连 / 连不上
    """
    global _engine, _engine_key

    backend = requested_backend()
    if backend != "mysql":
        return None, f"SWITCH_OFF PERSIST_BACKEND={backend}"

    url = (os.getenv("MYSQL_URL") or "").strip()
    if not url:
        return None, "URL_MISSING MYSQL_URL 未设"

    if not url.lower().startswith("mysql"):
        return None, f"URL_DIALECT 期望 mysql+* 前缀，实测 {url.split(':', 1)[0]}"

    role = (os.getenv("ENV_ROLE") or "development").strip().lower()
    reason = redline_reason(url, role)
    if reason:
        return None, f"REDLINE_REFUSED {reason}"

    key = (url, role)
    if _engine is not None and _engine_key == key:
        return _engine, ""

    try:
        from sqlalchemy import create_engine
    except ImportError as exc:  # 锁里没装到位（本机未 pip install -r 锁）——显式失败，不静默降级
        return None, f"DEPENDENCY_MISSING sqlalchemy 导入失败：{exc}"

    try:
        eng = create_engine(url, pool_pre_ping=True, future=True)
        eng.connect().close()
    except Exception as exc:  # 连接失败的原因里绝不带 URL：pymysql 的异常文本会回显 host/user
        return None, f"CONNECT_FAILED {type(exc).__name__}"

    _engine, _engine_key = eng, key
    return eng, ""


def engine_available() -> bool:
    engine, _reason = current_engine()
    return engine is not None


def db_status() -> dict:
    """能力读数：给 /health 与文档「回执锚点」用，禁只回一个 bool。

    有 bool 没原因＝下次排查时没人知道它是关的、缺 URL 的还是连不上的（本仓同族坑）。
    """
    engine, reason = current_engine()
    return {
        "requested": requested_backend(),
        "available": engine is not None,
        "reason": reason,
        "tables": sorted(Base.metadata.tables) if engine is not None else [],
    }


def create_all(engine) -> list[str]:
    """按 ORM metadata 建表，返回实际建出的表名（调用方据此断言「建的就是声明的那些」）。"""
    Base.metadata.create_all(engine)
    return sorted(Base.metadata.tables)
