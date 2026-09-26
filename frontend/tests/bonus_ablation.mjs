// 红旗加性项的**可观测性**测量（看守件，不进 npm test；台账 #110）
// 为什么要有它（第三十七轮一手）：#98 提议"把加权词的常数 2 换成由语料 df 现算的权重"。
//   动手前先量射程，结果发现一个比 #98 更该记的事实——
//   把**整条加性项拿掉**，70 例的 recall@5、MRR、"首个命中名次"、危急子集读数**一位都不动**，
//   只有 3 例 top-5 内部换序。也就是说：这一项在当前评测集上**不可见**。
//   ⇒ 那么"给它换什么权重"就是纯盲调（R236 补注③同族：不可分就别动机制，禁止用调参掩盖"测不到"）。
//   本件的作用是把这件事变成每轮都在打的读数，而不是靠人记得。
// 三档出口，彼此不遮蔽：
//   ① 校准腿（**阻断**）：本件的 cur 聚合读数必须复现 tests/fixtures/retrieval_baseline.json 的 measured；
//      复现不了就是本件自己的口径漂了 ⇒ 判红，且**后面两档一律不许引用**。
//   ② 触发腿（**阻断**）：加性分量必须真的非零。零输入不得记"不可见"——那是"根本没触发"，
//      两者含义相反（记忆里同族条：判"看不见"之前先证"它在场"）。
//   ③ 可观测腿（**只报不拦**）：消融前后 recall/首个命中名次 的变化例数。
//      当前实测 0 ⇒ 打 INVISIBLE；哪天 >0 ⇒ 打 VISIBLE 并提示 #98 可以重新评估。
// 不往生产模块重写打分：分量由权威面自己交出（`flagContributions`，与 search 内联计算同一个函数）。
import { readFileSync } from "node:fs"
import { search, flagContributions } from "../functions/lib/rag.js"

const ROOT = new URL(".", import.meta.url)
const K = 5
const round6 = (v) => Math.round(v * 1e6) / 1e6
const silver = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", ROOT), "utf8")).cases
const holdout = JSON.parse(readFileSync(new URL("./fixtures/retrieval_holdout.json", ROOT), "utf8")).cases
const all = [...silver, ...holdout]
const baseline = JSON.parse(readFileSync(new URL("./fixtures/retrieval_baseline.json", ROOT), "utf8"))
  .retrievers.bm25

function ranked(query, ablate) {
  const hits = search(query, 10)
  if (!ablate) return hits.map((e) => e.id)
  const contrib = flagContributions(query)
  const shifted = hits.map((e, i) => ({ id: e.id, s: e.score - (contrib.get(e.id) || 0), i }))
  shifted.sort((a, b) => (b.s - a.s) || (a.i - b.i))   // 分数降序 + 原序兜底（与生产一致的稳定序）
  return shifted.map((x) => x.id)
}
function scoreSet(cases, ablate) {
  let r5 = 0, mrr = 0, ndcg = 0, n = 0
  const per = new Map()
  for (const c of cases) {
    const rel = new Set(c.relevant_ids)
    const ids = ranked(c.query, ablate)
    const denom = Math.min(rel.size, K)
    r5 += ids.slice(0, K).filter((i) => rel.has(i)).length / denom
    const at = ids.findIndex((i) => rel.has(i))
    mrr += at < 0 ? 0 : 1 / (at + 1)
    const dcg = ids.slice(0, K).reduce((a, i, x) => a + (rel.has(i) ? 1 / Math.log2(x + 2) : 0), 0)
    const idcg = [...Array(denom).keys()].reduce((a, i) => a + 1 / Math.log2(i + 2), 0)
    ndcg += idcg ? dcg / idcg : 0
    per.set(c.id, { ids: ids.slice(0, K).join(","), rec: ids.slice(0, K).filter((i) => rel.has(i)).length / denom, rank: at })
    n += 1
  }
  return { n, r5: round6(r5 / n), mrr: round6(mrr / n), ndcg5: round6(ndcg / n), per }
}

let fail = 0
const say = (ok, name, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) fail += 1
}
console.log(`== 红旗加性项可观测性（#110）：${all.length} 例（silver ${silver.length} + 留出 ${holdout.length}）==`)

const curAll = scoreSet(all, false)
const cur50 = scoreSet(silver, false)
const m = baseline.measured
say(all.length >= 60, "分母自证：用例够多（读空不许记绿）", `实测 ${all.length}，地板 60`)
say(cur50.r5 === m.recall_at_5 && cur50.mrr === m.mrr && cur50.ndcg5 === m.ndcg_at_5,
  "校准腿：本件在 silver-50 上复现官方地板读数（否则后面两档一律不作数）",
  `本件 R@5=${cur50.r5}/MRR=${cur50.mrr}/nDCG@5=${cur50.ndcg5} ｜ 官方 ${m.recall_at_5}/${m.mrr}/${m.ndcg_at_5}`)

// ② 触发腿：加性分量非零的 (查询, 文档) 对数
let firedPairs = 0, firedCases = 0, firedSum = 0
for (const c of all) {
  const contrib = flagContributions(c.query)
  let any = false
  for (const v of contrib.values()) { firedSum += v; any = true }
  if (any) { firedCases += 1 }
  firedPairs += contrib.size
}
say(firedPairs > 0 && firedCases > 0, "触发腿：加权项真的在计分（零触发不得判成『不可见』，那是另一回事）",
  `非零分量 (查询,文档) 对 ${firedPairs} 个 ｜ 命中的查询 ${firedCases}/${all.length} 条 ｜ 分量合计 ${round6(firedSum)}`)

// ③ 可观测腿
const abl = scoreSet(all, true)
let orderChg = 0, recChg = 0, rankChg = 0
for (const [id, b] of curAll.per) {
  const o = abl.per.get(id)
  if (!o) continue
  if (b.ids !== o.ids) orderChg += 1
  if (Math.abs(b.rec - o.rec) > 1e-9) recChg += 1
  if (b.rank !== o.rank) rankChg += 1
}
const rfCases = all.filter((c) => c.red_flag)
const rfCur = scoreSet(rfCases, false)
const rfAbl = scoreSet(rfCases, true)
const invisible = recChg === 0 && rankChg === 0
console.log(`  ADVISORY 可观测腿：整条移除该加性项后 —— top-5 名次变 ${orderChg} 例 / recall@5 变 ${recChg} 例 / 首个命中名次变 ${rankChg} 例（共 ${all.length} 例）`)
console.log(`           聚合读数 R@5 ${curAll.r5}→${abl.r5} ｜ MRR ${curAll.mrr}→${abl.mrr} ｜ nDCG@5 ${curAll.ndcg5}→${abl.ndcg5}`)
console.log(`           危急子集 ${rfCases.length} 例 R@5 ${rfCur.r5}→${rfAbl.r5} ｜ MRR ${rfCur.mrr}→${rfAbl.mrr}`)
console.log(`  [GATE:ablation-${invisible ? "invisible" : "visible"}] `
  + (invisible
    ? "当前评测集看不见这条加性项 ⇒ 禁对它调参／换权重（#98 前提不成立）；要让它可测，"
      + "需补「gold 只能靠加权词才进 top-5」的用例，补上后本件自动转 VISIBLE"
    : "评测集已能看见这条加性项 ⇒ #98（权重由语料现算）具备被评估的条件，可重新开单"))

if (fail) {
  console.log(`RESULT: ${fail} fail  [GATE:ablation-fail]`)
  process.exit(1)
}
console.log("RESULT: 校准与触发两腿全绿（可观测腿只报不拦）  [GATE:ablation-pass]")
process.exit(0)
