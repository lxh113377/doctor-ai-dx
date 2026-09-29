// 引用落地性探针（第七十五轮，看守件：不进 npm test、只报不拦）
// 轴＝对标 `vibrantlabsai/ragas` 的 QuotedSpansAlignment（其文档明写该指标抓的是
//   "citation drift where quoted phrases in the answer are unsupported"，输入只有 response +
//   retrieved_contexts，零 LLM、零 gold）。我方引用白名单此前只证「id 在场」（hasEvidence），
//   不证「这条结论被它引的那条证据支撑」——两件事差一个语义层。
// 为什么先做成探针而不是闸：第一次跑出来的分布没人量过，直接钉阈值就是逼虚报（R236 补注③：
//   标定前先测两侧边界值）。本件产的两侧读数——自证引用 vs 刻意错配引用——就是下一轮的标定依据。
// 取数面（声明清楚，禁把盲区读成零违规）：
//   1) 本件跑在 rule-fallback（零密钥、零网络、确定性）上，能测「诊断名/鉴别条目 ⇄ 其所引 KB 条目」；
//   2) **测不到** engine.js 的回填通道（validateDiagnosis 里 LLM 未挂引用时回填全局检索证据）——
//      那条只在 live 面触发，需要一次带 Key 的 live 跑才能落数，故此处如实印 blind 行而非宣称全绿。
// 复算：node frontend/tests/grounding_probe.mjs
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildDiagnosis } from "../functions/lib/engine.js"
import { KNOWLEDGE_BASE, KB_BY_ID } from "../functions/lib/knowledge.js"
import { supportRatio, MIN_SPAN } from "./grounding_ruler.mjs"

const ROT = 7 // 错配对照的偏移量：取常量而非随机，保证两次跑逐字节同读数

function textOf(id) {
  const k = KB_BY_ID.get(id)
  if (!k) return null
  return `${k.title || ""} ${k.condition || ""} ${k.text || ""}`
}

const casesPath = fileURLToPath(new URL("../tests/fixtures/eval_cases.json", import.meta.url))
const suite = JSON.parse(readFileSync(casesPath, "utf8"))
const cases = Array.isArray(suite.cases) ? suite.cases : []
if (cases.length === 0) {
  console.log(`FAIL :: 用例取到 0 例（${casesPath}）⇒ 分母为空，绝不记绿`)
  console.log("[GATE:grounding-empty]")
  process.exit(2)
}
if (KNOWLEDGE_BASE.length < 2) {
  console.log(`FAIL :: 知识库只有 ${KNOWLEDGE_BASE.length} 条，错配对照造不出来 ⇒ 判别力不可判`)
  console.log("[GATE:grounding-empty]")
  process.exit(2)
}

const env = {} // 无 Key ⇒ rule-fallback，读数确定
const items = []
const control = []
let skipped = 0

