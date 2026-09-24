// ============================================================
// FHIR R4（light 子集）导出层：把诊断结果映射为标准资源 Bundle，
// 用于被既有 HIS / 公卫平台按标准接口集成。
//
// 设计约束（可实测）：
// 1. 纯函数：零网络、零随机、零时钟 → 双端（JS↔Py）输出可逐字段对账；
// 2. 只读派生视图：不参与决策链，红旗规则层 / 引用白名单 / 医生终审文案三条红线零触碰；
// 3. 术语绑定只使用 HL7 已发布工件中的 code（codesystem-*.json 实取），
//    未核验的编码一律只出 text、不编造 coding（含 icd 为 null 的条目）；
// 4. 自定义扩展统一走本仓命名空间，不声称符合官方 Profile。
// ============================================================

import { KB_BY_ID } from "./knowledge.js"

const CS = {
  gender: "http://hl7.org/fhir/administrative-gender",
  encounterStatus: "http://hl7.org/fhir/encounter-status",
  actCode: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  clinical: "http://terminology.hl7.org/CodeSystem/condition-clinical",
  verStatus: "http://terminology.hl7.org/CodeSystem/condition-ver-status",
  category: "http://terminology.hl7.org/CodeSystem/condition-category",
  obsStatus: "http://hl7.org/fhir/observation-status",
  reportStatus: "http://hl7.org/fhir/diagnostic-report-status",
  bundleType: "http://hl7.org/fhir/bundle-type",
  icd10: "http://hl7.org/fhir/sid/icd-10",
  // 本仓自定义命名空间（非官方 CodeSystem，仅作来源标注）
  caseSource: "urn:doctor-ai-dx:case-id",
  extBase: "https://github.com/lxh113377/doctor-ai-dx#fhir-light/",
}

const GENDER_BY_TEXT = { 男: "male", 女: "female", male: "male", female: "female" }

function textCoding(text, code, system) {
  const c = { text: String(text ?? "").slice(0, 200) }
  if (code) c.coding = [{ system, code, display: String(text ?? "").slice(0, 200) }]
  return c
}

// 组合条目按分号并列（如 "I20.0;I21"）；null/空串返回空数组 → 只出 text，不编造编码
function icdCodes(icd) {
  if (typeof icd !== "string") return []
  return icd.split(";").map((s) => s.trim()).filter(Boolean)
}

function patientEntry(dx) {
  const p = (dx.state && dx.state.patient) || {}
  const res = {
    resourceType: "Patient",
    id: `pat-${dx.state ? dx.state.case_id : "unknown"}`,
    identifier: [{ system: CS.caseSource, value: String(p.case_id || (dx.state && dx.state.case_id) || "unknown") }],
    extension: [
      { url: `${CS.extBase}syntheticCase`, valueBoolean: true },
      { url: `${CS.extBase}chiefComplaint`, valueString: String(p.chief || dx.state.transcript || "").slice(0, 200) },
    ],
  }
  if (p.name) res.name = [{ text: String(p.name).slice(0, 60) }]
  const gender = GENDER_BY_TEXT[p.gender]
  res.gender = gender || "unknown" // administrative-gender 已核验含 unknown
  return res
}

function encounterEntry(dx, patientRef) {
  const flags = (dx.flags || [])
  return {
    resourceType: "Encounter",
    id: `enc-${dx.state.case_id}`,
    status: "finished",
    class: { system: CS.actCode, code: "AMB", display: "ambulatory" },
    subject: patientRef,
    type: [textCoding("基层门诊首诊", null)],
    reasonCode: flags.length
      ? [textCoding(`红旗提示：${flags.slice(0, 4).join("、")}`, null)]
      : [textCoding("常见病多发病首诊鉴别", null)],
    reasonReference: flags.length ? [{ reference: "Observation/flag-summary" }] : [],
  }
}

function flagObservationEntry(dx, patientRef) {
  const details = Array.isArray(dx.flag_details) ? dx.flag_details : []
  return {
    resourceType: "Observation",
    id: "flag-summary",
    status: "final",
    category: [{ coding: [{ system: CS.category, code: "encounter-diagnosis" }] }],
    code: textCoding("危险信号（红旗规则层，独立于大模型）", "red-flag", `${CS.extBase}code`),
    subject: patientRef,
    valueCodeableConcept: textCoding(dx.flags && dx.flags.length ? dx.flags.slice(0, 6).join("；") : "未命中红旗", null),
    component: details.slice(0, 8).map((d) => ({
      code: textCoding("红旗条目", null),
      valueString: `${d.name}｜严重度 ${d.severity}｜${d.advice}`.slice(0, 400),
    })),
    reference: details.length ? [{ reference: "DiagnosticReport/dx-summary" }] : [],
  }
}

function symptomObservations(dx, patientRef) {
  const symptoms = (dx.state && dx.state.symptoms) || []
  return symptoms.slice(0, 12).map((s, i) => ({
    resourceType: "Observation",
    id: `symptom-${i + 1}`,
    status: "final",
    code: textCoding("症状/体征线索", null),
    subject: patientRef,
    valueString: String(s).slice(0, 120),
  }))
}

