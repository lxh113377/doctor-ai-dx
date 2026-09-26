// 公开仓自包含 31 例确定性评测：结构、引用、降级标注、红旗与输入敏感性。
// 红旗口径（第二十四轮改）：断言**产品实际输出** diagnosis.flags，不再另跑一次 scanFlags(answers)。
// 原实现测的是「纯答案文本」，而产品算的是「主诉＋答案」——两条输入，判据看不见产品的假阳性
// （实测 ev-06：主诉"发热3天"＋答案"无气促"命中脓毒症红旗，而 27/27 照样判绿）。
import { readFileSync } from "node:fs"
import { buildDiagnosis, buildWorkup, buildReport } from "../functions/lib/engine.js"
import { hasEvidence } from "../functions/lib/rag.js"

const suite = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8"))
const env = {}
const results = []
let redTotal = 0
let redHit = 0
let structPass = 0
let citePass = 0
let modePass = 0
const primarySignatures = new Set()

for (const item of suite.cases) {
  const caseId = item.case_id || "c1"
  const history = item.answers.map((answer) => ({ role: "user", content: answer }))
  const record = { id: item.id, scene: item.scene, errors: [] }

  const diagnosis = await buildDiagnosis(caseId, history, env)

  if (item.expect_flag === true || item.expect_flag === false) {
    const hit = Array.isArray(diagnosis.flags) && diagnosis.flags.length > 0
    redTotal++
    if ((item.expect_flag && hit) || (!item.expect_flag && !hit)) redHit++
    if (item.expect_flag && !hit) record.errors.push("红旗漏检")
    if (!item.expect_flag && hit) record.errors.push(`红旗误报:${diagnosis.flags[0].slice(0, 24)}`)
  }

  if (diagnosis.mode === "rule-fallback") modePass++
  else record.errors.push(`mode非rule-fallback:${diagnosis.mode}`)
  if (!Array.isArray(diagnosis.primary) || diagnosis.primary.length < 2) record.errors.push("疑似诊断<2")
  if (!Array.isArray(diagnosis.differential) || diagnosis.differential.length < 2) record.errors.push("鉴别诊断<2")
  if (!Array.isArray(diagnosis.evidence) || diagnosis.evidence.length < 2) record.errors.push("引用来源<2")
  if (!Array.isArray(diagnosis.flags)) record.errors.push("flags非数组")
  if (!Array.isArray(diagnosis.flag_details)) record.errors.push("flag_details非数组")
  if (diagnosis.flags.length && !(diagnosis.flag_details.length === diagnosis.flags.length
    && diagnosis.flag_details.every((flag) => flag.name && flag.severity && flag.advice))) {
    record.errors.push("flag_details与flags不一致")
  }
  if (!diagnosis.fallback_reason) record.errors.push("缺fallback_reason")
  if (!diagnosis.trace || !Array.isArray(diagnosis.trace.evidence_ids)) record.errors.push("缺trace")

  const allIds = [
    ...(diagnosis.evidence || []).map((evidence) => evidence.id),
    ...(diagnosis.trace?.evidence_ids || []),
    ...diagnosis.primary.flatMap((primary) => primary.evidence_ids || []),
  ]
  const invalidIds = allIds.filter((id) => !hasEvidence(id))
  if (invalidIds.length) record.errors.push(`非法引用:${invalidIds.join(",")}`)
  else citePass++

  if (item.case_id) {
    const workup = await buildWorkup(caseId, history, env, diagnosis)
    if (!(workup.essential.length && workup.suggested.length && workup.optional.length)) record.errors.push("workup三组未全非空")
    const report = await buildReport(caseId, history, env, diagnosis)
    if (!report.soap || !["subjective", "objective", "assessment", "plan"].every((key) => report.soap[key])) record.errors.push("SOAP不全")
    if (!report.disclaimer.includes("辅助")) record.errors.push("报告缺免责声明")
  }

  if (record.errors.length === 0) structPass++
  primarySignatures.add(diagnosis.primary.map((primary) => primary.name).join("|"))
  record.ok = record.errors.length === 0
  results.push(record)
}

const total = suite.cases.length
const report = {
  total_cases: total,
  structure_pass: structPass,
  citation_valid: citePass,
  mode_labeled: modePass,
  red_flag_accuracy: `${redHit}/${redTotal}`,
  distinct_primary_outputs: primarySignatures.size,
  failures: results.filter((record) => !record.ok),
}
console.log(JSON.stringify(report, null, 2))

const allGreen = structPass === total
  && citePass === total
  && modePass === total
  && redHit === redTotal
  && primarySignatures.size >= 5
process.exit(allGreen ? 0 : 1)
