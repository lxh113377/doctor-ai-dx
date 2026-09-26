"""RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权（镜像 frontend/functions/lib/rag.js）。
数据源 knowledge.py 由 knowledge.js 自动生成，两端零漂移。
输出统一 EvidenceItem：{id,title,source,year,url,scope,section,text,icd,score}
口径说明：本文件逐语义对齐 JS 权威实现（查询归一小写+500 截断、同义词逐词分词去重、
top_k 钳制 1..10、稳定排序）；tests/contract_parity.mjs 双端契约测试防漂移。
"""
import math
import unicodedata

from .knowledge import KNOWLEDGE_BASE, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB, SYNONYMS

K1 = 1.5
B = 0.75
MAX_QUERY_LEN = 500
MAX_TOP_K = 10

_BY_ID = {k["id"]: k for k in KNOWLEDGE_BASE}


def _normalize(s) -> str:
    return str(s if s is not None else "").lower()[:2000]


def _indexable(ch: str) -> bool:
    """标点与符号不进索引（与 JS 侧 Unicode 标点/符号类同口径）：逗号曾被当作检索词，df 高到 54，
    一次偶然匹配就能把无关条目顶到榜首——第二十七轮扩库实测抓到，逐字对齐双端。"""
    if ch.isspace():
        return False
    return unicodedata.category(ch)[0] not in ("P", "S")


def _tokenize(text: str) -> list[str]:
    t = "".join(ch for ch in (text or "") if _indexable(ch))
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

def _query_view(q: str) -> dict:
    """同一个查询视图：扩展词形与够得着的加权词。

    匹配面 = 原查询 \u222a 同义词扩展出的词形：加权词表取指南侧词形（\u300c出汗\u300d\u300c抽搐\u300d），
    输入常是口语侧词形（\u300c冒冷汗\u300d\u300c高热惊厥\u300d），把两侧连起来的桥就是同义词表。
    用 \\u0001 连接而非直接拼接，防止跨条目边界伪造一次命中（与 JS 侧同口径）。
    """
    expanded = _expand_query(q)
    flag_hay = "\u0001".join([q, *(str(w).lower() for w in expanded)])
    return {
        "expanded": expanded,
        "hit_flags": [str(kw).lower() for kw in RED_FLAG_KEYWORDS if str(kw).lower() in flag_hay],
    }


def reachable_flag_terms(query) -> list:
    """对判据暴露：该查询实际会给哪几个加权词计分（与 JS 侧 reachableFlagTerms 同口径）。"""
    if query is None or not str(query).strip():
        return []
    return _query_view(_normalize(query)[:MAX_QUERY_LEN])["hit_flags"]


def search(query: str, top_k: int = 4) -> list[dict]:
    if not query or not str(query).strip():
        return []
    try:
        k = int(top_k)
    except (TypeError, ValueError):
        k = 4
    k = max(1, min(k, MAX_TOP_K))
    q = _normalize(query)[:MAX_QUERY_LEN]
    view = _query_view(q)
    all_q = list(_tokenize(q))
    for w in view["expanded"]:
        all_q.extend(_tokenize(w))
    hit_flags = view["hit_flags"]

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


def kb_icd(eid: str):
    """ICD-10 映射原值（组合条目分号并列；综合征/分诊类条目为 None，不得据此编造编码）。"""
    return _BY_ID.get(eid, {}).get("icd")


# ---------- 证据充分性 / 弃权第三态（第二十八轮，台账 #52；与 functions/lib/rag.js 同名同值）----------
ABSTAIN_T = 48.491


def answerability(evidence: list, flags: list) -> dict:
    """红旗在场一律不弃权（漏报危险信号的代价远高于多提示一次"信息不足"）。"""
    top = float(evidence[0]["score"]) if evidence else 0.0
    if isinstance(flags, (list, tuple)) and len(flags) > 0:  # 与 JS 侧 Array.isArray 同判据，非数组不得当作有红旗
        return {"abstain": False, "scope_status": "in-scope", "top_score": top}
    if not evidence:
        return {"abstain": True, "scope_status": "out-of-scope", "top_score": top}
    if top < ABSTAIN_T:
        return {"abstain": True, "scope_status": "insufficient-information", "top_score": top}
    return {"abstain": False, "scope_status": "in-scope", "top_score": top}
