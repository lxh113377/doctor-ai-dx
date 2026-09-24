// FHIR-light 导出门禁：Bundle 结构自洽 + 术语编码白名单 + 引用可解析 + 红线文案 + 无时钟确定性。
// 目的：FHIR 是对外集成契约，一旦产出非法资源/悬挂引用/编造编码，下游 HIS 会在生产侧报错——
//      这类缺陷不影响本项目评测，却能由本门禁 100% 拦下（离线、零网络、零 LLM）。
// 术语基线来源（2026-09-25 实取，HTTP 200）：
//   https://www.hl7.org/fhir/R4/codesystem-{bundle-type,encounter-status,observation-status,
//     diagnostic-report-status,condition-clinical,condition-ver-status,condition-category,administrative-gender}.json
//   https://terminology.hl7.org/CodeSystem-v3-ActCode.json（含 AMB=ambulatory，1,517,968 字节全量核验）
//   http://hl7.org/fhir/ValueSet/icd-10 → system = http://hl7.org/fhir/sid/icd-10
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildDiagnosis } from "../functions/lib/engine.js"
import { FHIR_CODE_SYSTEMS as CS } from "../functions/lib/fhir.js"
import { KB_BY_ID } from "../functions/lib/knowledge.js"

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const VERIFIED = {
  "http://hl7.org/fhir/bundle-type": ["document", "message", "transaction", "transaction-response", "batch", "batch-response", "history", "searchset", "collection"],
  "http://hl7.org/fhir/encounter-status": ["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled", "entered-in-error", "unknown"],
  "http://hl7.org/fhir/observation-status": ["registered", "preliminary", "final", "amended", "cancelled", "entered-in-error", "unknown"],
  "http://hl7.org/fhir/diagnostic-report-status": ["registered", "partial", "final", "amended", "cancelled", "entered-in-error", "unknown"],
  "http://hl7.org/fhir/administrative-gender": ["male", "female", "other", "unknown"],
  "http://terminology.hl7.org/CodeSystem/condition-clinical": ["active", "inactive"],
  "http://terminology.hl7.org/CodeSystem/condition-ver-status": ["unconfirmed", "confirmed", "refuted", "entered-in-error"],
  "http://terminology.hl7.org/CodeSystem/condition-category": ["problem-list-item", "encounter-diagnosis"],
  "http://terminology.hl7.org/CodeSystem/v3-ActCode": ["AMB"],
  "http://hl7.org/fhir/sid/icd-10": null, // 码值来自本仓知识库，受 ICD_RE 形状约束，不在此枚举
  // 本仓自发命名空间（README/ARCHITECTURE 已声明「不声称符合官方 Profile」）。
  // 仍逐码枚举：出现第 3 个本地 code 说明有人在导出里悄悄加语义，必须经门禁改动 + 双端同步。
  "https://github.com/lxh113377/doctor-ai-dx#fhir-light/code": ["red-flag", "citation"],
}
const ICD_RE = /^[A-Z]\d{2}(\.\d{1,2})?$/
const CASE_IDS = ["c1", "c2", "c3"]

// 31 例黄金输入（与评测集同源），在 rule-fallback 下走确定性链路
const suite = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/eval_cases.json", import.meta.url)), "utf8"))