for (let ci = 0; ci < cases.length; ci++) {
  const c = cases[ci]
  const history = (c.answers || []).map((a) => ({ role: "user", content: a }))
  const dx = await buildDiagnosis(c.case_id || "c1", history, env)
  if (dx.abstain === true) { skipped++; continue }
  const rows = [
    ...(dx.primary || []).map((p) => ({ kind: "primary", name: p && p.name, note: (p && p.reasons || []).join(""), ev: (p && p.evidence_ids) || [] })),
    ...(dx.differential || []).map((d) => ({ kind: "diff", name: d && d.name, note: (d && d.note) || "", ev: (d && d.evidence_ids) || [] })),
  ]
  for (const r of rows) {
    const cited = r.ev.map(textOf).filter(Boolean)
    if (!cited.length) { skipped++; continue } // 无引用＝无从谈落地，单列计数而不是记 0 拉低均值
    // 两个口径分开量，混在一起就分不清「引用挂错条」与「理由引患者原话」——
    // 后者不是缺陷（ruleDiagnosis 的 reasons 本来就是 transcript），把它算进比值会造出假缺陷（本件首跑实测踩过）。
    const nm = supportRatio(r.name || "", cited)
    const full = supportRatio(`${r.name || ""}${r.note}`, cited)
    if (nm.ratio === null) { skipped++; continue }
    items.push({ case: c.id, scene: c.scene, kind: r.kind, name: r.name, ids: r.ev.slice(), ratio: nm.ratio, spans: nm.spans, hit: nm.hit, full_ratio: full.ratio })
    // 对照：把所引条目整批换成「不在其引用列表里」的另一批（偏移取序，确定性）
    const own = new Set(r.ev)
    const alt = KNOWLEDGE_BASE.map((k) => k.id).filter((id) => !own.has(id))
    const pick = []
    for (let j = 0; j < Math.min(r.ev.length, alt.length); j++) pick.push(alt[(ci * MIN_SPAN + j * ROT) % alt.length])
    const mc = supportRatio(r.name || "", pick.map(textOf).filter(Boolean))
    if (mc.ratio !== null) control.push({ ...mc, name: r.name })
  }
}

const mean = (arr, key) => (arr.length ? arr.reduce((a, x) => a + x[key], 0) / arr.length : null)
const mSelf = mean(items, "ratio")
const mCtl = mean(control, "ratio")
const mFull = mean(items.filter((x) => x.full_ratio !== null), "full_ratio")
if (items.length === 0 || control.length === 0) {
  console.log("FAIL :: 有效样本为 0（自证或对照面没取到数）⇒ 这不是通过")
  console.log("[GATE:grounding-empty]")
  process.exit(2)
}

const worst = [...items].sort((a, b) => a.ratio - b.ratio).slice(0, 5)
const fmt = (v) => (v === null ? "n/a" : v.toFixed(3))
console.log("== 引用落地性探针（rule-fallback 面，零 LLM 零网络）==")
console.log(`取数面：用例 ${cases.length} 例｜计分条目 ${items.length} 条｜对照条目 ${control.length} 条｜跳过 ${skipped} 条（弃权/无引用）`)
console.log(`口径A 诊断名⇄所引条目（引用挂错条的信号）：mean=${fmt(mSelf)}`)
console.log(`口径B 诊断名+处置文本⇄所引条目（ragas span 同形）：mean=${fmt(mFull)}`)
console.log(`对照（刻意错配到别的条目）：mean=${fmt(mCtl)}｜A-对照差=${fmt(mSelf - mCtl)}`)
const low = items.filter((x) => x.ratio < 0.34).length
console.log(`口径A 低于 0.34：${low}/${items.length}（阈值暂只作分布读数不作闸——两侧边界刚由本件量出，钉闸前须先定「低支撑是否等于挂错条」的逐例判定）`)
console.log("口径A 最不利 5 条：")
for (const w of worst) console.log(`  ${w.case}/${w.kind} 「${String(w.name).slice(0, 24)}」→ ${w.ids.join(",")} ratio=${w.ratio.toFixed(3)} (${w.hit}/${w.spans}) 全文口径=${w.full_ratio.toFixed(3)}`)
console.log("盲区（如实报，不得读成零违规）：engine.js 回填通道（LLM 未挂引用时回填全局检索证据）只在 live 面触发，本件取不到数。")

// 判别力是唯一硬判据：尺若分不清「真引用」与「刻意错配」，那它量到的任何数都不作数。
const discriminating = mSelf > mCtl
console.log(discriminating
  ? `[GATE:grounding-discriminating] 自证-错配差 ${fmt(mSelf - mCtl)} > 0 ⇒ 这把尺有方向`
  : `[GATE:grounding-blind] 自证 ${fmt(mSelf)} 不高于错配 ${fmt(mCtl)} ⇒ 尺无判别力，读数不得用于标定`)
process.exit(discriminating ? 0 : 1)
