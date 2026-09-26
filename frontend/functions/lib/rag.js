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

// 非重叠出现次数（不用 RegExp：加权词表里有含正则元字符的词形，构造一次就埋一个死判据）。
function countOccurrences(hay, needle) {
  const n = String(needle ?? "")
  if (!n) return 0
  let c = 0
  let i = hay.indexOf(n)
  while (i >= 0) {
    c += 1
    i = hay.indexOf(n, i + n.length)
  }
  return c
}

// 同义词扩展：命中规范词则把整组同义词并入查询（去重去自身，避免重复加权）。
// 返回 词形 → 权重，权重 = 产生它的那些组里最大的「触发词重复度」（该词形在原查询里非重叠出现几次）。
// 为什么带权重（台账 #102 的正解，第三十六轮）：原始 token 通道天然是个多重集，整句重复一遍就逐个翻倍；
// 扩展通道若只追加一次，靠它得分的条目就被相对稀释、排序随重复而变。让两通道同尺度后，
// 重复使整个查询向量等比放大 ⇒ 排序不变。未重复时权重恒为 1，与改动前逐位相同（70 例 gold 实测全为 1）。
function expandQuery(query) {
  const q = normalize(query)
  const extra = new Map()
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    const forms = [canon, ...(Array.isArray(syns) ? syns : [])].map((w) => String(w).toLowerCase())
    const hitSyn = forms.some((f) => q.includes(f))
    if (!hitSyn) continue
    const mult = Math.max(1, ...forms.map((f) => countOccurrences(q, f)))
    for (const w of [canon, ...syns]) {
      const lw = String(w).toLowerCase()
      if (q.includes(lw)) continue
      extra.set(w, Math.max(extra.get(w) || 0, mult))
    }
  }
  return extra
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

// 该查询「够得着」的加权词：原查询 ∪ 同义词扩展词形，再与加权词表取交。
// 单独导出是为了让判据能直接问「这条口语查询到底加到了哪几个权」——此前这条面只在 search 内部
// 存在，守卫要验它就得把 BM25 打分重写一遍（等于造第二真值，第三十三轮按实测否决）。
export function reachableFlagTerms(query) {
  if (!query || !String(query).trim()) return []
  return queryView(query).hitFlags
}

// 加权项给每篇文档实际加了多少分（含查询侧重复度）。导出理由与 reachableFlagTerms 同源：
// 判据要问"这条加性项值多少分"，就得要么把打分重写一遍（第二真值，第三十三轮按实测否决），
// 要么由权威面把这一项交出来——这里选后者，且与 search 内部用的是**同一个**函数。
export function flagContributions(query) {
  if (!query || !String(query).trim()) return new Map()
  const { hitFlags, flagWeights } = queryView(query)
  return flagContrib(hitFlags, flagWeights)
}

function flagContrib(hitFlags, flagWeights) {
  const out = new Map()
  if (!hitFlags.length) return out
  for (const d of index.docs) {
    const text = `${d.raw.text || ""}`.toLowerCase()
    let n = 0
    for (const kw of hitFlags) if (text.includes(String(kw).toLowerCase())) n += flagWeights.get(kw) || 0
    if (n) out.set(d.id, 2 * n)
  }
  return out
}