// 判据本体：对单个 Bundle 做四类违规定位，返回问题清单（正样本应为空，反样本必须非空）
function scan(item, bundle) {
  const sink = { ref: [], code: [], clock: [], disclaimer: [], icd: [] }
  const ids = new Set(bundle.entry.map((e) => `${e.resource.resourceType}/${e.resource.id}`))
  JSON.stringify(bundle, (key, value) => {
    if (/^(timestamp|issued|effective|metaLastUpdated)$/.test(key)) sink.clock.push(`${item}.${key}`)
    if (key === "reference" && typeof value === "string" && !ids.has(value.split("/")[0] + "/" + value.split("/")[1]) && !ids.has(value)) {
      sink.ref.push(`${item}: ${value}`)
    }
    if (key === "coding" && Array.isArray(value)) {
      for (const c of value) {
        if (!(c.system in VERIFIED)) { sink.code.push(`${item}: 未登记 system ${c.system}`); continue }
        const allowed = VERIFIED[c.system]
        if (c.system === CS.icd10) {
          if (!ICD_RE.test(c.code)) sink.icd.push(`${item}: ICD 形状非法 ${c.code}`)
        } else if (!allowed.includes(c.code)) sink.code.push(`${item}: ${c.system}#${c.code} 不在已核验码集`)
      }
    }
    return value
  })
  const resources = bundle.entry.map((e) => e.resource)
  const report = resources.find((r) => r.resourceType === "DiagnosticReport")
  if (!String(report.conclusion).includes("医生终审")) sink.disclaimer.push(item)
  // 红线：icd 为 null 的条目不得凭空产出 ICD 编码
  for (const cond of resources.filter((r) => r.resourceType === "Condition")) {
    for (const cod of (cond.code.coding || [])) {
      if (cod.system !== CS.icd10) continue
      const srcIds = (cond.evidence || []).map((ev) => (ev.detail[0].reference || "").replace("Observation/citation-", ""))
      const okIcd = srcIds.some((id) => { const k = KB_BY_ID.get(id); return k && typeof k.icd === "string" && k.icd.split(";").map((s) => s.trim()).includes(cod.code) })
      if (!okIcd) sink.icd.push(`${item}: ${cond.id} 编码 ${cod.code} 无知识库出处`)
    }
  }
  return sink
}

const bundles = []
const refProblems = []
const codeProblems = []
const clockFields = []
const disclaimerProblems = []
const icdProblems = []
for (const item of suite.cases) {
  const history = item.answers.map((a) => ({ role: "user", content: a }))
  const dx = await buildDiagnosis(item.case_id || "c1", history, {})
  const bundle = dx.fhir
  bundles.push({ id: item.id, dx, bundle })
  const s = scan(item.id, bundle)
  refProblems.push(...s.ref); codeProblems.push(...s.code); clockFields.push(...s.clock)
  disclaimerProblems.push(...s.disclaimer); icdProblems.push(...s.icd)
}

check("全部 31 例都产出 Bundle", bundles.length === suite.cases.length && bundles.every((b) => b.bundle.resourceType === "Bundle" && b.bundle.type === "collection"))
check("编码 system 全部落在已核验白名单（无编造术语集）", codeProblems.length === 0, codeProblems.slice(0, 5).join(" | "))
check("引用全部可在 Bundle 内解析（无悬挂 reference）", refProblems.length === 0, refProblems.slice(0, 5).join(" | "))
check("导出零时钟字段（双端可逐字段对账）", clockFields.length === 0, clockFields.slice(0, 5).join(" | "))
check("红线：每份报告结论含「医生终审」", disclaimerProblems.length === 0, disclaimerProblems.join(","))
check("红线：ICD 编码一律有知识库出处（null 映射不编造）", icdProblems.length === 0, icdProblems.slice(0, 5).join(" | "))

const sample = bundles[0].bundle
const resources = sample.entry.map((e) => e.resource)
check("资源组合含 Patient/Encounter/Condition/Observation/DiagnosticReport 五类",
  ["Patient", "Encounter", "Condition", "Observation", "DiagnosticReport"].every((t) => resources.some((r) => r.resourceType === t)))
check("每个资源都有 resourceType 与 id", resources.every((r) => r.resourceType && r.id))
check("Condition 必带 clinicalStatus(active) 与 verificationStatus(unconfirmed)",
  resources.filter((r) => r.resourceType === "Condition")
    .every((r) => r.clinicalStatus.coding[0].code === "active" && r.verificationStatus.coding[0].code === "unconfirmed"))
const pat = resources.find((r) => r.resourceType === "Patient")
check("Patient.gender 取值在 administrative-gender 已核验码集内",
  VERIFIED[CS.gender].includes(pat.gender), pat.gender)
check("Patient 标注合成病例（红线：演示不含真实患者数据）",
  pat.extension.some((x) => x.url.endsWith("syntheticCase") && x.valueBoolean === true))
check("Encounter.class = v3-ActCode#AMB（ambulatory）", resources.find((r) => r.resourceType === "Encounter").class.code === "AMB")

const liveShaped = { ...bundles[0].dx, mode: "live", fallback_reason: "" }
const { toFhirBundle } = await import("../functions/lib/fhir.js")
check("live 链路报告状态为 final、降级为 partial（如实标注）",
  toFhirBundle(liveShaped).entry.map((e) => e.resource).find((r) => r.resourceType === "DiagnosticReport").status === "final"
  && resources.find((r) => r.resourceType === "DiagnosticReport").status === "partial")

