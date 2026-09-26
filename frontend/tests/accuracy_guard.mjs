// 诊断排序金标准守卫（第二十四轮新增，npm test 第 19 件套）。
// 对标实测（2026-09-26）：功能可比 peer 普遍发表 top-1/top-3 诊断命中率
// （Agentic-RAG-Diagnose-Assistant 62 例 Top1 93.5%、urobot-tw 检索命中 8/8、Medico 32 例 critical sensitivity），
// 而我方 31 例只测「结构/引用/降级」三类通过率——**没有任何一条判据问过"给出的诊断对不对"**。
// 本件把这个问题变成常驻判据：金标准集 = tests/fixtures/dx_gold.json，跑的是产品真实路径。
//
// 口径诚实性（不许为了好看而松动）：
//   ① 病例与标注同为自产 ⇒ 该数衡量「自建病例 → 自建 55 条知识库 → 引擎」三者自洽度，
//      **不是真实世界准确率**。对外引用必须带此限定（借鉴 urobot-tw / Medico 的自陈口径）。
//   ② 正确答案不在库内的，标 kb_gap 单列，不硬凑成"可接受"——kb_gap 清单就是知识库扩容 backlog。
import { readFileSync } from "node:fs"
import { buildDiagnosis } from "../functions/lib/engine.js"
import { KB_BY_ID } from "../functions/lib/knowledge.js"

const gold = JSON.parse(readFileSync(new URL("./fixtures/dx_gold.json", import.meta.url), "utf8"))
const cases = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8")).cases
const env = {} // 无 Key ⇒ 确定性 rule-fallback，零网络

const KB_NAMES = new Set([...KB_BY_ID.values()].map((k) => k.condition).filter(Boolean))
const rows = []
let fail = 0
const bad = (msg) => { fail++; console.log("  FAIL " + msg) }

// —— 判据接线自证（防"死判据仍报绿"）：两张表必须一一对应，分母现场枚举不写死 ——
const goldIds = gold.cases.map((c) => c.id)
const caseIds = cases.map((c) => c.id)
if (JSON.stringify(goldIds) !== JSON.stringify(caseIds)) {
  bad(`金标准集与评测集不同构（gold ${goldIds.length} 条 / cases ${caseIds.length} 条）；`
    + `仅 gold=${goldIds.filter((i) => !caseIds.includes(i)).join(",")} `
    + `仅 cases=${caseIds.filter((i) => !goldIds.includes(i)).join(",")}`)
}
if (!goldIds.length) bad("金标准集为空（空输入不得记 PASS）")

// —— 标注自身的卫生：写得出名字就必须存在于知识库，否则是标注错而非引擎错 ——
// 兜底文案是引擎内置的两条不确定态，不是知识库诊断
const ABSTAIN_LABELS = new Set(["信息不足，建议补充问诊", "待医生结合查体进一步鉴别"])
for (const g of gold.cases) {
  const named = [...(g.expect_top1 || []), ...(g.expect_other || [])]
  const ghost = named.filter((n) => !KB_NAMES.has(n) && !ABSTAIN_LABELS.has(n))
  if (ghost.length) bad(`${g.id} 标注了库内不存在的诊断名（应改记 kb_gap）：${ghost.join(", ")}`)
  if (!named.length && !g.kb_gap) bad(`${g.id} 既无期望诊断也没标 kb_gap（标注漏项）`)
}

// 危急类病例（漏检代价最高）：gold 里含「急症/红旗/危重/需急诊/需转诊」者单独出主指标
const CRITICAL_RE = /急症|红旗|危重|需急诊|需转诊|阻塞|夹层|栓塞|异位妊娠|脓毒症|会厌|出血/

let top1 = 0
let top3 = 0
let scored = 0
const gaps = []
const misses = []

