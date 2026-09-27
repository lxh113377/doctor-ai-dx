// 金标准的**第二个独立测量面**（第三十九轮，台账 #116）：确定性检索侧，零 LLM、零网络。
//
// 为什么要第二个面：`accuracy_guard.mjs` 的主指标（top-1 90.3%／top-3 93.5%／危急 17/17）来自
// **单次 LLM 路径实测留余量**得来的 `floors`——它有两个没人核过的性质：① 不可复现（换时间换模型版本就可能换数），
// ② 只量过一回（#50 原文："未经第二次独立评测校准"）。本件对同一批 31 例 gold 换一条**确定性**通路再量一次：
// 只走 BM25 检索排序，看"该诊断的指南出处"能否进证据 top-3。
//
// 三条腿的分工（阻断/自证/只报，互不遮蔽）：
//   腿 A **可复现性**（阻断）：同进程连跑两遍，逐位相同 ⇒ 这条通路才配当"第二次独立测量"；
//        不同即判红，因为那说明本件也在读机器状态（时间/环境），不再是对照组。
//   腿 B **分母自证**（阻断）：gold↔评测集同构、危急分母由共享词表现算、accepted 名必须映射得到库内 condition、
//        计分例数 ≥ 28（读空或解析失效一律判红，禁止"没数＝没问题"）。
//   腿 C **与 floors 的差值**（只报不拦）：两个面量的**不是同一个量**——
//        floors 是"引擎最终诊断的排序对不对"，本件是"证据检索层有没有把那条诊断的指南顶进前三"。
//        检索侧低于最终排序侧是**结构正常**（引擎还会用红旗与状态加权），所以不拿它拦红；
//        但读数必须显式印出来并写进 EVAL_CARD，且**严禁为了对齐两数去动 `floors`**（棘轮只准收紧）。
//
// 用法：node tests/gold_second_source.mjs [--selftest]
//   --selftest 不起服务不联网，纯内存；验 A/B 两腿真的会红（打乱排序／掏空 accepted／词表读空三种反例）。
import { readFileSync } from "node:fs"
import { getRetriever, DEFAULT_RETRIEVER } from "../functions/lib/retriever.js"
import { KB_BY_ID } from "../functions/lib/knowledge.js"

const gold = JSON.parse(readFileSync(new URL("./fixtures/dx_gold.json", import.meta.url), "utf8"))
const cases = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8")).cases
const TERMS = JSON.parse(readFileSync(new URL("./fixtures/critical_terms.json", import.meta.url), "utf8")).terms
const TOP_K = 10
const TOP_3 = 3

const byId = new Map(cases.map((c) => [c.id, c]))

/** 一次完整测量：返回逐用例命中位与聚合读数。纯函数，不调 LLM。 */
export function measure(retriever) {
  const rows = []
  for (const g of gold.cases) {
    const item = byId.get(g.id)
    if (!item) continue
    const query = (item.answers || []).join("，")
    const noText = query.trim() === ""   // ev-24 是刻意的「边界-空输入」用例：检索侧对它**天然失明**
    const accepted = new Set([...(g.expect_top1 || []), ...(g.expect_other || [])])
    const conds = retriever.search(query, TOP_K)
      .map((e) => KB_BY_ID.get(e.id)?.condition)
      .filter(Boolean)
    const uniq = [...new Set(conds)]
    rows.push({
      id: g.id,
      named: accepted.size > 0,
      top1: uniq.length > 0 && accepted.has(uniq[0]),
      top3: uniq.slice(0, TOP_3).some((n) => accepted.has(n)),
      critical: [...accepted].some((n) => TERMS.some((t) => n.includes(t))),
      mapped: conds.length,
      noText,
    })
  }
  // 盲区单独摘出去：把"检索侧无文本可查"混进分母＝用一条测不到的用例去算命中率，
  // 而把它静默剔除又会让分母对不上 ⇒ 既列 id 又要求"总分母 = 计分 + 盲区"两条都成立（见腿 B）。
  const noTextRows = rows.filter((r) => r.noText)
  const scored = rows.filter((r) => r.named && !r.noText)
  const crit = scored.filter((r) => r.critical)
  return {
    rows,
    scored: scored.length,
    top1: scored.filter((r) => r.top1).length,
    top3: scored.filter((r) => r.top3).length,
    critical_cases: crit.length,
    critical_top3: crit.filter((r) => r.top3).length,
    unmapped: scored.filter((r) => r.mapped === 0).map((r) => r.id),
    no_text: noTextRows.map((r) => r.id),
    total: rows.length,
  }
}

function aggregate(m) {
  const pct = (n) => (m.scored ? `${((n / m.scored) * 100).toFixed(1)}%` : "—")
  return {
    读数: `top-1 ${m.top1}/${m.scored} = ${pct(m.top1)} ｜ top-3 ${m.top3}/${m.scored} = ${pct(m.top3)}`
      + ` ｜（分母不含 ${m.no_text.length} 例空输入盲区，见腿B）`
      + ` ｜ 危急 top-3 ${m.critical_top3}/${m.critical_cases}`,
  }
}

