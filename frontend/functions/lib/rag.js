// ============================================================
// RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权
// 单一知识库源：knowledge.js（带元数据）
// 输出统一 EvidenceItem：{ id, title, source, year, url, scope, section, text, score }
// ============================================================
import { KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB, KB_BY_ID, KB_ID_SET } from "./knowledge.js"

const K1 = 1.5
const B = 0.75
const MAX_QUERY_LEN = 500
const MAX_TOP_K = 10

const normalize = (s) => String(s ?? "").toLowerCase().slice(0, 2000)

// 中文分词：双字滑窗 + 单字兜底（无外部分词依赖，适配 Workers 运行时）
const PUNCT_RE = /[\s\p{P}\p{S}]/gu
function tokenize(text) {
  const t = (text || "").replace(PUNCT_RE, "")
  const toks = []
  for (let i = 0; i < t.length; i++) {
    toks.push(t[i])
    if (i < t.length - 1) toks.push(t.slice(i, i + 2))
  }
  return toks
}

// 同义词扩展：命中规范词则把整组同义词并入查询（去重去自身，避免重复加权）
function expandQuery(query) {
  const q = normalize(query)
  const extra = new Set()
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    const hitCanon = q.includes(canon.toLowerCase())
    const hitSyn = syns.some((s) => q.includes(String(s).toLowerCase()))
    if (hitCanon || hitSyn) {
      for (const w of [canon, ...syns]) {
        const lw = String(w).toLowerCase()
        if (!q.includes(lw)) extra.add(w)
      }
    }
  }
  return [...extra]
}

// 预建倒排索引（模块加载时一次；缺字段守卫防单条脏数据拖崩全索引）
const index = (() => {
  const docs = KNOWLEDGE_BASE.map((item) => ({ id: item.id, tf: {}, len: 0, raw: item }))
  const df = {}
  let totalLen = 0
  for (const d of docs) {
    const kw = Array.isArray(d.raw.keywords) ? d.raw.keywords.join(" ") : ""
    const toks = tokenize(`${d.raw.title || ""} ${kw} ${d.raw.text || ""} ${d.raw.condition || ""}`)
    d.len = toks.length
    totalLen += toks.length
    const seen = new Set()
    for (const tk of toks) {
      d.tf[tk] = (d.tf[tk] || 0) + 1
      if (!seen.has(tk)) { df[tk] = (df[tk] || 0) + 1; seen.add(tk) }
    }
  }
  return { docs, df, N: docs.length, avgdl: totalLen / (docs.length || 1) }
})();

function evidenceOf(item, score) {
  return {
    id: item.id, title: item.title, source: item.source, year: item.year,
    url: item.url, scope: item.scope, section: item.section, text: item.text,
    icd: item.icd ?? null,
    score: Math.round(score * 1000) / 1000,
  }
}

// BM25 主检索
export function search(query, topK = 4) {
  if (!query || !String(query).trim()) return []
  const k = Math.max(1, Math.min(Number.isFinite(+topK) ? Math.floor(+topK) : 4, MAX_TOP_K))
  const q = normalize(query).slice(0, MAX_QUERY_LEN)
  const qtoks = tokenize(q)
  // 同义词按词独立分词后并入（避免 join("") 产生跨词伪 bigram）
  const expandedToks = []
  for (const w of expandQuery(q)) {
    for (const t of tokenize(w)) expandedToks.push(t)
  }
  const allQ = [...qtoks, ...expandedToks]

  // 红旗命中一次算好（原逻辑每 doc 重算 32 次 includes）
  const qLower = q.toLowerCase()
  const hitFlags = RED_FLAG_KEYWORDS.filter((kw) => qLower.includes(String(kw).toLowerCase()))
  const flagDocHits = new Map()
  if (hitFlags.length) {
    for (const d of index.docs) {
      const text = `${d.raw.text || ""}`.toLowerCase()
      let n = 0
      for (const kw of hitFlags) if (text.includes(String(kw).toLowerCase())) n++
      if (n) flagDocHits.set(d.id, n)
    }
  }

  const scores = index.docs.map((d) => {
    let s = 0
    for (const q of allQ) {
      const f = d.tf[q] || 0
      if (!f) continue
      const idf = Math.log(1 + (index.N - (index.df[q] || 0) + 0.5) / ((index.df[q] || 0) + 0.5))
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgdl)))
    }
    // 红旗词共现加权
    const n = flagDocHits.get(d.id)
    if (n) s += 2 * n
    return { doc: d, s }
  })
  scores.sort((a, b) => b.s - a.s)
  return scores.filter((x) => x.s > 0).slice(0, k).map((x) => evidenceOf(x.doc.raw, x.s))
}

// 症状线索 → 关联证据（确定性降级映射用，不依赖打分）
export function evidenceForSymptoms(symptoms) {
  if (!Array.isArray(symptoms) || !symptoms.length) return []
  const ids = new Set()
  const canons = Object.keys(SYMPTOM_TO_KB)
  for (const raw of symptoms) {
    const s = String(raw ?? "")
    if (!s) continue
    for (const canon of canons) {
      if (s.includes(canon)) {
        for (const id of SYMPTOM_TO_KB[canon] || []) ids.add(id)
      }
    }
    const direct = SYMPTOM_TO_KB[s]
    if (direct) direct.forEach((id) => ids.add(id))
  }
  const out = []
  for (const id of ids) {
    const k = KB_BY_ID.get(id)
    if (k) out.push(evidenceOf(k, 0))
  }
  return out
}

// 按 id 取证据（校验 LLM 引用的 evidence_id 是否真实存在）
export function evidenceByIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return []
  const set = new Set(ids)
  const out = []
  for (const id of set) {
    const k = KB_BY_ID.get(id)
    if (k) out.push(evidenceOf(k, 0))
  }
  return out
}

export function hasEvidence(id) {
  return typeof id === "string" && KB_ID_SET.has(id)
}