for (const g of gold.cases) {
  const item = cases.find((c) => c.id === g.id)
  if (!item) continue
  const history = item.answers.map((a) => ({ role: "user", content: a }))
  const dx = await buildDiagnosis(item.case_id || "c1", history, env)
  const names = (dx.primary || []).map((p) => p.name)
  const accepted = new Set([...(g.expect_top1 || []), ...(g.expect_other || [])])
  const hit1 = !!names.length && accepted.has(names[0])
  const hit3 = names.slice(0, 3).some((n) => accepted.has(n))
  scored++
  if (hit1) top1++
  if (hit3) top3++
  if (g.kb_gap) gaps.push(`${g.id}:${g.kb_gap}`)
  if (!hit3) misses.push(`${g.id}(${item.scene || ""}) 输出 ${names.slice(0, 3).join(",") || "空"}`)
  const critical = [...accepted].some((n) => CRITICAL_RE.test(n)) || /急|红旗|重/.test(g.note || "")
  rows.push({ id: g.id, top1: hit1, top3: hit3, critical, predicted: names.slice(0, 3), kb_gap: g.kb_gap || null })
}

const pct = (n) => (scored ? (n / scored) * 100 : 0)
const crit = rows.filter((r) => r.critical)
const critTop3 = crit.filter((r) => r.top3).length
const summary = {
  scored,
  top1,
  top3,
  kb_gap_cases: gaps.length,
  critical_cases: crit.length,
  critical_top3_recall: crit.length ? `${critTop3}/${crit.length}` : "0/0",
}
const floors = gold._meta.floors || {}

console.log("=== 诊断排序金标准（合成病例自洽度，非真实世界准确率）===")
console.log(`用例: ${summary.scored}（评测集与金标准集同构校验 ${fail ? "未过" : "通过"}）`)
console.log(`top-1 命中: ${top1}/${scored} = ${pct(top1).toFixed(1)}%`)
console.log(`top-3 命中: ${top3}/${scored} = ${pct(top3).toFixed(1)}%`)
console.log(`危急类 top-3 召回（主指标）: ${summary.critical_top3_recall}`)
console.log(`知识库缺口病例（单列，不计入"错"）: ${gaps.length} → ${gaps.join(", ") || "无"}`)
if (misses.length) console.log(`top-3 未命中: ${misses.join(" | ")}`)

// —— 地板断言：分母与命中都现场算，地板数字来自 fixture 单一源 ——
// 第二十七轮实测缺陷：fixture 一直写着 top1_min=80，但本文件从不读它——地板形同没有（同族案例：
// ci_watch 的"不在第一轮就下结论"写在 docstring 而实现走另一条路）。补齐接线并纳入形态校验。
if (!floors.min_cases || !Number.isFinite(floors.critical_top3_min)
  || !Number.isFinite(floors.top3_min) || !Number.isFinite(floors.top1_min)) {
  bad(`floors 缺失或形态非法（min_cases/top1_min/top3_min/critical_top3_min）：${JSON.stringify(floors)}`)
}
if (scored < (floors.min_cases || Infinity)) bad(`计分用例数 ${scored} < 地板 ${floors.min_cases}（覆盖面缩水即判红）`)
if (top1 === 0) bad("top-1 全零——要么链路断了要么是死判据，两种都不许记绿")
if (crit.length === 0) bad("危急类用例数为 0：主指标失去分母，判红而不是跳过")
const critRate = crit.length ? (critTop3 / crit.length) * 100 : 0
if (critRate < (floors.critical_top3_min || 0)) bad(`危急类 top-3 召回 ${critRate.toFixed(1)}% < 地板 ${floors.critical_top3_min}%`)
if (pct(top1) < (floors.top1_min || 0)) bad(`top-1 命中 ${pct(top1).toFixed(1)}% < 地板 ${floors.top1_min}%`)
if (pct(top3) < (floors.top3_min || 0)) bad(`top-3 命中 ${pct(top3).toFixed(1)}% < 地板 ${floors.top3_min}%`)
// kb_gap 与"命中"语义冲突防线：标了缺口的用例若同时靠 expect_other 计入命中，指标会在扩库当天倒退。
// 第二十七轮就是这么踩到的（26→22 虚警），故把该口径钉成断言而不是靠人记得。
const gapHits = rows.filter((r) => r.kb_gap && r.top1).map((r) => r.id)
if (gapHits.length) bad(`kb_gap 用例被判为 top-1 命中（口径自相矛盾，须先摘掉 kb_gap 或清空 expect_other）：${gapHits.join(",")}`)

console.log(`\nRESULT: ${fail} fail / ${scored} 例 | ${JSON.stringify(summary)}`)
process.exit(fail ? 1 : 0)
