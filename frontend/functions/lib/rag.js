// ============================================================
// RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权
// 单一知识库源：knowledge.js（带元数据）
// 输出统一 EvidenceItem：{ id, title, source, year, url, scope, section, text, score }
// ============================================================
import { KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB } from "./knowledge.js"

const K1 = 1.5
const B = 0.75

// 中文分词：双字滑窗 + 单字兜底（无外部分词依赖，适配 Workers 运行时）
function tokenize(text) {
  const t = (text || "").replace(/\s+/g, "")
  const toks = []
  for (let i = 0; i < t.length; i++) {
    toks.push(t[i])
    if (i < t.length - 1) toks.push(t.slice(i, i + 2))
  }
  return toks
}

// 同义词扩展：命中规范词则把整组同义词并入查询
function expandQuery(query) {
  const extra = []
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    if (query.includes(canon)) extra.push(...syns)
    else if (syns.some((s) => query.includes(s))) extra.push(canon, ...syns)
  }
  return extra
}

// 预建倒排索引（模块加载时一次）
const index = (() => {
  const docs = KNOWLEDGE_BASE.map((item, i) => ({ id: item.id, tf: {}, len: 0, raw: item }))
  const df = {}
  let totalLen = 0
  for (const d of docs) {
    const toks = tokenize(d.raw.title + " " + d.raw.keywords.join(" ") + " " + d.raw.text + " " + d.raw.condition)
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
    score: Math.round(score * 1000) / 1000,
  }
}

// BM25 主检索
export function search(query, topK = 4) {
  if (!query || !query.trim()) return []
  const qtoks = tokenize(query)
  const expanded = tokenize(expandQuery(query).join(""))
  const allQ = [...qtoks, ...expanded]

  const scores = index.docs.map((d) => {
    let s = 0
    for (const q of allQ) {
      const f = d.tf[q] || 0
      if (!f) continue
      const idf = Math.log(1 + (index.N - (index.df[q] || 0) + 0.5) / ((index.df[q] || 0) + 0.5))
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgdl)))
    }
    // 红旗词共现加权
    for (const kw of RED_FLAG_KEYWORDS) {
      if (query.includes(kw) && d.raw.text.includes(kw)) s += 2
    }
    return { doc: d, s }
  })
  scores.sort((a, b) => b.s - a.s)
  return scores.filter((x) => x.s > 0).slice(0, topK).map((x) => evidenceOf(x.doc.raw, x.s))
}

// 症状线索 → 关联证据（确定性降级映射用，不依赖打分）
export function evidenceForSymptoms(symptoms) {
  const ids = new Set()
  for (const s of symptoms) {
    for (const canon of Object.keys(SYMPTOM_TO_KB)) {
      if (s.includes(canon) || SYMPTOM_TO_KB[canon]?.some(() => false)) {
        for (const id of SYMPTOM_TO_KB[canon]) ids.add(id)
      }
    }
    const direct = SYMPTOM_TO_KB[s]
    if (direct) direct.forEach((id) => ids.add(id))
  }
  return KNOWLEDGE_BASE.filter((k) => ids.has(k.id)).map((k) => evidenceOf(k, 0))
}

// 按 id 取证据（校验 LLM 引用的 evidence_id 是否真实存在）
export function evidenceByIds(ids) {
  const set = new Set(ids)
  return KNOWLEDGE_BASE.filter((k) => set.has(k.id)).map((k) => evidenceOf(k, 0))
}

export function hasEvidence(id) {
  return KNOWLEDGE_BASE.some((k) => k.id === id)
}
