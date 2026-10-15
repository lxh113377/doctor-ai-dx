"""镜像面的 MySQL 持久化层（第一百零八轮）。

整个包对**缺省配置零影响**：`PERSIST_BACKEND` 不等于 `mysql` 时 `engine.current_engine()` 返回
`(None, reason)`，调用方沿用无库路径。装进依赖锁 ≠ 接进运行链路，二者由本包的开关分开。
"""
from .engine import current_engine, db_status, engine_available
from .models import CONVERSATION_FACE, CORPUS_FACE, EVAL_FACE, Base, metadata

__all__ = [
    "Base",
    "metadata",
    "CONVERSATION_FACE",
    "CORPUS_FACE",
    "EVAL_FACE",
    "current_engine",
    "engine_available",
    "db_status",
]