function conditionResources(dx) {
  const out = []
  const patientRef = { reference: `Patient/${`pat-${dx.state.case_id}`}` }
  const base = {
    resourceType: "Condition",
    subject: patientRef,
    clinicalStatus: { coding: [{ system: CS.clinical, code: "active" }] },
  }
  dx.primary.slice(0, 4).forEach((p, i) => {
    const codes = p.evidence_ids.flatMap((id) => icdCodes((KB_BY_ID.get(id) || {}).icd))
    const coding = [...new Set(codes)].map((c) => ({ system: CS.icd10, code: c }))
    out.push({
      ...base,
      id: `cond-primary-${i + 1}`,
      verificationStatus: { coding: [{ system: CS.verStatus, code: "unconfirmed" }] },
      category: [{ coding: [{ system: CS.category, code: "encounter-diagnosis" }] }],
      code: { text: p.name.slice(0, 60), ...(coding.length ? { coding } : {}) },
      note: [{ text: `优先级 ${p.prob}｜支持理由：${p.reasons.slice(0, 2).join("；")}`.slice(0, 300) }],
      evidence: p.evidence_ids.map((id) => ({ detail: [{ reference: `Observation/citation-${id}` }] })),
    })
  })
  dx.differential.slice(0, 6).forEach((d, i) => {
    const codes = d.evidence_ids.flatMap((id) => icdCodes((KB_BY_ID.get(id) || {}).icd))
    const coding = [...new Set(codes)].map((c) => ({ system: CS.icd10, code: c }))
    out.push({
      ...base,
      id: `cond-differential-${i + 1}`,
      verificationStatus: { coding: [{ system: CS.verStatus, code: "unconfirmed" }] },
      category: [{ coding: [{ system: CS.category, code: "problem-list-item" }] }],
      code: { text: d.name.slice(0, 60), ...(coding.length ? { coding } : {}) },
      note: d.note ? [{ text: d.note.slice(0, 300) }] : [],
      evidence: d.evidence_ids.map((id) => ({ detail: [{ reference: `Observation/citation-${id}` }] })),
    })
  })
  return out
}

// 每条引用证据落一个 Observation（citation-<kb-id>），使 Condition.evidence 的引用可解
function citationObservations(dx, patientRef) {
  const seen = new Set()
  const out = []
  for (const e of dx.evidence || []) {
    if (seen.has(e.id)) continue
    seen.add(e.id)
    out.push({
      resourceType: "Observation",
      id: `citation-${e.id}`,
      status: "final",
      code: textCoding("指南/共识证据引用", "citation", `${CS.extBase}code`),
      subject: patientRef,
      valueString: `${e.title}（${e.source}${e.year ? `，${e.year}` : ""}）`.slice(0, 300),
      method: textCoding(e.section || e.scope || "检索命中片段", null),
      data: [{ text: String(e.text || "").slice(0, 500) }],
    })
  }
  return out
}

function diagnosticReportEntry(dx, patientRef, resultRefs) {
  const fallback = dx.mode !== "live"
  const conclusionParts = [
    "AI 辅助参考 · 医生终审：本资源为决策支持输出，不构成诊断结论，编码与分期由执业医生核定。",
  ]
  if (dx.flags && dx.flags.length) conclusionParts.push(`红旗规则层命中 ${dx.flags.length} 项，须按建议优先处置/转诊。`)
  if (fallback) conclusionParts.push(`本次为降级链路（${dx.fallback_reason || "rule-fallback"}），结果置信度低于 live。`)
  const presentForm = (dx.evidence || [])
    .filter((e) => typeof e.url === "string" && e.url.startsWith("http"))
    .slice(0, 10)
    .map((e) => ({ url: e.url, title: `${e.title}`.slice(0, 200) }))
  return {
    resourceType: "DiagnosticReport",
    id: "dx-summary",
    status: fallback ? "partial" : "final",
    code: textCoding("基层常见病多发病 AI 辅助鉴别诊断（FHIR-light）", null),
    subject: patientRef,
    resultsInterpreter: [{ display: "Doctor-AI-DX 辅助诊断链路" }],
    conclusion: conclusionParts.join(" ").slice(0, 900),
    result: resultRefs,
    extension: [
      { url: `${CS.extBase}pipelineMode`, valueString: dx.mode },
      { url: `${CS.extBase}redFlags`, valueString: (dx.flags || []).join("；") || "none" },
    ],
    ...(presentForm.length ? { presentForm } : {}),
  }
}

export function toFhirBundle(dx) {
  const src = dx && dx.state && dx.primary ? dx : { state: { case_id: "unknown", patient: {}, symptoms: [] }, primary: [], differential: [], evidence: [], flags: [], flag_details: [], mode: "rule-fallback", fallback_reason: "", ...(dx || {}) }
  const patient = patientEntry(src)
  const patientRef = { reference: `Patient/${patient.id}` }
  const citations = citationObservations(src, patientRef)
  const symptomObs = symptomObservations(src, patientRef)
  const flagObs = flagObservationEntry(src, patientRef)
  const conditions = conditionResources(src)
  const resultRefs = [flagObs, ...symptomObs, ...citations].map((r) => ({ reference: `Observation/${r.id}` }))
  const report = diagnosticReportEntry(src, patientRef, resultRefs)

  const entries = [
    { fullUrl: `urn:doctor-ai-dx:${patient.id}`, resource: patient },
    { fullUrl: `urn:doctor-ai-dx:enc-${src.state.case_id}`, resource: encounterEntry(src, patientRef) },
    ...conditions.map((r) => ({ fullUrl: `urn:doctor-ai-dx:${r.id}`, resource: r })),
    ...symptomObs.map((r) => ({ fullUrl: `urn:doctor-ai-dx:${r.id}`, resource: r })),
    { fullUrl: `urn:doctor-ai-dx:flag-summary`, resource: flagObs },
    ...citations.map((r) => ({ fullUrl: `urn:doctor-ai-dx:${r.id}`, resource: r })),
    { fullUrl: "urn:doctor-ai-dx:dx-summary", resource: report },
  ]
  return {
    resourceType: "Bundle",
    type: "collection",
    identifier: { system: CS.caseSource, value: `bundle-${src.state.case_id}` },
    entry: entries,
  }
}

export const FHIR_CODE_SYSTEMS = CS
