// 检索器边界：可插拔注册表。bm25 = 线上默认（口径不变）；hybrid = BM25+概念通道加权 RRF；
// semantic = BM25+语义近邻通道（构建期 BGE 蒸馏表，运行时零模型/零网络）。
// 后两档均为 opt-in：默认档变更须先过留出集泛化判定（台账#10）。
// 单一知识库源 knowledge.js；红线：不动引用白名单、不动红旗规则层。
import { search as bm25Search } from "./rag.js"
import { KNOWLEDGE_BASE, SYNONYMS, SYMPTOM_TO_KB, KB_BY_ID } from "./knowledge.js"
import { SEMANTIC_NEIGHBORS, SEMANTIC_META } from "./semantic_neighbors.js"

export const DEFAULT_RETRIEVER = "bm25"
export const RRF_K = 60
export const MAX_TOP_K = 10
export const SEMANTIC_NAME = "semantic"
// 语义通道运行参数：与 backend/app/retriever.py 同名同值，由 tests/semantic_guard.mjs 双向核对。
// ⚠️ 实测结论（2026-09-25 work/sweep_semantic_weights.mjs，7×3×3=54 组网格）：
//   留出集（20 例患者口语）**严格优于 bm25 的候选 = 0 组**；9 组与 bm25 逐位等值（权重过低⇒通道惰性，不是增益）；
//   其余 45 组劣化，最大 ΔMRR = −0.328（标定集同样无增益：bm25 在 50 例 top-5 已 100% 命中，无提升空间）。
//   根因：本通道是「查询无关」的条目↔条目邻接，只能重排名次；真正的语义召回需要对**查询**编码，
//         而 serverless JS 运行期无模型/无向量服务（同类开源项目均为此挂 Milvus/Chroma/FAISS/TEI）。
//   阈值路线亦不可行：漏检例 top1 分数 14.39/17.65 与命中例最低 12.41 区间重叠 ⇒「条件触发」判据不可解，
//         按 R236 补注③ 应改机制而非调参。
//   因此本档保持 **opt-in / 实验位**，默认仍 bm25，线上口径零改动；保留供语料扩容（55→200+）后复测，
//   与上方 adjacencyChannel（通道 C，标定权重为 0）同一处置惯例。
export const SEM_TOP = 5
export const SEM_FLOOR = 600 // 千分比，即 cos ≥ 0.60 才作为候选（存表地板 0.55 留余量便于改切档）
export const W_SEM = 0.3
export { SEMANTIC_META }

export const bm25Retriever = Object.freeze({
  name: DEFAULT_RETRIEVER,
  search(query, topK = 4, filters = {}) {
    void filters
    return bm25Search(query, topK)
  },
})

const docText = (item) => `${item.title || ""} ${item.condition || ""} ${Array.isArray(item.keywords) ? item.keywords.join(" ") : ""} ${item.text || ""}`

// 通道 B：概念通道。同义词组命中 → 组内任一词出现在条目文本即算；症状线索 → 直连映射。
// 与 BM25 的词面计分无关，因此能在「患者口语 vs 指南书面语」表述不一致时补召回。
export function conceptChannel(query) {
  const q = String(query ?? "").toLowerCase().slice(0, 500)
  if (!q.trim()) return []
  const weight = new Map()
  const bump = (id, w) => weight.set(id, (weight.get(id) || 0) + w)
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    const members = [canon, ...syns].map((s) => String(s).toLowerCase())
    if (!members.some((m) => q.includes(m))) continue
    for (const item of KNOWLEDGE_BASE) {
      const hay = docText(item).toLowerCase()
      const hits = members.reduce((n, m) => n + (m && hay.includes(m) ? 1 : 0), 0)
      if (hits) bump(item.id, hits)
    }
  }
  for (const [sym, ids] of Object.entries(SYMPTOM_TO_KB)) {
    if (!q.includes(sym.toLowerCase())) continue
    for (const id of ids) if (KB_BY_ID.has(id)) bump(id, 2)
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id)
}

// 通道 C：知识图近邻扩展。以 BM25 种子条目为锚，按共享 keywords 数（≥2）扩出同域鉴别项。
export function adjacencyChannel(seedIds, maxOut = 10) {
  const seeds = (seedIds || []).slice(0, 5).map((id) => KB_BY_ID.get(id)).filter(Boolean)
  if (!seeds.length) return []
  const seedSet = new Set(seeds.map((s) => s.id))
  const weight = new Map()
  for (const item of KNOWLEDGE_BASE) {
    if (seedSet.has(item.id)) continue
    const kw = new Set(item.keywords || [])
    let shared = 0
    for (const seed of seeds) {
      let inSeed = 0
      for (const k of seed.keywords || []) if (kw.has(k)) inSeed++
      if (inSeed >= 2) shared += inSeed
      else if (inSeed === 1 && seed.scope === item.scope) shared += 1
    }
    if (shared) weight.set(item.id, shared)
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, maxOut).map(([id]) => id)
}

