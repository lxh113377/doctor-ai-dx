// CDS Hooks 2.0 适配层（第八十五轮对标落地；权威面 JS，镜像面 backend/app/services/cds_hooks.py 同形）
// 立论（对标实测）：openmrs-core / cqframework 系与 Epic 生态都用 CDS Hooks 作为「决策支持能力单元」
// 的标准挂载面，而我方 08 节话术二自称「可被既有 HIS/公卫平台集成的能力单元」却只有自研 /api/*——
// 主张无接口承载。本层补的就是这一层：**不改引擎、不调模型**，只把已有的确定性规则层映射成规范卡。
// 规范字段逐字取自 HL7/cds-hooks-hl7-site docs/2.0/index.md（discovery 46-131 行 / 请求 134-155 行 /
// Card Attributes 491-541 行），不凭记忆；与本层配套的常驻判据 = frontend/tests/cds_hooks_guard.mjs。
// 三条产品红线在本层的落法：
//   一 红旗独立于 LLM ⇒ 卡片只由 rules.js 的规则表产出，本文件不 import 引擎、不发网络、不读密钥；
//   二 全程「辅助参考 · 医生终审」⇒ 常驻位放在 card.source.label（客户端按规范渲染 source），
//      且每张卡都带 overrideReasons（可驳回＝医生可推翻），由 cds_guard 从权威 JSON 钉住在场；
//   三 只用脱敏合成病例 ⇒ patientId 只认 data.js 内置 c1/c2/c3，无任何真实患者索引。
import { CDS_SERVICES, CDS_SOURCE, CDS_INDICATOR_MAP, CDS_OVERRIDE_REASONS, CDS_SUMMARY_TEMPLATES, CDS_DETAIL_TEMPLATES } from "./cds_services.js"
import { scanFlagDetails, matchScopeRule } from "./rules.js"
import { CASES } from "./data.js"
import { RequestBadShape, MAX_HISTORY_ITEMS, MAX_CONTENT_CHARS } from "./limits.js"

/** 规范原文（Card Attributes）：summary 是 `<140-character`，即 139 为可接受上界。 */
export const SUMMARY_MAX_CHARS = 139

const SERVICE_BY_ID = new Map(CDS_SERVICES.map((s) => [s.id, s]))

/** GET /cds-services 的响应体：只出规范声明的五个字段，多一个都没有。 */
export function discoveryDocument() {
  return {
    services: CDS_SERVICES.map((s) => ({
      hook: s.hook,
      title: s.title,
      description: s.description,
      id: s.id,
      usageRequirements: s.usageRequirements,
    })),
  }
}

export function knownServiceIds() {
  return CDS_SERVICES.map((s) => s.id)
}

function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, key) => (vars[key] === undefined ? m : String(vars[key])))
}

/**
 * 规范外的字段（uuid / links / suggestions / selectionBehavior）一律不发：
 * uuid 需要唯一标识而本仓判据禁止卡内出现时钟与随机量（与 fhir_guard 的「零时钟字段」同口径）；
 * suggestions/links 需要写回或出处回链，前者我们没有 FHIR 写权限，后者正是台账 #203 未结的红旗出处缺口——
 * 给不出真出处就不填字段，而不是造一个看起来能用的链接。
 */
