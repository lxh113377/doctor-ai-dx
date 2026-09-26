// 台账 #102 的常驻硬判据（第三十六轮接线）：同一句话原样重复一遍，检索结果不得改变。
// 为什么这条从看守棘轮升成阻断：缺陷本体已按实测治好，不再是"阈值不可解"。
//   根因（第三十五轮归因）：原始 token 通道是多重集、整句重复即逐个翻倍，而同义词扩展通道只追加一次、
//   红旗加权是固定 +2/词 ⇒ 两通道与 BM25 不同量纲，重复把它们的相对分量稀释掉、排序随之变。
//   治法：扩展词按「触发词重复度」重复计分、加权词按查询侧重复度计分（双端同改），整个查询向量等比放大。
// 反例自证（变异体实测，2026-09-27 05:4x，把缩放改回"固定追加一次 + 加权固定 +1"后）：
//   top-5 名次改变 42/77 条、分数恰 2× 仅剩 22/77 条 ⇒ 本判据有能力判红，不是恒绿装饰。
// 覆盖面：70 例 gold（50 silver + 20 留出）＋ 7 条口语桥查询。gold 全部重复度为 1（实测 0/70 用例
//   含重复触发词），所以本件与检索读数判据互不干扰：改动前后 70 例四项指标逐位相同。
// 已知残余（如实登记，见末腿）：q+q 会在拼接处生成一个跨边界 bigram；当它恰好存在于语料时，
//   该配对的分数不是精确 2×、top-10 之后的位次可动（实测 1/77，top-5 与 top-4 均不受影响）。
//   这是字符级双字滑窗对"重复"这一输入形态的真实敏感面，不是量纲问题，量纲那条已经关闭。
import { readFileSync } from "node:fs"
import { search } from "../functions/lib/rag.js"

const TOL = 0.0015 // evidenceOf 把分数舍入到三位小数，2× 比对按同一粒度留容差
const MIN_PAIRS = Number(process.env.REPETITION_MIN_PAIRS ?? 60)
const MIN_EXACT = Number(process.env.REPETITION_EXACT_FLOOR ?? 60) // 基线实测 76/77；变异体只有 22/77

const silver = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", import.meta.url), "utf8"))
const holdout = JSON.parse(readFileSync(new URL("./fixtures/retrieval_holdout.json", import.meta.url), "utf8"))
// 口语侧样本同 retriever_parity：只有它们会触发同义词桥，也就是本次被修的那条分支
const COLLOQUIAL_QUERIES = [
  "冒冷汗伴胸痛", "孩子高热惊厥", "停经后来好多血头晕", "婴幼儿拉果酱色大便",
  "腰痛连带不上厕所", "嘴巴肿了喉咙发紧", "今天天气不错适合出门",
]
const allCases = [...silver.cases, ...holdout.cases]
const QUERIES = allCases.map((c) => c.query).concat(COLLOQUIAL_QUERIES)
const gold = new Map(allCases.map((c) => [c.id, new Set(c.relevant_ids)]))
const redFlagIds = new Set(allCases.filter((c) => c.red_flag).map((c) => c.id))
const caseByQuery = new Map(allCases.map((c) => [c.query, c]))

const idsOf = (list) => list.map((e) => e.id).join(",")
const hitsOf = (list, rel) => list.filter((e) => rel.has(e.id)).length

let orderBad5 = 0
let orderBad4 = 0
let recallBad = 0
let rfRecallBad = 0
let drift = 0
let exactOk = 0
let pairs = 0
const viol = []
for (const q of QUERIES) {
  if (!q || !String(q).trim()) continue
  pairs += 1
  const one = search(q, 5)
  const again = search(q, 5)
  const twice = search(q + q, 5)
  if (idsOf(one) !== idsOf(again) || one.some((e, i) => e.score !== again[i].score)) drift += 1
  if (idsOf(one) !== idsOf(twice)) {
    orderBad5 += 1
    viol.push(`TOP5 ${q.slice(0, 22)}… ${idsOf(one)} ⇒ ${idsOf(twice)}`)
  }
  if (idsOf(one.slice(0, 4)) !== idsOf(twice.slice(0, 4))) orderBad4 += 1
  const c = caseByQuery.get(q)
  if (c) {
    const rel = gold.get(c.id)
    const before = hitsOf(one, rel)
    const after = hitsOf(twice, rel)
    if (before !== after) {
      recallBad += 1
      viol.push(`RECALL ${c.id}「${q.slice(0, 22)}…」${before}⇒${after}`)
      if (redFlagIds.has(c.id)) rfRecallBad += 1
    }
  }
  if (one.every((e, i) => twice[i] && Math.abs(twice[i].score - 2 * e.score) <= TOL)) exactOk += 1
}

console.log(`== 重复不变式（#102）：同一句话原样重复一遍，检索不得改变（${pairs} 条配对查询）==`)
let fail = 0
const say = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) fail += 1
}
say(pairs >= MIN_PAIRS, "分母自证：配对查询够多（取不到数不许记绿）", `实测 ${pairs}，地板 ${MIN_PAIRS}`)
say(drift === 0, "恒等复算：同一查询两次取数逐位相同（排除测量器自己动分数）", `${drift} 漂移`)
say(orderBad5 === 0, "top-5 名次不因重复而变（变异体在此腿 42 条判红）", `实测 ${orderBad5}`)
say(orderBad4 === 0, "top-4 名次不因重复而变（线上服务档）", `实测 ${orderBad4}`)
say(recallBad === 0, "top-5 命中数不因重复而变", `实测 ${recallBad}`)
say(rfRecallBad === 0, `危急子集 top-5 命中数不因重复而变（${redFlagIds.size} 例）`, `实测 ${rfRecallBad}`)
say(exactOk >= MIN_EXACT, "分数向量恰为 2×（等比放大＝缩放真接线的正面证据）",
  `实测 ${exactOk}/${pairs}，地板 ${MIN_EXACT}；变异体只有 22/77`)
for (const v of viol.slice(0, 8)) console.log(`    ${v}`)
console.log(`  ADVISORY 跨边界 bigram 造成的非 2× 配对：${pairs - exactOk} 条`
  + "（q+q 在拼接处生成一个新双字组；它落在语料里时位次可在 top-10 之外动，与量纲无关）")
if (fail) {
  console.log(`RESULT: ${fail} fail  [GATE:repetition-fail]`)
  process.exit(1)
}
console.log(`RESULT: 0 fail（${pairs} 条配对全绿）  [GATE:repetition-pass]`)
process.exit(0)
