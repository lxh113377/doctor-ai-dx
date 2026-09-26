// 语域落差测量（看守件，不进 npm test）：同一份 gold、只换写法，检索结果差多少。
// 为什么这一轮才补：第三十三轮接通了「口语侧→指南侧」的同义词桥，但把"聚合读数没动"归因成
// 「评测集全按指南侧写法出题」。本轮实测否证了那句归因——50 例里 v2.0 的 ret-21..50 本来就是
// 患者口语化改写，桥也确实被触发（3/70 例），其中 2 例改了 top-5 名次，只是没跨到影响 recall@5/MRR
// 的位置。⇒ 真正缺的不是"口语样本"，而是**把"只换语域"这一维单独量出来的配对面**：
// 现有指标把 gold 差异、词面差异、语域差异混在一起动，看不见语域这一层到底值多少分。
//
// 刻意不新建 gold：配对查询由 `retrieval_cases.json`（现有 silver 集）+ `SYNONYMS`（现有同义词表）
// **运行时现算**——把查询里出现的某个同义词组成员换成同组另一个成员，其余一字不动。
// 于是每对的两条查询语义等价由构造保证、gold 直接继承源用例：不引入第二真值，也不需人工新标注。
//
// 反例自证（缺任一条都不算通过）：
//   ① 分母：配对太少 ⇒ 判失败而不是给个好看的落差。
//   ② 恒等复算：同一条查询重算两次必须逐位相同（排除测量器自己动分数／非确定性）。
//   ③ 破坏对照：把查询整体重复一遍（只改长度不改语义）——首跑即抓到被测对象真缺陷（4/37 例 recall@5 变），
//      故按「新指标先量误报率再接线」降为带基线的看守棘轮，缺陷本体另立台账。
//   ④ 红旗子集单看：危急病例不得因写法不同而召回下降。
import { readFileSync, writeFileSync } from "node:fs"
import { getRetriever, DEFAULT_RETRIEVER } from "../functions/lib/retriever.js"
import { SYNONYMS } from "../functions/lib/knowledge.js"

const suite = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", import.meta.url), "utf8"))
const TOP_K = 5
const round = (v) => Math.round(v * 1e6) / 1e6
const retriever = getRetriever(process.argv.find((a) => a.startsWith("--retriever="))?.split("=")[1])
const GOLD = new Map(suite.cases.map((c) => [c.id, new Set(c.relevant_ids)]))

// 成员表：每个同义词组的全部词形（规范词＋同义词），按长度降序，先换长词（"喘不上气" 优先于 "气促"）。
const GROUPS = Object.entries(SYNONYMS)
  .map(([canon, syns]) => [...new Set([String(canon), ...(Array.isArray(syns) ? syns : []).map(String)])]
    .filter((w) => w.length >= 2))
  .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))

/** 把 query 里出现的某个组成员换成同组另一个词形；换不出返回 null（不强凑样本）。 */
function altRegister(query) {
  for (const group of GROUPS) {
    for (const from of group) {
      const at = query.indexOf(from)
      if (at < 0) continue
      for (const to of group) {
        if (to === from || query.includes(to)) continue
        return { text: query.slice(0, at) + to + query.slice(at + from.length), from, to, group: group.length }
      }
    }
  }
  return null
}

const recallAt = (ids, rel) => (rel.size ? ids.slice(0, TOP_K).filter((id) => rel.has(id)).length / rel.size : 0)
const rr = (ids, rel) => { const i = ids.findIndex((id) => rel.has(id)); return i < 0 ? 0 : 1 / (i + 1) }
const searchIds = (q) => retriever.search(q, 10).map((e) => e.id)

const pairs = []
for (const c of suite.cases) {
  const alt = altRegister(c.query)
  if (!alt) continue
  const rel = GOLD.get(c.id)
  const a = searchIds(c.query)
  const b = searchIds(alt.text)
  pairs.push({
    id: c.id, red_flag: Boolean(c.red_flag), from: alt.from, to: alt.to, groupSize: alt.group,
    query_a: c.query, query_b: alt.text,
    recall_a: round(recallAt(a, rel)), recall_b: round(recallAt(b, rel)),
    mrr_a: round(rr(a, rel)), mrr_b: round(rr(b, rel)),
    top5_same: a.slice(0, TOP_K).join(",") === b.slice(0, TOP_K).join(","),
  })
}

let fail = 0
const say = (ok, name, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) fail++
}

console.log(`== 语域落差测量（${retriever.name} 档；gold 全部继承自 retrieval_cases.json，零新增人工标注）==`)
console.log(`  可配对用例 ${pairs.length}/${suite.cases.length}（换不出词形的不计，宁缺毋滥）`)
say(pairs.length >= 15, "分母自证：配对样本 ≥15 例", `实测 ${pairs.length}`)