function makeCard(summaryTpl, detailTpl, vars, severity) {
  const raw = fill(summaryTpl, vars)
  return {
    summary: raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS - 1)}…` : raw,
    indicator: CDS_INDICATOR_MAP[severity] || "info",
    detail: fill(detailTpl, vars),
    source: { label: CDS_SOURCE.label, url: CDS_SOURCE.url },
    overrideReasons: CDS_OVERRIDE_REASONS,
  }
}

/**
 * 取待判读文字。两种输入都允许，且**沿用引擎 extractState 的同一种拼法**（chief 在前、补充文本用「；」连接）：
 * 另起一套拼法会让「hooks 面命中而 /api/dx 面不命中」成为可能，那是双端之外第三处漂移。
 */
function buildText(context) {
  const parts = []
  const pid = context.patientId
  if (typeof pid === "string" && pid.trim()) {
    const c = CASES.find((x) => x.id === pid)
    if (!c) throw new RequestBadShape(`context.patientId ${JSON.stringify(pid)} 不在内置脱敏病例名册（只认 ${CASES.map((x) => x.id).join("/")}）`)
    parts.push(c.chief)
  }
  const syms = context.symptoms
  if (syms !== undefined && syms !== null) {
    if (!Array.isArray(syms)) throw new RequestBadShape(`context.symptoms 类型 ${typeof syms} ≠ array`)
    if (syms.length > MAX_HISTORY_ITEMS) throw new RequestBadShape(`context.symptoms 条数 ${syms.length} > ${MAX_HISTORY_ITEMS}`)
    syms.forEach((s, i) => {
      if (typeof s !== "string") throw new RequestBadShape(`context.symptoms[${i}] 类型 ${typeof s} ≠ string`)
      if (s.length > MAX_CONTENT_CHARS) throw new RequestBadShape(`context.symptoms[${i}] 长度 ${s.length} > ${MAX_CONTENT_CHARS}`)
      // 只收非空白条目：全空白曾拼出"；   "这种**分隔符残留串**，trim 后非空 ⇒ 直接 200 空卡，
      // 把「根本没东西可判」说成「判过了没命中」（cds_hooks_guard 的 blank-symptoms 腿实测抓到）。
      if (s.trim()) parts.push(s)
    })
  }
  return parts.join("；")
}

/**
 * POST /cds-services/{id} 的响应体。调用方（路由）负责把这里抛出的 RequestBadShape 定成 422。
 * 空命中返回 cards: [] —— 规范明文允许（491-522 行），且比硬造一张 info 卡诚实：集成方看到空数组
 * 知道「规则层没命中」，看到一张卡则会当作建议。
 */
export function invokeService(serviceId, body) {
  const svc = SERVICE_BY_ID.get(serviceId)
  if (!svc) throw new NotFound(serviceId)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestBadShape("CDS Hooks 请求体必须是 JSON 对象")
  }
  for (const field of ["hook", "hookInstance"]) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      throw new RequestBadShape(`缺规范 REQUIRED 字段 ${field}`)
    }
  }
  if (body.context === null || typeof body.context !== "object" || Array.isArray(body.context)) {
    throw new RequestBadShape("缺规范 REQUIRED 字段 context（或类型不是 object）")
  }
  if (body.hook !== svc.hook) {
    throw new RequestBadShape(`hook=${body.hook} 与服务 ${serviceId} 在 discovery 中声明的 hook=${svc.hook} 不一致`)
  }
  const text = buildText(body.context)
  if (!text.trim()) throw new RequestBadShape(`context 里没有任何可判读文字（symptoms 缺失或全空白，patientId 未给）；本服务不返回空卡冒充「已评估」`)

  if (serviceId === "red-flag-screen") {
    const cards = scanFlagDetails(text).map((h) => makeCard(
      CDS_SUMMARY_TEMPLATES.red_flag, CDS_DETAIL_TEMPLATES.red_flag,
      { name: h.name, severity: h.severity, advice: h.advice }, h.severity,
    ))
    return { cards }
  }
  if (serviceId === "scope-boundary") {
    const rule = matchScopeRule(text)
    if (!rule) return { cards: [] }
    return {
      cards: [makeCard(
        CDS_SUMMARY_TEMPLATES.scope, CDS_DETAIL_TEMPLATES.scope,
        { title: rule.title, rationale: rule.rationale, doctor_note: rule.doctor_note, matched: rule.matched.join("、") },
        "中",
      )],
    }
  }
  // 目录里有服务但没有对应的判定分支＝数据领先于实现，属服务端自身不一致，交给路由记 error 并出 500。
  throw new Error(`cds service ${serviceId} 在目录中但没有实现分支`)
}

/** 未知服务：沿用仓内 {code,message} 错误形（与 route_guard 钉住的 404 契约同形，不另造第三种错误体）。 */
export class NotFound extends Error {
  constructor(serviceId) {
    super(`not found: cds-services/${serviceId}`)
    this.name = "CdsServiceNotFound"
    this.reason = `no such CDS service: ${serviceId}`
    this.status = 404
  }
}
