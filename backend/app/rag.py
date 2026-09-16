"""RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权（镜像 frontend/functions/lib/rag.js）。
数据源 knowledge.py 由 knowledge.js 自动生成，两端零漂移。
输出统一 EvidenceItem：{id,title,source,year,url,scope,section,text,score}
"""
import math
from .knowledge import KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB

K1 = 1.5
B = 0.75

_BY_ID = {k["id"]: k for k in KNOWLEDGE_BASE}


def _tokenize(text: str) -> list[str]:
    t = "".join(ch for ch in (text or "") if not ch.isspace())
    toks = []
    for i in range(len(t)):
        toks.append(t[i])
        if i < len(t) - 1:
            toks.append(t[i:i + 2])
    return toks


def _expand_query(query: str) -> list[str]:
    extra: list[str] = []
    for canon, syns in SYNONYMS.items():
        if canon in query:
            extra.extend(syns)
        elif any(s in query for s in syns):
            extra.append(canon)
            extra.extend(syns)
    return extra


def _build_index():
    docs = []
    df: dict[str, int] = {}
    total_len = 0
    for item in KNOWLEDGE_BASE:
        tf: dict[str, int] = {}
        toks = _tokenize(item["title"] + " " + " ".join(item["keywords"]) + " " + item["text"] + " " + item["condition"])
        ln = len(toks)
        total_len += ln
        seen = set()
        for tk in toks:
            tf[tk] = tf.get(tk, 0) + 1
            if tk not in seen:
                df[tk] = df.get(tk, 0) + 1
                seen.add(tk)
        docs.append({"id": item["id"], "tf": tf, "len": ln, "raw": item})
    n = len(docs)
    avgdl = total_len / (n or 1)
    return docs, df, n, avgdl


_DOCS, _DF, _N, _AVGDL = _build_index()


def _evidence_of(item: dict, score: float) -> dict:
    return {
        "id": item["id"], "title": item["title"], "source": item["source"], "year": item["year"],
        "url": item["url"], "scope": item["scope"], "section": item["section"], "text": item["text"],
        "score": round(score, 3),
    }


def search(query: str, top_k: int = 4) -> list[dict]:
    if not query or not query.strip():
        return []
    all_q = _tokenize(query) + _tokenize("".join(_expand_query(query)))
    scored = []
    for d in _DOCS:
        s = 0.0
        for q in all_q:
            f = d["tf"].get(q, 0)
            if not f:
                continue
            idf = math.log(1 + (_N - _DF.get(q, 0) + 0.5) / (_DF.get(q, 0) + 0.5))
            s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d["len"] / _AVGDL)))
        for kw in RED_FLAG_KEYWORDS:
            if kw in query and kw in d["raw"]["text"]:
                s += 2
        if s > 0:
            scored.append((s, d["raw"]))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [_evidence_of(raw, s) for s, raw in scored[:top_k]]


def evidence_for_symptoms(symptoms: list[str]) -> list[dict]:
    ids: set[str] = set()
    for s in symptoms:
        for canon, kb_ids in SYMPTOM_TO_KB.items():
            if canon in s:
                ids.update(kb_ids)
        if s in SYMPTOM_TO_KB:
            ids.update(SYMPTOM_TO_KB[s])
    return [_evidence_of(_BY_ID[i], 0) for i in ids if i in _BY_ID]


def evidence_by_ids(ids: list[str]) -> list[dict]:
    return [_evidence_of(_BY_ID[i], 0) for i in ids if i in _BY_ID]


def has_evidence(eid: str) -> bool:
    return eid in _BY_ID


def kb_title(eid: str) -> str:
    return _BY_ID.get(eid, {}).get("title", eid)


def kb_condition(eid: str) -> str:
    return _BY_ID.get(eid, {}).get("condition", "")


def kb_text(eid: str) -> str:
    return _BY_ID.get(eid, {}).get("text", "")