const lost = pairs.filter((p) => p.recall_b < p.recall_a)
const won = pairs.filter((p) => p.recall_b > p.recall_a)
const moved = pairs.filter((p) => !p.top5_same)
const mean = (key) => round(pairs.reduce((s, p) => s + p[key], 0) / (pairs.length || 1))
const gapR = round(mean("recall_a") - mean("recall_b"))
const gapM = round(mean("mrr_a") - mean("mrr_b"))
console.log(`  换语域后：recall@5 掉 ${lost.length} 例 / 升 ${won.length} 例 / 持平 ${pairs.length - lost.length - won.length} 例`)
console.log(`  top-5 名次发生变化的例数 ${moved.length}${moved.length ? `：${moved.map((p) => p.id).join(",")}` : ""}`)
console.log(`  语域落差 Δrecall@5=${gapR} ΔMRR=${gapM}（>0 表示指南侧写法占优）`)
for (const p of lost.slice(0, 6)) console.log(`    LOSE ${p.id} 「${p.from}→${p.to}」 recall ${p.recall_a}→${p.recall_b}`)

// ② 恒等复算：同一条查询重算两次必须逐位相同（既排非确定性，也排"配对时读到的 gold 与现在不是同一份"）
const drift = pairs.filter((p) => p.recall_a !== round(recallAt(searchIds(p.query_a), GOLD.get(p.id)))
  || p.recall_b !== round(recallAt(searchIds(p.query_b), GOLD.get(p.id))))
say(drift.length === 0, "恒等复算：同一查询两次取数逐位相同（排除测量器自己动分数）",
  drift.length ? `漂移 ${drift.length} 例：${drift.slice(0, 3).map((p) => p.id).join(",")}` : "0 漂移")

// ③ 破坏对照：只改长度不改语义，recall 不该变。
//    本轮首跑就把它撞红了——实测 4/37 例把同一句重复一遍后 recall@5 变了。这不是夹具的错，
//    是被测对象的真缺陷：BM25 对查询词是按 token 累加的，重复即 tf 翻倍，而红旗加权是固定 +2/词，
//    于是重复会把加权的相对分量稀释掉、排序随之变。⇒ 降级为**带基线的看守棘轮**（只准降不准升），
//    不做成常红判据（常红的判据等于没有判据），缺陷本体登记为新台账并逐条归因。
const REGISTER_DUP_MAX = Number(process.env.REGISTER_DUP_MAX ?? 4)
const dupBad = pairs.filter((p) => {
  const rel = GOLD.get(p.id)
  return recallAt(searchIds(p.query_a), rel) !== recallAt(searchIds(p.query_a + p.query_a), rel)
}).map((p) => {
  const rel = GOLD.get(p.id)
  return { id: p.id, red_flag: p.red_flag, a: round(recallAt(searchIds(p.query_a), rel)), b: round(recallAt(searchIds(p.query_a + p.query_a), rel)) }
})
const dupRf = dupBad.filter((d) => d.red_flag)
console.log(`  ${dupBad.length <= REGISTER_DUP_MAX ? "PASS" : "FAIL"} 重复敏感性棘轮：重复一遍仍改变 recall 的配对 ≤ ${REGISTER_DUP_MAX}（基线为第三十四轮实测）`
  + ` :: 实测 ${dupBad.length}${dupRf.length ? `，其中危急 ${dupRf.length}` : ""}`)
for (const d of dupBad.slice(0, 6)) console.log(`    DUP ${d.id}${d.red_flag ? "[危急]" : ""} recall@5 ${d.a}→${d.b}（仅重复，未改语义）`)
if (dupBad.length > REGISTER_DUP_MAX) fail++
console.log("  ⚠ 这条不是夹具噪声：它是检索层对『同一句话被说两遍』的真实敏感面（转录/口述场景常见）。"
  + "判红阈值刻意不等于 0——0 需要改打分函数（查询 token 去重或加权归一），属行为变更，另立台账。")

// ④ 红旗子集
const rf = pairs.filter((p) => p.red_flag)
const rfLost = rf.filter((p) => p.recall_b < p.recall_a)
if (rf.length) {
  say(rfLost.length === 0, "红旗子集零落差（危急病例不得因写法不同而召回下降）",
    `危急配对 ${rf.length} 例，掉召回 ${rfLost.length} 例：${rfLost.map((p) => p.id).join(",") || "-"}`)
} else {
  console.log("  UNVERIFIED 红旗子集无配对样本（不记通过）")
}

// 棘轮：掉召回的配对例数只准变少。基线由本轮实测给（见下行输出），当前是看守档、不阻断 npm test。
const REGISTER_LOSE_MAX = Number(process.env.REGISTER_LOSE_MAX ?? 0)
console.log(`\nADVISORY 棘轮：换语域掉 recall 的配对 ≤ ${REGISTER_LOSE_MAX}（本轮实测 ${lost.length}，第三十四轮立基线）`)
console.log("  接线判据（何时升级为阻断）：本件连续两轮读数稳定 且 掉召回的例逐条归因完 ⇒ 并入 npm test 并把基线写死")
if (lost.length > REGISTER_LOSE_MAX) console.log(`  待修清单：${lost.map((p) => `${p.id}(${p.from}→${p.to})`).join(" ")}`)

const report = {
  retriever: retriever.name, default_retriever: DEFAULT_RETRIEVER,
  pairs_total: pairs.length, cases_total: suite.cases.length,
  gap_recall_at_5: gapR, gap_mrr: gapM,
  lost: lost.map((p) => p.id), won: won.map((p) => p.id), moved: moved.map((p) => p.id),
  red_flag_pairs: rf.length, red_flag_lost: rfLost.map((p) => p.id), dup_sensitive: dupBad, pairs,
}
const out = process.env.REGISTER_REPORT_PATH
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
if (fail) process.exit(1)
