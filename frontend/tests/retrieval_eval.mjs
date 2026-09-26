// 纯离线检索评测：Recall@k、MRR、nDCG；无需 LLM、云服务或密钥。
import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { getRetriever, DEFAULT_RETRIEVER } from "../functions/lib/retriever.js"
import { hasEvidence } from "../functions/lib/rag.js"

const fixtureArg = (process.argv.find((a) => a.startsWith("--fixture=")) || "").split("=")[1] || "retrieval_cases.json"
const fixtureUrl = new URL(`./fixtures/${fixtureArg}`, import.meta.url)
const holdout = fixtureArg !== "retrieval_cases.json"
const baselineUrl = new URL("./fixtures/retrieval_baseline.json", import.meta.url)
const suite = JSON.parse(readFileSync(fixtureUrl, "utf8"))
// --retriever=bm25|hybrid：默认 bm25（线上口径），用于同口径对比两种检索器的 Recall/MRR/nDCG
const argName = (process.argv.find((a) => a.startsWith("--retriever=")) || "").split("=")[1]
const retriever = getRetriever(argName || undefined)
const ks = [1, 3, 5, 10]
const round = (value) => Math.round(value * 1_000_000) / 1_000_000
// 四项受控指标与逐用例锁的取值（#70/#71 共用，写档与对账走同一份定义，不留第二真值）
const METRICS = ["recall_at_5", "mrr", "ndcg_at_5", "red_flag_recall_at_5"]
const snap = (report) => ({
  recall_at_5: report.overall.recall_at_5,
  mrr: report.overall.mrr,
  ndcg_at_5: report.overall.ndcg_at_5,
  red_flag_recall_at_5: report.red_flag_subset.recall_at_5,
})
const perCaseFrom = (cases) => Object.fromEntries(
  cases.map((c) => [c.id, { recall_at_5: c.recall_at_5, mrr: c.mrr }]))

function recallAtK(ids, relevant, k) {
  const hits = ids.slice(0, k).filter((id) => relevant.has(id)).length
  return relevant.size ? hits / relevant.size : 0
}

function reciprocalRank(ids, relevant) {
  const index = ids.findIndex((id) => relevant.has(id))
  return index < 0 ? 0 : 1 / (index + 1)
}

function ndcgAtK(ids, relevant, k) {
  let dcg = 0
  ids.slice(0, k).forEach((id, index) => {
    if (relevant.has(id)) dcg += 1 / Math.log2(index + 2)
  })
  let idcg = 0
  const idealHits = Math.min(k, relevant.size)
  for (let index = 0; index < idealHits; index++) idcg += 1 / Math.log2(index + 2)
  return idcg ? dcg / idcg : 0
}

function summarize(records) {
  const summary = { cases: records.length }
  for (const k of ks) {
    summary[`recall_at_${k}`] = round(records.reduce((sum, item) => sum + item[`recall_at_${k}`], 0) / (records.length || 1))
  }
  summary.mrr = round(records.reduce((sum, item) => sum + item.mrr, 0) / (records.length || 1))
  summary.ndcg_at_5 = round(records.reduce((sum, item) => sum + item.ndcg_at_5, 0) / (records.length || 1))
  summary.ndcg_at_10 = round(records.reduce((sum, item) => sum + item.ndcg_at_10, 0) / (records.length || 1))
  return summary
}

const seen = new Set()
const records = suite.cases.map((item) => {
  if (!item.id || seen.has(item.id)) throw new Error(`重复或缺失 case id: ${item.id || "<empty>"}`)
  seen.add(item.id)
  if (!item.query || !Array.isArray(item.relevant_ids) || item.relevant_ids.length === 0) {
    throw new Error(`非法 fixture: ${item.id}`)
  }
  const invalid = item.relevant_ids.filter((id) => !hasEvidence(id))
  if (invalid.length) throw new Error(`${item.id} 包含不存在的 evidence_id: ${invalid.join(",")}`)

  const results = retriever.search(item.query, 10)
  const ids = results.map((result) => result.id)
  const relevant = new Set(item.relevant_ids)
  const record = {
    id: item.id,
    scene: item.scene,
    red_flag: Boolean(item.red_flag),
    relevant_ids: item.relevant_ids,
    retrieved_ids: ids,
    mrr: round(reciprocalRank(ids, relevant)),
    ndcg_at_5: round(ndcgAtK(ids, relevant, 5)),
    ndcg_at_10: round(ndcgAtK(ids, relevant, 10)),
  }
  for (const k of ks) record[`recall_at_${k}`] = round(recallAtK(ids, relevant, k))
  return record
})

const scenes = {}
for (const scene of [...new Set(records.map((record) => record.scene))]) {
  scenes[scene] = summarize(records.filter((record) => record.scene === scene))
}
const report = {
  date: new Date().toISOString(),
  retriever: retriever.name,
  fixture: suite._meta,
  overall: summarize(records),
  red_flag_subset: summarize(records.filter((record) => record.red_flag)),
  scenes,
  cases: records,
}

