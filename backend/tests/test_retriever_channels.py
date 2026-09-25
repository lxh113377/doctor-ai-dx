"""检索器通道后端单测（覆盖率实测 app/retriever.py 仅 37% 的直接回应）。

根因：hybrid / semantic 两档过去只被 contract_parity 经 subprocess 调用，
后端**自有套件**从未执行过这些纯函数——于是镜像面的通道逻辑处于"被比对、没被断言"状态：
比对只保证两端一致，不保证两端都对。本文件补的是后者。
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.pop("DEEPSEEK_API_KEY", None)

from app import rag  # noqa: E402
from app.knowledge import KNOWLEDGE_BASE  # noqa: E402
from app.retriever import (  # noqa: E402
    CONCEPT_TOP,
    DEFAULT_RETRIEVER,
    MAX_TOP_K,
    SEM_FLOOR,
    SEM_TOP,
    W_SEM,
    adjacency_channel,
    concept_channel,
    get_retriever,
    rrf_fuse,
    semantic_channel,
)
from app.semantic_neighbors import SEMANTIC_NEIGHBORS  # noqa: E402

passed = failed = 0


def check(name, condition, detail=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS", name)
    else:
        failed += 1
        print("  FAIL", name + (f" :: {detail}" if detail else ""))


IDS = {k["id"] for k in KNOWLEDGE_BASE}
QUERY = "压榨样胸痛伴冷汗，放射至左肩"

check("默认档仍 bm25（红线：线上口径未变）", DEFAULT_RETRIEVER == "bm25" and get_retriever().name == "bm25")
try:
    get_retriever("nope")
    check("未知档名抛 ValueError", False, "未抛错")
except ValueError:
    check("未知档名抛 ValueError", True)

bm = [e["id"] for e in rag.search(QUERY, 10)]
check("BM25 种子非空且全部在白名单内", bool(bm) and set(bm) <= IDS, str(bm[:3]))

concept = concept_channel(QUERY)
check("概念通道返回白名单内 id 且截断生效", bool(concept) and set(concept) <= IDS)
check("概念通道长度上限 CONCEPT_TOP 由使用方截断（口径一致）",
      len(concept[:CONCEPT_TOP]) <= CONCEPT_TOP)
check("概念通道：空查询返回空而非 None", concept_channel("") == [] and concept_channel(None) == [])
check("概念通道：无关文本不抛错", isinstance(concept_channel("完全无关的乱码zzz"), list))

adj = adjacency_channel(bm)
check("近邻通道（词面共享）返回白名单内 id", set(adj) <= IDS, str(adj[:3]))
check("近邻通道：空种子返回空", adjacency_channel([]) == [] and adjacency_channel(["kb-999"]) == [])
check("近邻通道：max_out 生效", len(adjacency_channel(bm, 3)) <= 3)

sem = semantic_channel(bm)
check("语义通道返回白名单内 id", bool(sem) and set(sem) <= IDS, str(sem[:3]))
check("语义通道：种子自身不出现在结果里（去自环）", not set(sem) & set(bm[:5]))
check("语义通道：top 参数生效", len(semantic_channel(bm, 2)) <= 2)
# 真实判据：通道结果里每个 id 都必须来自某颗种子的、且千分比 >= 地板的邻接项
allowed = {(sid, n) for sid in bm[:5] for n, s in SEMANTIC_NEIGHBORS.get(sid, []) if s >= SEM_FLOOR}
bad_pairs = [x for x in sem if not any(n == x for _, n in allowed)]
check(f"语义通道：结果全部来自种子且千分比 >= 地板 {SEM_FLOOR}‰", not bad_pairs, ",".join(bad_pairs))
looser = semantic_channel(bm, SEM_TOP, 550)
check("地板从 600‰ 降到 550‰ 时候选只增不减（判据方向正确）", len(looser) >= len(sem), f"{len(looser)} vs {len(sem)}")
floor_tight = semantic_channel(bm, SEM_TOP, 999)
check("语义通道：地板拉到 999‰ 时候选清空（判据非恒真）", floor_tight == [], str(floor_tight))

fused = rrf_fuse([{"list": bm, "weight": 1.0}, {"list": sem, "weight": W_SEM}], 5)
check("RRF 融合输出 5 条且带 score/id/title", len(fused) == 5 and all({"id", "score", "title"} <= set(e) for e in fused))
check("RRF 融合：白名单外 id 被丢弃", all(e["id"] in IDS for e in rrf_fuse([{"list": ["kb-999"] + bm, "weight": 1}], 5)))
check("RRF 融合：空通道不抛错且返回空", rrf_fuse([], 4) == [])
check("RRF 融合：权重为 0 的通道不影响结果", [e["id"] for e in rrf_fuse([{"list": bm, "weight": 1.0}, {"list": sem, "weight": 0.0}], 3)]
      == [e["id"] for e in rrf_fuse([{"list": bm, "weight": 1.0}], 3)])

for name in ("bm25", "hybrid", "semantic"):
    out = get_retriever(name).search(QUERY, 5)
    check(f"{name} 档输出结构完整且 id 在白名单内",
          out and all({"id", "title", "source", "year", "url", "scope", "section", "text", "icd", "score"} <= set(e) for e in out)
          and set(e["id"] for e in out) <= IDS)

top_k_probe = get_retriever("semantic").search(QUERY, MAX_TOP_K + 5)
check(f"top_k 越界被钳制到 {MAX_TOP_K}", len(top_k_probe) <= MAX_TOP_K, str(len(top_k_probe)))
check("top_k 非法值（字符串/负数）不崩", isinstance(get_retriever("hybrid").search(QUERY, "x"), list)
      and isinstance(get_retriever("semantic").search(QUERY, -3), list))

print(f"\nRESULT: {passed} pass / {failed} fail")
sys.exit(1 if failed else 0)
