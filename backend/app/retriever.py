"""检索器边界——镜像 frontend/functions/lib/retriever.js。
bm25 = 线上默认（口径不变）；hybrid = BM25+概念通道加权 RRF；
semantic = BM25+语义近邻通道（构建期 BGE 蒸馏表 semantic_neighbors.py，运行时零模型零网络）。
后两档均为 opt-in：默认档变更须先过留出集泛化判定（台账#10）。
红线：不动引用白名单、不动红旗规则层。
"""
from math import floor

from . import rag
from .knowledge import KNOWLEDGE_BASE, SYNONYMS, SYMPTOM_TO_KB
from .semantic_neighbors import SEMANTIC_META, SEMANTIC_NEIGHBORS

DEFAULT_RETRIEVER = "bm25"
RRF_K = 60
MAX_TOP_K = 10
SEMANTIC_NAME = "semantic"
# 语义通道运行参数：与 JS 端同名常量同值，由 tests/semantic_guard.mjs 双向核对。
# 实测结论（2026-09-25，54 组网格）：留出集严格优于 bm25 的候选 0 组、9 组惰性等值、45 组劣化（ΔMRR 最差 −0.328），
# 根因与阈值不可解分析见 JS 端同名常量注释——本档保持 opt-in 实验位，默认仍 bm25，线上口径零改动。
SEM_TOP = 5
SEM_FLOOR = 600  # 千分比，cos ≥ 0.60 才作候选
W_SEM = 0.3
_BY_ID = {k["id"]: k for k in KNOWLEDGE_BASE}


class BM25Retriever:
    name = DEFAULT_RETRIEVER

    @staticmethod
    def search(query: str, top_k: int = 4, filters: dict | None = None) -> list[dict]:
        del filters
        return rag.search(query, top_k)


def _doc_text(item: dict) -> str:
    return " ".join([
        item.get("title") or "",
        item.get("condition") or "",
        " ".join(item.get("keywords") or []),
        item.get("text") or "",
    ])


def concept_channel(query: str) -> list[str]:
    """同义词组命中 + 症状线索直连；与 BM25 词面计分无关，用于口语表述补召回。"""
    q = str(query or "").lower()[:500]
    if not q.strip():
        return []
    weight: dict[str, int] = {}
    for canon, syns in SYNONYMS.items():
        members = [str(canon).lower(), *[str(s).lower() for s in syns]]
        if not any(m in q for m in members):
            continue
        for item in KNOWLEDGE_BASE:
            hay = _doc_text(item).lower()
            hits = sum(1 for m in members if m and m in hay)
            if hits:
                weight[item["id"]] = weight.get(item["id"], 0) + hits
    for sym, ids in SYMPTOM_TO_KB.items():
        if str(sym).lower() not in q:
            continue
        for kb_id in ids:
            if kb_id in _BY_ID:
                weight[kb_id] = weight.get(kb_id, 0) + 2
    return [i for i, _ in sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))]


def adjacency_channel(seed_ids: list[str], max_out: int = 10) -> list[str]:
    """以 BM25 种子条目为锚，按共享 keywords 数扩出同域鉴别项。"""
    seeds = [_BY_ID[i] for i in (seed_ids or [])[:5] if i in _BY_ID]
    if not seeds:
        return []
    seed_set = {s["id"] for s in seeds}
    weight: dict[str, int] = {}
    for item in KNOWLEDGE_BASE:
        if item["id"] in seed_set:
            continue
        kw = set(item.get("keywords") or [])
        shared = 0
        for seed in seeds:
            in_seed = sum(1 for k in (seed.get("keywords") or []) if k in kw)
            if in_seed >= 2:
                shared += in_seed
            elif in_seed == 1 and seed.get("scope") == item.get("scope"):
                shared += 1
        if shared:
            weight[item["id"]] = shared
    return [i for i, _ in sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))][:max_out]


def _evidence(kb_id: str, score: float) -> dict:
    item = _BY_ID[kb_id]
    return {
        "id": item["id"], "title": item["title"], "source": item["source"], "year": item["year"],
        "url": item["url"], "scope": item["scope"], "section": item["section"], "text": item["text"],
        "icd": item.get("icd") or None,
        "score": rag.round_half_up(score, 6),
    }


