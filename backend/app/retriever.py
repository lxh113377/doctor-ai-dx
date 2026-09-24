"""检索器边界：当前仅注册原 BM25 实现，后续扩展不侵入诊断引擎。"""
from . import rag

DEFAULT_RETRIEVER = "bm25"


class BM25Retriever:
    name = DEFAULT_RETRIEVER

    @staticmethod
    def search(query: str, top_k: int = 4, filters: dict | None = None) -> list[dict]:
        del filters
        return rag.search(query, top_k)


_BM25_RETRIEVER = BM25Retriever()
_RETRIEVERS = {DEFAULT_RETRIEVER: _BM25_RETRIEVER}


def get_retriever(name: str = DEFAULT_RETRIEVER) -> BM25Retriever:
    key = str(name or DEFAULT_RETRIEVER).strip().lower()
    try:
        return _RETRIEVERS[key]
    except KeyError as exc:
        raise ValueError(f"unsupported retriever: {key}") from exc