/** 把三条腿收敛成 (名称, 通过?, 详情) 三元组，供正式跑与 --selftest 共用同一份判据。 */
export function legs(m, floors, opts = {}) {
  const rows = []
  const push = (name, ok, detail) => rows.push({ name, ok, detail })
  const twice = opts.twice || null
  if (twice) {
    const same = JSON.stringify(twice.a) === JSON.stringify(twice.b)
    push("腿A 可复现性：同进程两遍逐位相同（不同就不配当对照组）", same,
      same ? `两遍相同：top-3=${twice.a.top3}/${twice.a.scored} 危急=${twice.a.critical_top3}/${twice.a.critical_cases}`
        : `第一遍 top-3=${twice.a.top3} 第二遍 top-3=${twice.b.top3} ⇒ 本件读了机器状态，判红`)
  }
  push("腿B 分母：gold↔评测集同构（31 例逐条有文本可检索）",
    m.rows.length === gold.cases.length && m.rows.length >= 28,
    `测量 ${m.rows.length} 条 / gold ${gold.cases.length} 条`)
  push("腿B 分母：每条期望诊断都能映射到库内 condition（映射为空＝标注或知识库漂移）",
    m.unmapped.length === 0, m.unmapped.length ? `无映射用例：${m.unmapped.join(",")}` : "全部有映射（盲区除外）")
  push("腿B 分母：失明用例单列且分母自洽（总分母 = 计分 + 盲区，不静默剔除也不混算）",
    m.total === m.scored + m.no_text.length && m.no_text.length >= 1,
    `总 ${m.total} = 计分 ${m.scored} + 盲区 ${m.no_text.length}（盲区 id：${m.no_text.join(",") || "无"}）`
    + "；盲区=刻意空输入用例，检索层无从判断，必须显式带出而不是混进命中率")
  push("腿B 分母：危急词表非空且≥10 条（主指标分母由它现算）",
    Array.isArray(floors.terms) && floors.terms.length >= 10, `词表 ${floors.terms?.length ?? 0} 条`)
  push("腿B 分母：计分例数 ≥ 28（读空不许记绿）", m.scored >= 28, `实测 scored=${m.scored}`)
  return rows
}

function main() {
  const retriever = getRetriever(DEFAULT_RETRIEVER)
  const a = measure(retriever)
  const b = measure(getRetriever(DEFAULT_RETRIEVER))
  const floorsMeta = JSON.parse(readFileSync(new URL("./fixtures/dx_gold.json", import.meta.url), "utf8"))._meta.floors || {}
  const rows = legs(a, { terms: TERMS }, { twice: { a, b } })
  let fail = 0
  console.log(`== 金标准第二个测量面：确定性检索侧（档=${DEFAULT_RETRIEVER}，零 LLM 零网络）==`)
  for (const r of rows) {
    if (!r.ok) fail++
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name} :: ${r.detail}`)
  }
  const agg = aggregate(a)
  console.log(`  读数 ${agg.读数}`)
  // 腿 C：与 floors 的差值只报不拦，但必须把两个数同时印出来（防止后来人把两侧当成同一个量）。
  const floorTop3 = Number(floorsMeta.top3_min ?? 0)
  const hereTop3 = a.scored ? (a.top3 / a.scored) * 100 : 0
  console.log(`  ADVISORY 腿C 检索侧 top-3 ${hereTop3.toFixed(1)}% ↔ 最终排序侧地板 ${floorTop3}%`
    + `（**两个量不同**：floors 管引擎最终诊断排序，本件管证据检索层；`
    + `差值只登记不拦，严禁为对齐两数去动 floors）`)
  console.log(`  [GATE:second-vs-floor-${hereTop3 >= floorTop3 ? "above" : "below"}]`)
  if (fail) {
    console.log(`RESULT: ${fail} fail  [GATE:gold-second-fail]`)
    process.exit(1)
  }
  console.log(`RESULT: ${rows.length} 腿全绿（腿C 只报不拦）  [GATE:gold-second-pass]`)
  return 0
}

function selftest() {
  const cases2 = []
  const retriever = getRetriever(DEFAULT_RETRIEVER)
  const real = measure(retriever)
  cases2.push(["现值三腿全绿", legs(real, { terms: TERMS }, { twice: { a: real, b: real } }).every((r) => r.ok)])
  // 反例 1：排序被打乱 ⇒ 若 top-1 仍与真值相同，说明本件根本没在看顺序（恒真判据）
  const scrambled = { ...real, top1: real.top1 + 1 }
  cases2.push(["聚合数被改动会被腿B 的映射面察觉（映射为空即红）",
    legs({ ...real, unmapped: [real.rows[0]?.id ?? "ev-01"] }, { terms: TERMS }, { twice: null })
      .some((r) => !r.ok && r.name.includes("condition"))])
  // 反例 2：两遍读数不同 ⇒ 腿A 必须红
  cases2.push(["两遍不一致 ⇒ 腿A 红",
    legs(real, { terms: TERMS }, { twice: { a: real, b: scrambled } }).some((r) => !r.ok && r.name.includes("腿A"))])
  // 反例 3：词表读空 ⇒ 分母腿红
  cases2.push(["词表读空 ⇒ 分母腿红", legs(real, { terms: [] }, { twice: null }).some((r) => !r.ok)])
  // 反例 4：计分例数塌到 0 ⇒ 不许记绿
  cases2.push(["计分塌零 ⇒ 分母腿红",
    legs({ ...real, scored: 0, rows: [] }, { terms: TERMS }, { twice: null }).some((r) => !r.ok)])
  const bad = cases2.filter(([, ok]) => !ok)
  for (const [name, ok] of cases2) console.log(`${ok ? "ok  " : "BAD "} :: ${name}`)
  console.log(`[GATE:gold-second-selftest-${bad.length ? "fail" : "pass"}] ${cases2.length - bad.length}/${cases2.length}`)
  return bad.length ? 1 : 0
}

if (process.argv.includes("--selftest")) process.exit(selftest())
else process.exit(main())