def rrf_fuse(channels: list[dict], top_k: int = 4) -> list[dict]:
    """加权 Reciprocal Rank Fusion：只用名次，规避不同量纲分数的归一问题。
    channels = [{"list": [id...], "weight": w}, ...]；权重含义见 JS 端同名函数注释。
    """
    acc: dict[str, float] = {}
    for channel in channels:
        weight = float(channel.get("weight", 1.0))
        for rank, kb_id in enumerate(channel.get("list") or []):
            if kb_id not in _BY_ID:
                continue
            acc[kb_id] = acc.get(kb_id, 0.0) + weight / (RRF_K + rank + 1)
    ordered = sorted(acc.items(), key=lambda kv: (-kv[1], kv[0]))[:top_k]
    return [_evidence(i, s) for i, s in ordered]


def semantic_channel(seed_ids: list[str], top: int = SEM_TOP, floor_per_mille: int = SEM_FLOOR) -> list[str]:
    """以 BM25 种子为锚查语义邻接表（BGE-small-zh-v1.5 离线蒸馏）。
    与 adjacency_channel（共享 keywords 计数）的区别：信号来自 512 维语义相似度而非词面重叠。
    千分比整数 → 与 JS 端取值/排序完全一致；tie-break 用 id 升序，与 rrf_fuse 同规则。
    """
    seeds = list(seed_ids or [])[:5]
    if not seeds:
        return []
    seed_set = set(seeds)
    weight: dict[str, int] = {}
    for sid in seeds:
        for nid, per_mille in SEMANTIC_NEIGHBORS.get(sid, []):
            if nid in seed_set or nid not in _BY_ID or per_mille < floor_per_mille:
                continue
            weight[nid] = weight.get(nid, 0) + per_mille
    return [i for i, _ in sorted(weight.items(), key=lambda kv: (-kv[1], kv[0]))][:top]


W_BM25 = 1.0
# 权重标定口径见 JS 端同名常量注释（work/sweep_hybrid_weights.mjs 实测）
W_CONCEPT = 0.3
CONCEPT_TOP = 5


class HybridRetriever:
    name = "hybrid"

    @staticmethod
    def search(query: str, top_k: int = 4, filters: dict | None = None) -> list[dict]:
        del filters
        raw = top_k if isinstance(top_k, (int, float)) and float(top_k) == top_k else 4
        k = max(1, min(int(floor(raw)), MAX_TOP_K))
        bm = [e["id"] for e in rag.search(query, 10)]
        return rrf_fuse([
            {"list": bm, "weight": W_BM25},
            {"list": concept_channel(query)[:CONCEPT_TOP], "weight": W_CONCEPT},
        ], k)


class SemanticRetriever:
    name = SEMANTIC_NAME

    @staticmethod
    def search(query: str, top_k: int = 4, filters: dict | None = None) -> list[dict]:
        del filters
        raw = top_k if isinstance(top_k, (int, float)) and float(top_k) == top_k else 4
        k = max(1, min(int(floor(raw)), MAX_TOP_K))
        bm = [e["id"] for e in rag.search(query, 10)]
        return rrf_fuse([
            {"list": bm, "weight": W_BM25},
            {"list": semantic_channel(bm), "weight": W_SEM},
        ], k)


_BM25_RETRIEVER = BM25Retriever()
_HYBRID_RETRIEVER = HybridRetriever()
_SEMANTIC_RETRIEVER = SemanticRetriever()
_RETRIEVERS = {
    DEFAULT_RETRIEVER: _BM25_RETRIEVER,
    "hybrid": _HYBRID_RETRIEVER,
    SEMANTIC_NAME: _SEMANTIC_RETRIEVER,
}


def get_retriever(name: str = DEFAULT_RETRIEVER):
    key = str(name or DEFAULT_RETRIEVER).strip().lower()
    try:
        return _RETRIEVERS[key]
    except KeyError as exc:
        raise ValueError(f"unsupported retriever: {key}") from exc
