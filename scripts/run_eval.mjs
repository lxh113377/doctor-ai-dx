// 离线评测 runner（权威面；第四十六轮前的历史：它长期只活在参赛工作区 `iCAN…/03-评测/` 里）。
// 为什么搬进本仓：`docs/EVAL_CARD.md` 的头条数字（结构 31/31、引用 31/31、红旗召回、输入敏感性）
// 此前对拿到**源码包**的评审是"只有结论、没有可跑的复现脚本"——离线评测器不在包内，
// 而包内唯一跑得到的路径是 `npm test`（要先 `npm ci` 装依赖）。本件零依赖（只 import
// `frontend/functions/lib/*.js` 与一份 fixture），`node scripts/run_eval.mjs` 即可复算。
// 对位 openemr 的 `Acceptance test (package)`：验收要跑在**产物**上，不是只跑在仓库上。
//
// 断言：①红旗召回（scanFlags 对纯答案文本）②JSON结构 ③引用ID有效 ④降级标注 ⑤输入敏感性
// 用法：node scripts/run_eval.mjs [--cases <path>] [--out <path>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildDiagnosis, buildWorkup, buildReport, ABSTAIN_PRIMARY } from "../frontend/functions/lib/engine.js"
import { scanFlags } from "../frontend/functions/lib/rules.js"
import { hasEvidence } from "../frontend/functions/lib/rag.js"

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? resolve(argv[i + 1]) : ""
}
const casesPath = flag("cases") || fileURLToPath(new URL("../frontend/tests/fixtures/eval_cases.json", import.meta.url))
const suite = JSON.parse(readFileSync(casesPath, "utf8"))
if (!Array.isArray(suite.cases) || suite.cases.length === 0) {
  console.log(`FAIL :: 评测集取到 0 例（${casesPath}）⇒ 分母为空，绝不记 ALL PASS`)
  console.log("[GATE:eval-empty-denominator]")
  process.exit(2)
}
const env = {} // 无 Key → 强制 rule-fallback，验收确定性

const results = []
let redTotal = 0, redHit = 0
let structPass = 0, citePass = 0, modePass = 0, abstainCount = 0
const abstainScenes = [] // 弃权第三态要能点名是哪几例，只报数字没法查
const primarySignatures = new Set()

for (const c of suite.cases) {
  const caseId = c.case_id || "c1"
  const history = c.answers.map((a) => ({ role: "user", content: a }))
  const answersText = c.answers.join("；")
  const rec = { id: c.id, scene: c.scene, case_id: c.case_id, errors: [] }

  // ① 红旗召回：对纯答案文本跑规则层（不被病例主诉污染）
  if (c.expect_flag === true || c.expect_flag === false) {
    const flags = scanFlags(answersText)
    const hit = flags.length > 0
    redTotal++
    if (c.expect_flag === true && hit) redHit++
    if (c.expect_flag === false && !hit) redHit++
    if (c.expect_flag === true && !hit) rec.errors.push("红旗漏检")
    if (c.expect_flag === false && hit) rec.errors.push("红旗误报:" + flags[0].slice(0, 20))
  }

  // ②③④ 引擎结构/引用/降级（走 buildDiagnosis）
  const dx = await buildDiagnosis(caseId, history, env)
  if (dx.mode !== "rule-fallback") rec.errors.push("mode非rule-fallback:" + dx.mode)
  else modePass++
  // AC-OBS-04 的「≥2」只适用于**给出诊断**的回答。v1.25.0（本仓 `3ebc65c`，2026-09-26 18:21）落了
  // 「弃权/范围外第三态」：信息不足与域外病例返回 primary=[ABSTAIN_PRIMARY] 且 differential 空——那是承诺的行为。
  // 本件此前没跟着改，从那天起对 ev-09／ev-24／ev-25 恒判失败（实测 28/31、rc=1）；
  // 而参赛工作区那份 runner 已改判（31/31）⇒ 两份尺对同一引擎给出相反结论。第七十二轮把这一半对齐过来。
  // 弃权用例改判它真正该守的三条：① abstain 标记为真 ② primary 恰为 ABSTAIN_PRIMARY（不许为凑数编两个诊断）
  // ③ 引用仍 ≥2（弃权也要可溯源）；非弃权用例的 AC-OBS-04 两条一字未动。
  const abstain = dx.abstain === true
  if (abstain) {
    abstainCount++
    abstainScenes.push(c.id + "(" + c.scene + ")")
    const okAbstain = Array.isArray(dx.primary) && dx.primary.length === 1
      && String(dx.primary[0]?.name ?? dx.primary[0]) === String(ABSTAIN_PRIMARY)
    if (!okAbstain) rec.errors.push(`弃权态 primary 非 ABSTAIN_PRIMARY:${JSON.stringify(dx.primary?.map((p) => p?.name ?? p))}`)
  } else {
    if (!Array.isArray(dx.primary) || dx.primary.length < 2) rec.errors.push("疑似诊断<2(AC-OBS-04)")
    if (!Array.isArray(dx.differential) || dx.differential.length < 2) rec.errors.push("鉴别诊断<2(AC-OBS-04)")
  }
  if (!dx.evidence || dx.evidence.length < 2) rec.errors.push("引用来源<2(AC-OBS-04)")
  if (!Array.isArray(dx.flags)) rec.errors.push("flags非数组")
  if (!Array.isArray(dx.flag_details)) rec.errors.push("flag_details非数组")
  if (dx.flags.length && !(dx.flag_details.length === dx.flags.length
    && dx.flag_details.every((f) => f.name && f.severity && f.advice))) rec.errors.push("flag_details与flags不一致")
  if (!dx.fallback_reason) rec.errors.push("缺fallback_reason")
  if (!dx.trace || !Array.isArray(dx.trace.evidence_ids)) rec.errors.push("缺trace")
  const allIds = [...(dx.evidence || []).map((e) => e.id), ...(dx.trace?.evidence_ids || []),
    ...dx.primary.flatMap((p) => p.evidence_ids || [])]
  const bad = allIds.filter((id) => !hasEvidence(id))
  if (bad.length) rec.errors.push("非法引用:" + bad.join(","))
  else citePass++
  if (rec.errors.length === 0) structPass++
  primarySignatures.add(dx.primary.map((p) => p.name).join("|"))

  // workup/report 结构（仅对映射病例，避免重复开销）
  if (c.case_id) {
    const w = await buildWorkup(caseId, history, env)
    if (!(w.essential.length && w.suggested.length && w.optional.length)) rec.errors.push("workup三组未全非空")
    const r = await buildReport(caseId, history, env)
    if (!(r.soap.subjective && r.soap.objective && r.soap.assessment && r.soap.plan)) rec.errors.push("SOAP不全")
    if (!r.disclaimer.includes("辅助")) rec.errors.push("报告缺免责声明")
  }
  rec.ok = rec.errors.length === 0
  results.push(rec)
}