// Reciprocal Rank Fusion（加权）：只用名次不用原始分，规避 BM25 与概念计数不同量纲的归一问题。
// 权重由 work/sweep_hybrid_weights.mjs 在 50 例口语化 silver 集上标定（2026-09-24 实测）：
//   等权 RRF 会让概念通道挤掉词面强相关项（recall@5 0.85→0.81、MRR 0.867→0.634），故降权并截断通道长度。
//   w_concept=0.3 + top5 时 recall@5 0.850→0.870、红旗子集 0.848→0.891，代价 MRR 0.867→0.825。
//   近邻通道在本网格上最优权重为 0（无增益），故不进融合，仅保留函数供后续语料扩容复测。
//   留出集复测（2026-09-24，tests/fixtures/retrieval_holdout.json 20 例患者口语）：ΔR@5=0、MRR −1.3pt、红旗子集持平——标定增益未泛化，维持 opt-in、默认 bm25。
const W_BM25 = 1
const W_CONCEPT = 0.3
export const CONCEPT_TOP = 5

export function rrfFuse(channels, topK = 4) {
  const acc = new Map()
  for (const { list, weight } of channels) {
    ;(list || []).forEach((id, rank) => {
      if (!KB_BY_ID.has(id)) return
      acc.set(id, (acc.get(id) || 0) + weight / (RRF_K + rank + 1))
    })
  }
  return [...acc.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topK)
    .map(([id, score]) => ({ ...(KB_BY_ID.get(id) || {}), id, score }))
}

export const hybridRetriever = Object.freeze({
  name: "hybrid",
  search(query, topK = 4, filters = {}) {
    void filters
    const k = Math.max(1, Math.min(Number.isFinite(+topK) ? Math.floor(+topK) : 4, 10))
    const bm = bm25Search(query, 10).map((e) => e.id)
    const fused = rrfFuse([
      { list: bm, weight: W_BM25 },
      { list: conceptChannel(query).slice(0, CONCEPT_TOP), weight: W_CONCEPT },
    ], k)
    return fused.map((e) => ({
      id: e.id, title: e.title, source: e.source, year: e.year, url: e.url,
      scope: e.scope, section: e.section, text: e.text, icd: e.icd ?? null,
      score: Math.round(e.score * 1e6) / 1e6,
    }))
  },
})

// 通道 D：语义近邻扩展。以 BM25 种子为锚，查构建期蒸馏的余弦邻接表（BGE-small-zh-v1.5，离线算好）。
// 与通道 C（共享 keywords 计数）的本质区别：信号来自 512 维语义相似度而非词面重叠，
// 因此能接住「患者口语 ↔ 指南书面语」用词完全不同但临床同域的情形；运行时零模型、零网络（纯查表）。
// 千分比整数存储 → JS/Py 两侧取值与排序完全一致；tie-break 用 id 升序，与 rrfFuse 同规则。
export function semanticChannel(seedIds, top = SEM_TOP, floorPerMille = SEM_FLOOR) {
  const seeds = (seedIds || []).slice(0, 5)
  if (!seeds.length) return []
  const seedSet = new Set(seeds)
  const weight = new Map()
  for (const sid of seeds) {
    for (const [nid, perMille] of SEMANTIC_NEIGHBORS[sid] || []) {
      if (seedSet.has(nid) || !KB_BY_ID.has(nid) || perMille < floorPerMille) continue
      weight.set(nid, (weight.get(nid) || 0) + perMille)
    }
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([id]) => id)
}

export const semanticRetriever = Object.freeze({
  name: SEMANTIC_NAME,
  search(query, topK = 4, filters = {}) {
    void filters
    const k = Math.max(1, Math.min(Number.isFinite(+topK) ? Math.floor(+topK) : 4, MAX_TOP_K))
    const bm = bm25Search(query, 10).map((e) => e.id)
    const fused = rrfFuse([
      { list: bm, weight: W_BM25 },
      { list: semanticChannel(bm), weight: W_SEM },
    ], k)
    return fused.map((e) => ({
      id: e.id, title: e.title, source: e.source, year: e.year, url: e.url,
      scope: e.scope, section: e.section, text: e.text, icd: e.icd ?? null,
      score: Math.round(e.score * 1e6) / 1e6,
    }))
  },
})
const RETRIEVERS = Object.freeze({
  [DEFAULT_RETRIEVER]: bm25Retriever,
  hybrid: hybridRetriever,
  [SEMANTIC_NAME]: semanticRetriever,
})

export function getRetriever(name = DEFAULT_RETRIEVER) {
  const key = String(name || DEFAULT_RETRIEVER).trim().toLowerCase()
  const retriever = RETRIEVERS[key]
  if (!retriever) throw new Error(`unsupported retriever: ${key}`)
  return retriever
}