if (process.argv.includes("--write-baseline")) {
  const store = JSON.parse(readFileSync(baselineUrl, "utf8"))
  store.retrievers = store.retrievers || {}
  const prev = store.retrievers[report.retriever]
  const measured = snap(report)
  const prevMin = prev?.minimum || {}
  // 地板只准收紧不准放宽：直接沿用旧地板，只把「快照」与「余量」补记进档（#70）。
  // 上一版把 minimum 写成当时的实测值＝零余量，于是任何语料改动当天必撞线——
  // 「只准收紧」在没有余量的前提下等价于「禁止增长」，这才是 #70 要治的东西。
  const minimum = {}
  const lowered = []
  for (const k of METRICS) {
    minimum[k] = prevMin[k] !== undefined ? prevMin[k] : measured[k]
    if (prevMin[k] !== undefined && minimum[k] < prevMin[k] - 1e-9) lowered.push(`${k}: ${prevMin[k]}→${minimum[k]}`)
  }
  if (lowered.length) {
    console.error(`[GATE:baseline-refused] 拒绝写回更低的地板（只准收紧不准放宽）：${lowered.join(", ")}`)
    process.exit(1)
  }
  store.retrievers[report.retriever] = {
    fixture_name: suite._meta.name,
    case_count: report.overall.cases,
    updated: new Date().toISOString().slice(0, 10),
    // 只有线上口径（DEFAULT_RETRIEVER）的地板是阻断档；hybrid/semantic 是实验位，
    // 它们的地板历史上被写成零余量实测值，若照样阻断就等于拿"没启用的通道"卡住交付。
    // 缺这个字段即判红——防止有人靠删字段把阻断档偷偷降成看守档。
    enforced: report.retriever === DEFAULT_RETRIEVER,
    measured,
    minimum,
    headroom: Object.fromEntries(METRICS.map((k) => [k, round(measured[k] - minimum[k], 6)])),
    headroom_basis: "余量＝measured − minimum，由本命令现算，禁手填；任一项为 0 即判红（零余量地板＝语料冻结，见 07 台账#70）",
    per_case: perCaseFrom(report.cases),
    per_case_rule: "逐用例锁：任何一例低于此记录即判红并点名；确需破锁要跑 --rebaseline-cases --why \"<理由>\"，理由会常驻打印（visible debt）",
    per_case_notes: prev?.per_case_notes || [],
  }
  writeFileSync(baselineUrl, `${JSON.stringify(store, null, 2)}\n`)
  console.log(`Baseline written for retriever: ${report.retriever}（余量 ${JSON.stringify(store.retrievers[report.retriever].headroom)}）`)
} else if (holdout) {
  console.log(`[holdout] ${fixtureArg} retriever=${report.retriever} cases=${report.overall.cases} R@5=${report.overall.recall_at_5} MRR=${report.overall.mrr} nDCG@5=${report.overall.ndcg_at_5} redR@5=${report.red_flag_subset.recall_at_5}（留出集不参与基线断言）`)
} else {
  const store = JSON.parse(readFileSync(baselineUrl, "utf8"))
  const baseline = store.retrievers?.[report.retriever]
  if (!baseline) {
    console.error(`基线缺失：${report.retriever}（先跑 --retriever=${report.retriever} --write-baseline）`)
    process.exit(1)
  }
  const outputEarly = process.env.RETRIEVAL_REPORT_PATH
  const checks = [
    ["case_count", !holdout && report.overall.cases === baseline.case_count],
    ["recall_at_5", report.overall.recall_at_5 >= baseline.minimum.recall_at_5],
    ["mrr", report.overall.mrr >= baseline.minimum.mrr],
    ["ndcg_at_5", report.overall.ndcg_at_5 >= baseline.minimum.ndcg_at_5],
    ["red_flag_recall_at_5", report.red_flag_subset.recall_at_5 >= baseline.minimum.red_flag_recall_at_5],
  ]
  // #70：地板本身也要被把关——零余量的地板等于给语料上了冻，假地板（高于快照）更是自欺
  for (const k of METRICS) {
    const min = baseline.minimum?.[k]
    const mea = baseline.measured?.[k]
    if (min === undefined || mea === undefined) { checks.push([`余量字段在场:${k}`, false]); continue }
    checks.push([`地板≤快照:${k}`, min <= mea + 1e-9])
    checks.push([`余量非零:${k}`, mea - min > 1e-9])
  }
  checks.push([`headroom 与 measured−minimum 全等`,
    METRICS.every((k) => Math.abs((baseline.headroom?.[k] ?? NaN)
      - round(baseline.measured[k] - baseline.minimum[k])) < 1e-6)])
  // #71：逐用例锁——聚合地板只说"掉了"，逐例锁说"掉在哪一例"（上一轮那 5 例是靠人工逐条归因定位的）
  const locked = baseline.per_case || {}
  const caseBad = []
  for (const c of report.cases) {
    const l = locked[c.id]
    if (!l) { caseBad.push(`${c.id} 无逐例锁记录（覆盖面缩水）`); continue }
    for (const k of ["recall_at_5", "mrr"]) {
      if (l[k] !== undefined && c[k] !== undefined && c[k] < l[k] - 1e-9) {
        caseBad.push(`${c.id} ${k} ${l[k]}→${c[k]}`)
      }
    }
  }
  for (const id of Object.keys(locked)) {
    if (!report.cases.some((c) => c.id === id)) caseBad.push(`${id} 锁里有、本次没跑（用例被删？）`)
  }
  const brokenAllowed = process.argv.includes("--rebaseline-cases")
  if (caseBad.length && !brokenAllowed) checks.push([`逐用例回归锁（#71）`, false])
  if (caseBad.length && brokenAllowed) {
    const why = (process.argv.find((a) => a.startsWith("--why=")) || "").slice(6)
    if (!why) { console.error("[GATE:rebaseline-refused] --rebaseline-cases 必须带 --why=\"<理由>\""); process.exit(1) }
    const store2 = JSON.parse(readFileSync(baselineUrl, "utf8"))
    const entry = store2.retrievers[report.retriever]
    entry.per_case = perCaseFrom(report.cases)
    entry.per_case_notes = [...(entry.per_case_notes || []),
      { at: new Date().toISOString().slice(0, 10), reason: why, broken: caseBad.slice(0, 20) }]
    writeFileSync(baselineUrl, `${JSON.stringify(store2, null, 2)}\n`)
    console.error(`[REBASELINE] 破锁重写 ${caseBad.length} 例，理由已入档并每次运行公示：${why}`)
  }
  if (caseBad.length && !brokenAllowed) {
    console.error(`逐用例退化（#71）：${caseBad.slice(0, 8).join(" ; ")}`)
    if (caseBad.length > 8) console.error(`…共 ${caseBad.length} 处`)
  }
  if (baseline.per_case_notes?.length) {
    console.log(`NOTE 历史破锁 ${baseline.per_case_notes.length} 次（最近：${baseline.per_case_notes.at(-1).at} ${baseline.per_case_notes.at(-1).reason}）`)
  }
  // 「只准收紧不准放宽」要对着**已提交的版本**比，而不是对着自己比（否则手改 minimum 无人知）。
  // 三态：有 HEAD ⇒ 硬核；浅克隆/无该文件 ⇒ 显式 SKIPPED（不静默记绿，也不做永远响的假警报，见 v1.23.1 教训）。
  {
    const rootDir = fileURLToPath(new URL("../..", import.meta.url))
    let prevText = null
    let gitErr = ""
    try {
      prevText = execFileSync("git", ["show", "HEAD:frontend/tests/fixtures/retrieval_baseline.json"],
        { encoding: "utf8", cwd: rootDir, maxBuffer: 8 * 1024 * 1024 })
    } catch (e) {
      gitErr = String(e).split("\n")[0].slice(0, 90)
    }
    if (prevText) {
      let prevStore = null
      try { prevStore = JSON.parse(prevText) } catch { /* 解析不了走下面的红 */ }
      const prevEntry = prevStore?.retrievers?.[report.retriever]
      if (!prevEntry?.minimum) {
        checks.push([`HEAD 版基线含本档 minimum`, false])
      } else {
        for (const k of METRICS) {
          checks.push([`地板未低于已提交值:${k}`, baseline.minimum[k] >= prevEntry.minimum[k] - 1e-9])
        }
      }
    } else {
      console.log(`SKIPPED 地板对账未执行（拿不到 HEAD 版基线：${gitErr || "解析失败"}）——浅克隆环境属预期，但这条不算通过`)
    }
  }
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (baseline.enforced !== true && baseline.enforced !== false) {
    console.error("基线缺 enforced 字段（无法判断这条地板是阻断档还是看守档）——请重跑 --write-baseline")
    process.exit(1)
  }
  if (!baseline.enforced && failed.length) {
    console.log(`ADVISORY（${report.retriever} 非线上口径，地板只报告不阻断）：${failed.join(", ")}`)
    console.log(`  实测 R@5=${report.overall.recall_at_5} 地板=${baseline.minimum.recall_at_5}`)
  }
  if (failed.length && baseline.enforced) {
    // 判红更要落报告：红跑时最需要逐用例数据。此前写盘在门禁之后 ⇒ 一红就没有归因材料（第二十七轮实测踩到）。
    if (outputEarly) writeFileSync(outputEarly, `${JSON.stringify(report, null, 2)}\n`)
    console.error(`Retrieval regression (${report.retriever}): ${failed.join(", ")}`)
    console.error(JSON.stringify(report.overall, null, 2))
    process.exit(1)
  }
  console.log(`Retrieval baseline OK (${report.retriever}): recall@5=${report.overall.recall_at_5} mrr=${report.overall.mrr} cases=${report.overall.cases}`)
}

const outputPath = process.env.RETRIEVAL_REPORT_PATH
if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ retriever: report.retriever, overall: report.overall, red_flag_subset: report.red_flag_subset }, null, 2))