const n = suite.cases.length
const report = {
  date: new Date().toISOString(),
  mode: "rule-fallback (no key)",
  total_cases: n,
  structure_pass: structPass,
  citation_valid: citePass,
  mode_labeled: modePass,
  red_flag_recall: `${redHit}/${redTotal} = ${(redHit / redTotal * 100).toFixed(0)}%`,
  // 溯源三元组（对 EleutherAI/lm-evaluation-harness 的 model+task+result 记录法）：读数是谁产的、
  // 用例集是哪一版、有多少例走弃权第三态。弃权数一旦涨上去说明覆盖面在缩水，
  // 所以它只报读数不设常量帽——帽由判据取"已提交基线"现算，生产方写不进 HEAD。
  generator: "doctor-ai-dx-mvp/scripts/run_eval.mjs",
  // 不变量（第七十二轮实测）：本件读的 `frontend/tests/fixtures/eval_cases.json` 是参赛工作区
  // `iCAN…/03-评测/eval_cases.json` 的**声明式镜像**（其 `_meta.provenance` 自述），31 例的 id 序列与
  // 每例内容语义相等，只差 `_meta` 文案与行尾 ⇒ 两面各自的 cases_sha256 **必然不等**，这不是分叉。
  // 反过来若哪天两串相等，说明镜像被"顺手统一"掉了（含被覆盖 _meta）⇒ 该去查是谁合并了这两份。
  // 哈希一律按字节取（与工作区那份同一定义），禁改成只哈希 cases 数组——那会造出第三套口径、两面再也比不了。
  cases_sha256: createHash("sha256").update(readFileSync(casesPath)).digest("hex"),
  abstain_cases: abstainCount,
  abstain_scenes: abstainScenes,
  distinct_primary_outputs: primarySignatures.size,
  input_sensitivity: primarySignatures.size >= 5 ? "PASS（不同输入→≥5种不同结论）" : "FAIL（输出区分度不足）",
  failures: results.filter((r) => !r.ok),
  cases: results,
}
const reportPath = flag("out") || fileURLToPath(new URL("../.eval/eval_report.json", import.meta.url))
mkdirSync(reportPath.slice(0, reportPath.lastIndexOf("/")), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n")

console.log("=== 评测结果（零依赖离线复算，评测器＝scripts/run_eval.mjs）===")
console.log(`评测集: ${casesPath}`)
console.log(`用例总数: ${n}`)
console.log(`结构校验通过: ${structPass}/${n}`)
console.log(`引用ID有效: ${citePass}/${n}`)
console.log(`降级模式标注: ${modePass}/${n}`)
console.log(`红旗召回: ${report.red_flag_recall}`)
console.log(`弃权/范围外第三态用例: ${abstainCount} 例（AC-OBS-04 的"≥2 诊断"不适用于这些例，见 runner 内注释）`)
console.log(`不同输入产出不同结论: ${primarySignatures.size} 种 → ${report.input_sensitivity}`)
console.log(`报告: ${reportPath}`)
if (report.failures.length) {
  console.log("失败用例:")
  report.failures.forEach((f) => console.log(`  ${f.id}(${f.scene}): ${f.errors.join("; ")}`))
}
const allGreen = structPass === n && citePass === n && modePass === n && redHit === redTotal && primarySignatures.size >= 5
console.log(`\nOVERALL: ${allGreen ? "ALL PASS" : "HAS FAILURES"}`)
process.exit(allGreen ? 0 : 1)