const a = JSON.stringify(toFhirBundle(bundles[0].dx))
const b = JSON.stringify(toFhirBundle(bundles[0].dx))
check("同一输入两次导出逐字节相同（纯函数，零随机）", a === b)

const withFlags = await buildDiagnosis("c1", [{ role: "user", content: "压榨样胸痛伴冷汗，放射至左肩" }], {})
const flagRes = withFlags.fhir.entry.map((e) => e.resource).find((r) => r.resourceType === "Observation" && r.id === "flag-summary")
check("红旗命中时 Bundle 独立承载红旗明细（不可被模型侧覆盖）",
  withFlags.flags.length > 0 && flagRes.component.length > 0 && flagRes.valueCodeableConcept.text.includes("急性冠脉综合征"))
check("红旗命中时 Encounter.reasonReference 指向 flag-summary",
  (withFlags.fhir.entry.map((e) => e.resource).find((r) => r.resourceType === "Encounter").reasonReference || [])[0]?.reference === "Observation/flag-summary")

const noFlag = bundles.find((x) => x.dx.flags.length === 0)
check("未命中红旗时明确写「未命中红旗」而非留空",
  noFlag && noFlag.bundle.entry.map((e) => e.resource).find((r) => r.id === "flag-summary").valueCodeableConcept.text === "未命中红旗")

const presentForm = resources.find((r) => r.resourceType === "DiagnosticReport").presentForm || []
check("presentForm 链接全部来自本条 evidence 白名单（不引入新 URL）",
  presentForm.every((p) => bundles[0].dx.evidence.some((e) => e.url === p.url)))
check("presentForm 仅含 http(s) 链接", presentForm.every((p) => /^http/.test(p.url)))

const pySrc = readFileSync(fileURLToPath(new URL("../../backend/app/services/fhir.py", import.meta.url)), "utf8")
const missing = Object.values(CS).filter((u) => !pySrc.includes(u))
check("双端 CodeSystem URI 清单一致（防一端改绑另一端未改）", missing.length === 0, missing.join(" | "))
for (const f of CASE_IDS) {
  const cdx = await buildDiagnosis(f, [], {})
  check(`case ${f} 无问诊也能产出合法 Bundle（空历史兜底）`, Array.isArray(cdx.fhir.entry) && cdx.fhir.entry.length >= 4)
}

// 反例实测（R238：判据必须被违例样本喂过，否则「0 命中」可能只是判据没接线）
const clone = (o) => JSON.parse(JSON.stringify(o))
const res = (b, type, id) => b.entry.find((e) => e.resource.resourceType === type && (!id || e.resource.id === id)).resource
const poisons = [
  ["未登记 system", (b) => { res(b, "Condition").code.coding = [{ system: "http://hl7.org/fhir/sid/icd-9-cm", code: "410" }] }],
  ["已登记 system 内的非法 code", (b) => { res(b, "Condition").clinicalStatus.coding[0].code = "recurrent" }],
  ["悬挂 reference", (b) => { res(b, "Encounter").reasonReference = [{ reference: "Observation/nope-404" }] }],
  ["混入时钟字段", (b) => { b.timestamp = "2026-09-25T00:00:00Z" }],
  ["结论丢失医生终审文案", (b) => { res(b, "DiagnosticReport").conclusion = "诊断明确" }],
  ["编造无出处的 ICD 编码", (b) => { res(b, "Condition").code.coding = [{ system: CS.icd10, code: "Z99.9" }] }],
]
for (const [name, mutate] of poisons) {
  const bad = clone(bundles[0].bundle)
  mutate(bad)
  const s = scan(`poison:${name}`, bad)
  const caught = s.ref.length + s.code.length + s.clock.length + s.disclaimer.length + s.icd.length
  check(`反例可拦：${name}`, caught > 0, "判据未接线，违例零命中")
}
const clean = scan("control", bundles[0].bundle)
check("对照组：合法 Bundle 五类判据零命中（反例不是恒真）",
  Object.values(clean).every((arr) => arr.length === 0))

console.log(`\nFHIR GUARD SUMMARY: bundles=${bundles.length} resources=${bundles.reduce((n, x) => n + x.bundle.entry.length, 0)} presentForm=${presentForm.length}`)

console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
