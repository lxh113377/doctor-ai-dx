// 纯离线检索评测：Recall@k、MRR、nDCG；无需 LLM、云服务或密钥。
import { readFileSync, writeFileSync } from "node:fs"
import { getRetriever } from "../functions/lib/retriever.js"
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
  store.retrievers[report.retriever] = {
    fixture_name: suite._meta.name,
    case_count: report.overall.cases,
    minimum: {
      recall_at_5: report.overall.recall_at_5,
      mrr: report.overall.mrr,
      ndcg_at_5: report.overall.ndcg_at_5,
      red_flag_recall_at_5: report.red_flag_subset.recall_at_5,
    },
  }
  writeFileSync(baselineUrl, `${JSON.stringify(store, null, 2)}\n`)
  console.log(`Baseline written for retriever: ${report.retriever}`)
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
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length) {
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
