// RAG 检索雏形（Jaccard 中文双字串重叠）——对应 backend/app/rag.py
import { KNOWLEDGE_BASE, RED_FLAG_KEYWORDS } from "./data.js"

const MIN_SOURCE_LEN = 16

function bigrams(text) {
  const t = text.replace(/\s/g, "")
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

export function search(query, topK = 3) {
  const q = bigrams(query)
  if (q.size === 0) return []
  const scored = []
  for (const item of KNOWLEDGE_BASE) {
    if (item.text.length < MIN_SOURCE_LEN) continue
    const t = bigrams(item.text)
    let inter = 0
    for (const g of q) if (t.has(g)) inter++
    const union = q.size + t.size - inter || 1
    let score = inter / union
    for (const kw of RED_FLAG_KEYWORDS) {
      if (query.includes(kw) && item.text.includes(kw)) score += 0.3
    }
    if (score > 0) scored.push({ ...item, score: Math.round(score * 1000) / 1000 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}