// 同一个查询视图：归一文本、扩展词形、够得着的加权词。
// 匹配面 = 原查询 ∪ 同义词扩展出的词形：加权词表取指南侧词形（「出汗」「抽搐」），
// 输入常是口语侧词形（「冒冷汗」「高热惊厥」），把两侧连起来的桥就是同义词表。
// 用 \u0001 连接而非直接拼接，防止跨条目边界伪造一次命中。
function queryView(query) {
  const q = normalize(query).slice(0, MAX_QUERY_LEN)
  const expWeights = expandQuery(q)
  const expanded = [...expWeights.keys()]
  const flagHay = [q, ...expanded.map((w) => String(w).toLowerCase())].join("\u0001")
  const hitFlags = RED_FLAG_KEYWORDS.filter((kw) => flagHay.includes(String(kw).toLowerCase()))
  // 加权词的查询侧重复度：原查询里非重叠出现几次；只靠扩展桥够着的词取桥那侧词形的权重。
  // 两侧都够着时取 max 而非 sum——未重复时恒为 1，与改动前「命中即计分一次」逐位相同。
  const flagWeights = new Map(hitFlags.map((kw) => {
    const low = String(kw).toLowerCase()
    let m = countOccurrences(q, low)
    for (const [w, wt] of expWeights) if (wt > m && String(w).toLowerCase().includes(low)) m = wt
    return [kw, m]
  }))
  return { q, expanded, expWeights, hitFlags, flagWeights }
}

// BM25 主检索
export function search(query, topK = 4) {
  if (!query || !String(query).trim()) return []
  const k = Math.max(1, Math.min(Number.isFinite(+topK) ? Math.floor(+topK) : 4, MAX_TOP_K))
  const { q, expWeights, hitFlags, flagWeights } = queryView(query)
  const qtoks = tokenize(q)
  // 同义词按词独立分词后并入（避免 join("") 产生跨词伪 bigram）；按触发词重复度重复该词形的 token，
  // 使扩展通道与原始通道同尺度（台账 #102）。
  const expandedToks = []
  for (const [w, wt] of expWeights) {
    const toks = tokenize(w)
    for (let m = 0; m < Math.max(1, wt); m++) {
      for (const t of toks) expandedToks.push(t)
    }
  }
  const allQ = [...qtoks, ...expandedToks]

  // 红旗命中一次算好（取自共用视图，不在此重复计算）；计分次数取查询侧重复度，不再按「命中一次」封顶。
  // 实现与对外导出的 flagContributions 是同一个函数 ⇒ 判据消融出来的分量与真打分必然同源。
  const flagDocHits = flagContrib(hitFlags, flagWeights)

  const scores = index.docs.map((d) => {
    let s = 0
    for (const q of allQ) {
      const f = d.tf[q] || 0
      if (!f) continue
      const idf = Math.log(1 + (index.N - (index.df[q] || 0) + 0.5) / ((index.df[q] || 0) + 0.5))
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgdl)))
    }
    // 红旗词共现加权（分量已由 flagContrib 算成 2·n）
    const c = flagDocHits.get(d.id)
    if (c) s += c
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

// ---------- 证据充分性 / 弃权第三态（第二十八轮，台账 #52）----------
// ABSTAIN_T 不是手调出来的：由 tests/ood_probe.mjs 在**当前语料 + 当前分词**下现场量出——
// max(域外 top1)=36.559 < min(危急域内 top1)=60.422，取其中点；probe 与本常量互为对账（改一处必判红另一处）。
// 同类实测形状：`dmustapha/triage-0` 用 `OFF_DOMAIN_THRESHOLD=0.84` 坐在实测间隙里并配 sane-band 守卫测试；
// `kheireddinedev00/Medico` 把 out_of_scope 的降级底写成数据（URGENT，"deliberate over-triage"）。
export const ABSTAIN_T = 48.491

/**
 * 红旗在场一律不弃权——`triage-0` 有三条"决定性体征禁止弃权"、`Medico` 明写"红旗不依赖量表验证人群"，
 * 两家的取舍都指向同一件事：漏报危险信号的代价远高于多说一句"信息不足"。
 */
export function answerability(evidence, flags) {
  const top = evidence && evidence.length ? evidence[0].score : 0
  if (Array.isArray(flags) && flags.length > 0) return { abstain: false, scope_status: "in-scope", top_score: top }
  if (!evidence || evidence.length === 0) return { abstain: true, scope_status: "out-of-scope", top_score: top }
  if (top < ABSTAIN_T) return { abstain: true, scope_status: "insufficient-information", top_score: top }
  return { abstain: false, scope_status: "in-scope", top_score: top }
}
