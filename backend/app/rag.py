"""RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权（镜像 frontend/functions/lib/rag.js）。
数据源 knowledge.py 由 knowledge.js 自动生成，两端零漂移。
输出统一 EvidenceItem：{id,title,source,year,url,scope,section,text,icd,score}
口径说明：本文件逐语义对齐 JS 权威实现（查询归一小写+500 截断、同义词逐词分词去重、
top_k 钳制 1..10、稳定排序）；tests/contract_parity.mjs 双端契约测试防漂移。
"""
import math
from .knowledge import KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB

K1 = 1.5
B = 0.75
MAX_QUERY_LEN = 500
MAX_TOP_K = 10

_BY_ID = {k["id"]: k for k in KNOWLEDGE_BASE}


def _normalize(s) -> str:
    return str(s if s is not None else "").lower()[:2000]


def _tokenize(text: str) -> list[str]:
    t = "".join(ch for ch in (text or "") if not ch.isspace())
    toks = []
    for i in range(len(t)):
        toks.append(t[i])
        if i < len(t) - 1:
            toks.append(t[i:i + 2])
    return toks


def _expand_query(q: str) -> list[str]:
    """q 为归一（小写）后查询；命中词组的全部成员去重去已含后原样保留大小写（对齐 JS）。"""
    extra: list[str] = []
    for canon, syns in SYNONYMS.items():
        hit = str(canon).lower() in q or any(str(s).lower() in q for s in syns)
        if not hit:
            continue
        for w in [canon, *syns]:
            if str(w).lower() not in q and w not in extra:
                extra.append(w)
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


def round_half_up(value: float, digits: int = 3) -> float:
    """与 JS 端 Math.round(x*10**n)/10**n 同规则的四舍五入。
    Python 内置 round() 是 half-to-even，会在 .5 边界上与 JS 差一个末位（实测 hybrid 分数 0.020313 vs 0.020312），
    双端一致性必须用同一取整规则，不能靠放宽比对容差掩盖。
    """
    scale = 10 ** digits
    return float(__import__("math").floor(float(value) * scale + 0.5)) / scale


def _evidence_of(item: dict, score: float) -> dict:
    return {
        "id": item["id"], "title": item["title"], "source": item["source"], "year": item["year"],
        "url": item["url"], "scope": item["scope"], "section": item["section"], "text": item["text"],
        "icd": item.get("icd"),
        "score": round_half_up(score, 3),
    }


def search(query: str, top_k: int = 4) -> list[dict]:
    if not query or not str(query).strip():
        return []
    try:
        k = int(top_k)
    except (TypeError, ValueError):
        k = 4
    k = max(1, min(k, MAX_TOP_K))
    q = _normalize(query)[:MAX_QUERY_LEN]
    all_q = list(_tokenize(q))
    for w in _expand_query(q):
        all_q.extend(_tokenize(w))
    hit_flags = [str(kw).lower() for kw in RED_FLAG_KEYWORDS if str(kw).lower() in q]
    scored = []
    for idx, d in enumerate(_DOCS):
        s = 0.0
        for tk in all_q:
            f = d["tf"].get(tk, 0)
            if not f:
                continue
            idf = math.log(1 + (_N - _DF.get(tk, 0) + 0.5) / (_DF.get(tk, 0) + 0.5))
            s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d["len"] / _AVGDL)))
        if hit_flags:
            text_lower = str(d["raw"]["text"]).lower()
            n = sum(1 for kw in hit_flags if kw in text_lower)
            s += 2 * n
        if s > 0:
            scored.append((s, idx, d["raw"]))
    scored.sort(key=lambda x: (-x[0], x[1]))  # 分数降序 + 原文档序（对齐 JS 稳定排序）
    return [_evidence_of(raw, s) for s, _, raw in scored[:k]]


def evidence_for_symptoms(symptoms: list[str]) -> list[dict]:
    # dict 保序对齐 JS Set 插入序（set 迭代序受哈希扰动，双端输出会随机漂移）
    ids: dict[str, None] = {}
    for s in symptoms:
        if not s:
            continue
        for canon, kb_ids in SYMPTOM_TO_KB.items():
            if canon in s:
                ids.update(dict.fromkeys(kb_ids))
        if s in SYMPTOM_TO_KB:
            ids.update(dict.fromkeys(SYMPTOM_TO_KB[s]))
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
