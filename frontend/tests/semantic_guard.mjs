// 语义邻接表门禁：表完整性 + 引用白名单 + 无自环 + 分数单调/取值域 + 对称一致 + 语料指纹防陈旧 + 双端常量一致 + 默认档未变。
// 为什么需要：semantic_neighbors.* 是**构建期产物**，知识库一改而忘记重跑构建器，表就会静默陈旧——
// 这类失效不会被评测抓到（检索仍能返回合法 id），只有拿语料指纹对账才拦得住（2026-09-25 实测设计要点）。
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE, KB_ID_SET } from "../functions/lib/knowledge.js"
import { SEMANTIC_NEIGHBORS, SEMANTIC_META } from "../functions/lib/semantic_neighbors.js"
import {
  DEFAULT_RETRIEVER, SEMANTIC_NAME, SEM_TOP, SEM_FLOOR, W_SEM, getRetriever, semanticChannel,
} from "../functions/lib/retriever.js"

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const docOf = (k) => `${k.title} ${k.condition || ""} ${(k.keywords || []).join(" ")} ${k.text}`
const corpusSha = () => {
  const payload = KNOWLEDGE_BASE.map((k) => ({ id: k.id, doc: docOf(k) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((r) => `${r.id}::=${r.doc}`).join("\n")
  return createHash("sha256").update(payload, "utf8").digest("hex")
}

// 判据本体：喂一张表返回问题清单（正样本应为空，反样本必须非空）
function scan(table, meta) {
  const problems = []
  const ids = new Set(Object.keys(table))
  if (ids.size !== KNOWLEDGE_BASE.length) problems.push(`key 数 ${ids.size} != 条目数 ${KNOWLEDGE_BASE.length}`)
  for (const k of KNOWLEDGE_BASE) if (!ids.has(k.id)) problems.push(`缺条目 ${k.id}（不得静默丢 key）`)
  for (const kid of ids) {
    if (!KB_ID_SET.has(kid)) problems.push(`表 key ${kid} 不在知识库`)
    const rows = table[kid]
    if (!Array.isArray(rows)) { problems.push(`${kid} 值非数组`); continue }
    if (rows.length > meta.topKeep) problems.push(`${kid} 邻数 ${rows.length} > topKeep ${meta.topKeep}`)
    let prev = Infinity
    for (const [nid, perMille] of rows) {
      if (nid === kid) problems.push(`${kid} 自环`)
      if (!KB_ID_SET.has(nid)) problems.push(`${kid} 邻居 ${nid} 越出引用白名单`)
      if (!Number.isInteger(perMille)) problems.push(`${kid} 分数非整数 ${perMille}`)
      if (perMille > 1000) problems.push(`${kid} 分数越上界 ${perMille}`)
      if (perMille < meta.minCos * meta.scoreScale) problems.push(`${kid} 分数低于存表地板 ${perMille}`)
      if (perMille > prev) problems.push(`${kid} 分数未降序（${prev} -> ${perMille}）`)
      prev = perMille
    }
    if (new Set(rows.map((r) => r[0])).size !== rows.length) problems.push(`${kid} 邻居重复`)
  }
  // 弱对称：余弦本身对称，截断可致单向缺失；但**双向都出现时分数必须相等**
  for (const [a, rows] of Object.entries(table)) {
    for (const [b, pm] of rows) {
      const back = (table[b] || []).find((r) => r[0] === a)
      if (back && back[1] !== pm) problems.push(`对称性破坏 ${a}-${b}: ${pm} vs ${back[1]}`)
    }
  }
  return problems
}

const liveProblems = scan(SEMANTIC_NEIGHBORS, SEMANTIC_META)
check("表结构与取值域全部合规（白名单内/无自环/降序/整数千分比）", liveProblems.length === 0, liveProblems.slice(0, 4).join(" | "))

const sha = corpusSha()
check("语料指纹与当前 knowledge.js 一致（防表陈旧）", sha === SEMANTIC_META.corpusSha256,
  `表内=${SEMANTIC_META.corpusSha256.slice(0, 16)} 实算=${sha.slice(0, 16)}`)
check("provenance 完整（模型/权重 SHA/维度/存表参数齐备）",
  SEMANTIC_META.modelId === "BAAI/bge-small-zh-v1.5" && /^[0-9a-f]{64}$/.test(SEMANTIC_META.modelSha256)
  && SEMANTIC_META.dim === 512 && SEMANTIC_META.scoreScale === 1000 && SEMANTIC_META.entries === KNOWLEDGE_BASE.length,
  JSON.stringify(SEMANTIC_META).slice(0, 160))

// 生成器必须是"算"而不是"抄"（第二十六轮）。产物头的 modelSha256 若来自手抄字面量，
// 那么换权重/改字符串都不会被任何判据发现——上面那条 provenance 检查只核 64 位十六进制**形状**。
// 这里对生成器源码本身下手：出现 `MODEL_SHA256 = "<64hex>"` 即判红；且必须真的存在计算函数。
const GEN = readFileSync(fileURLToPath(new URL("../../scripts/build_semantic_neighbors.py", import.meta.url)), "utf8")
const handCopied = [...GEN.matchAll(/^MODEL_SHA256\s*=\s*["'][0-9a-f]{64}["']/gm)]
check("生成器里没有手抄的权重指纹字面量（必须构建时实算）", handCopied.length === 0,
  handCopied.map((m) => m[0].slice(0, 40)).join(" | "))
check("生成器确实自行计算 sha256（函数在位且非恒假）",
  /def compute_model_sha256\(/.test(GEN) && /hashlib\.sha256\(/.test(GEN)
  && /找不到权重文件/.test(GEN), "缺 compute_model_sha256 或其 sha256/失败即中止逻辑")

const PY_META = readFileSync(fileURLToPath(new URL("../../backend/app/semantic_neighbors.py", import.meta.url)), "utf8")
for (const [k, v] of [["modelId", SEMANTIC_META.modelId], ["modelSha256", SEMANTIC_META.modelSha256], ["corpusSha256", SEMANTIC_META.corpusSha256]]) {
  check(`双端 provenance 同值：${k}`, PY_META.includes(String(v)))
}
const PY_TABLE = PY_META
const PY_RUNTIME = readFileSync(fileURLToPath(new URL("../../backend/app/retriever.py", import.meta.url)), "utf8")
check("双端运行常量同值",
  PY_RUNTIME.includes(`SEM_TOP = ${SEM_TOP}`) && PY_RUNTIME.includes(`SEM_FLOOR = ${SEM_FLOOR}`) && PY_RUNTIME.includes(`W_SEM = ${W_SEM}`),
  `JS: top=${SEM_TOP} floor=${SEM_FLOOR} w=${W_SEM}`)
// 双端表值核对：JS 是嵌套数组、Py 是元组，**序列化形态本就不同**，只能解析后比数据（不能比文本）
check("双端邻接表同值（抽样 8 条解析后逐项核对）", (() => {
  const keys = Object.keys(SEMANTIC_NEIGHBORS).sort().slice(0, 8)
  return keys.every((k) => {
    const seg = PY_TABLE.match(new RegExp(`"${k}": \\[(.*?)\\]`, "s"))
    if (!seg) return false
    const py = [...seg[1].matchAll(/\("([^"]+)",\s*(-?\d+)\)/g)].map((m) => [m[1], Number(m[2])])
    const js = SEMANTIC_NEIGHBORS[k]
    return py.length === js.length && py.every((row, i) => row[0] === js[i][0] && row[1] === js[i][1])
  })
})())
check("双端表条目数同值", (PY_TABLE.match(/^\s{4}"/gm) || []).length === Object.keys(SEMANTIC_NEIGHBORS).length,
  `py=${(PY_TABLE.match(/^\s{4}"/gm) || []).length} js=${Object.keys(SEMANTIC_NEIGHBORS).length}`)

check("红线：默认档仍 bm25（semantic 为 opt-in，线上口径零改动）",
  DEFAULT_RETRIEVER === "bm25" && getRetriever().name === "bm25" && getRetriever(SEMANTIC_NAME).name === "semantic")
check("semantic 档输出的每个 id 都在引用白名单内", (() => {
  const out = getRetriever("semantic").search("胸口闷得慌喘不上气肩膀还一串一串地疼", 5)
  return out.length > 0 && out.every((e) => KB_ID_SET.has(e.id))
})())
const seeds = ["kb-001", "kb-024"]
check("通道对空种子/未知种子不报错且返回数组",
  semanticChannel([]).length === 0 && semanticChannel(["kb-999"]).length === 0 && semanticChannel(seeds).length > 0)
check("floor 提高时候选单调不增", (() => {
  const loose = semanticChannel(seeds, 8, 550).length
  const tight = semanticChannel(seeds, 8, 800).length
  return tight <= loose
})())

// 反例实测：判据必须被违例喂红，否则「0 问题」只是没接线
const clone = () => JSON.parse(JSON.stringify(SEMANTIC_NEIGHBORS))
const poisons = [
  ["越出引用白名单的邻居 id", (t) => { t[Object.keys(t)[0]] = [["kb-999", 900], ...t[Object.keys(t)[0]].slice(0, 3)] }],
  ["自环", (t) => { const k = Object.keys(t)[0]; t[k] = [[k, 999], ...t[k].slice(0, 3)] }],
  ["分数未降序", (t) => { const k = Object.keys(t)[0]; t[k] = [[t[k][1][0], t[k][1][1]], [t[k][0][0], t[k][0][1]], ...t[k].slice(2)] }],
  ["分数越界（>1000）", (t) => { const k = Object.keys(t)[0]; t[k] = [[t[k][0][0], 1200], ...t[k].slice(1)] }],
  ["条目被静默丢弃", (t) => { delete t[Object.keys(t)[0]] }],
  ["对称性破坏", (t) => { const a = Object.keys(t)[0]; const [b] = t[a][0]; t[b] = t[b].map((r) => (r[0] === a ? [a, r[1] - 30] : r)) }],
  ["存表地板被击穿", (t) => { const k = Object.keys(t)[0]; t[k] = [[t[k][0][0], 100], ...t[k].slice(1)] }],
]
for (const [name, mutate] of poisons) {
  const bad = clone()
  mutate(bad)
  check(`反例可拦：${name}`, scan(bad, SEMANTIC_META).length > 0, "违例零命中=判据未接线")
}
check("对照组：当前表五类判据零命中（反例不是恒真）", liveProblems.length === 0)
check("反例可拦：篡改语料指纹", corpusSha() !== "0".repeat(64))

const counts = Object.values(SEMANTIC_NEIGHBORS).map((v) => v.length)
console.log(`\nSEMANTIC GUARD SUMMARY: entries=${Object.keys(SEMANTIC_NEIGHBORS).length} pairs=${counts.reduce((a, b) => a + b, 0)} avg=${(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1)} min=${Math.min(...counts)} max=${Math.max(...counts)} corpusSha=${SEMANTIC_META.corpusSha256.slice(0, 12)}`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
