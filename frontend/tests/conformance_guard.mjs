#!/usr/bin/env node
// 对外契约一致性守卫（conformance guard）——第一百零九轮新增。
//
// 为什么立这条（第八维对标的**最强真差距**，非预防性加闸）：
//   第一百零七轮八维对标现取 peer 实测：`inferno-framework/smart-app-launch-test-kit` 有 31 个 release、
//   18 位贡献者，它存在的意义就是「**能集成**这句话可以被别人拿去跑」。我方 `lib/fhir.js`、
//   `lib/cds_hooks.js`、`lib/cds_services.js` 是**实现**，但此前没有任何一件是「第三方可以指向它做验证」
//   的契约面——差距量化：**对外契约测试 0 个 vs 现成套件 1 个**（报告 r107 §2.1 / R-6）。
//
// 本件补的正是那一层，且刻意与既有守卫分工不重叠：
//   `fhir_guard.mjs`      ── 管**资源内部**自洽（术语白名单、悬挂引用、零时钟字段）
//   `cds_hooks_guard.mjs` ── 管**双端行为**（JS 与 Py 逐条比对）
//   `api_contract_guard.mjs` ── 管**路由⇄openapi** 双向在场
//   本件                    ── 管**对外可被第三方自验的契约面**：一份声明式用例 JSON + 一条命令，
//                              外部集成方拿到仓库即可跑，不需要密钥、不需要部署、不需要读源码。
//
// 三条设计约束（都是本仓既有铁律）：
//   ① **零输入不记绿**：用例文件读不到／数组为空 ⇒ rc=2 BROKEN，绝不读成"没有要验的"。
//   ② **每条判据配反例腿**：`--selftest` 逐条喂坏样本，证明判据有牙（不是只有正例的守卫）。
//   ③ **默认零网络零密钥**：直驱 Functions 的 `onRequest`（Node 有 Request/Response 全局）；
//      给了 `--base` 才打真实部署，且此时只断言同一批不变量（不断言结论文本——live 走模型）。
//
// 用法：`node tests/conformance_guard.mjs`｜`--selftest`｜`--json`｜`--base https://doctor-ai-dx.pages.dev`
// 退出码：0 全过｜1 有违例｜2 取数面坏（用例读不到/为空、权威处理器取不到）
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
const SPEC_URL = new URL("./fixtures/conformance_cases.json", import.meta.url)

let pass = 0
let fail = 0
const rows = []
const check = (id, name, ok, detail = "") => {
  rows.push({ id, name, ok, detail })
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")) }
}

/** 纯判据体：喂「响应快照」即可双向验，不必起处理器（`--selftest` 就靠它）。 */
export function judgeDiscovery(spec, snap) {
  const errs = []
  if (!snap || typeof snap !== "object") return ["discovery 快照为空"]
  if (snap.status !== 200) errs.push(`status=${snap.status} ≠ 200`)
  const services = (snap.body && snap.body.services) || null
  if (!Array.isArray(services)) return ["discovery.body.services 不是数组（规范 2.0 Discovery 形）"]
  const ids = services.map((s) => s && s.id).filter(Boolean)
  for (const want of spec.service_ids) if (!ids.includes(want)) errs.push(`目录缺服务 ${want}（实测 ${ids.join("/")}）`)
  if (ids.length !== spec.service_ids.length) errs.push(`服务数 ${ids.length} ≠ 声明 ${spec.service_ids.length}（多出的也是漂移）`)
  for (const s of services) {
    const missing = spec.required_service_fields.filter((f) => s[f] === undefined)
    if (missing.length) errs.push(`服务 ${s.id || "?"} 缺规范字段 ${missing.join("/")}`)
  }
  return errs
}

export function judgeCard(spec, card) {
  const errs = []
  if (!card || typeof card !== "object") return ["卡不是对象"]
  const missing = spec.required_card_fields.filter((f) => card[f] === undefined)
  if (missing.length) errs.push(`卡缺规范字段 ${missing.join("/")}`)
  const extra = spec.forbidden_card_fields.filter((f) => card[f] !== undefined)
  if (extra.length) errs.push(`卡含规范外字段 ${extra.join("/")}（uuid/links 需唯一标识或写回权限，本仓给不出真值就不填）`)
  if (!spec.indicators.includes(card.indicator)) errs.push(`indicator=${JSON.stringify(card.indicator)} 不在规范三档 ${spec.indicators.join("/")}`)
  if (typeof card.summary === "string" && card.summary.length > spec.summary_max_chars) errs.push(`summary 长 ${card.summary.length} > ${spec.summary_max_chars}`)
  const label = (card.source && card.source.label) || ""
  if (!label.includes(spec.source_label_must_contain)) errs.push(`source.label 缺「${spec.source_label_must_contain}」（红线二：常驻位）`)
  if (!Array.isArray(card.overrideReasons) || card.overrideReasons.length === 0) errs.push("overrideReasons 空（医生可驳回＝可推翻，规范承载位）")
  return errs
}

/** FHIR Bundle 的**对外契约**面（资源内部自洽归 fhir_guard，此处只管集成方会依赖的不变量）。 */
export function judgeFhir(spec, bundle) {
  const errs = []
  if (!bundle || typeof bundle !== "object") return ["bundle 为空"]
  if (bundle.resourceType !== "Bundle") errs.push(`resourceType=${bundle.resourceType} ≠ Bundle`)
  if (bundle.type !== spec.bundle_type) errs.push(`type=${bundle.type} ≠ ${spec.bundle_type}`)
  const entries = Array.isArray(bundle.entry) ? bundle.entry : []
  if (entries.length === 0) return ["entry 为空（零输入不记绿）"]
  const types = entries.map((e) => e && e.resource && e.resource.resourceType)
  for (const want of spec.required_resource_types) if (!types.includes(want)) errs.push(`缺资源 ${want}`)
  for (const e of entries) {
    const r = e && e.resource
    if (!r) { errs.push("entry 缺 resource"); continue }
    if (typeof e.fullUrl !== "string" || !e.fullUrl) errs.push(`${r.resourceType} 缺 fullUrl`)
    if (r.resourceType === "Condition") {
      const miss = spec.condition_must_have.filter((f) => r[f] === undefined)
      if (miss.length) errs.push(`Condition 缺 ${miss.join("/")}`)
    }
    if (r.resourceType === "Observation") {
      const miss = spec.observation_must_have.filter((f) => r[f] === undefined)
      if (miss.length) errs.push(`Observation 缺 ${miss.join("/")}`)
      // value[x] 在 FHIR 里是**选择类型**：症状/引用走 valueString，红旗摘要走 valueCodeableConcept。
      // 只认一种＝把合法资源判成坏资源（本判据第一版就是这么写的，由真跑当场抓出）。
      const choices = spec.observation_value_choice || []
      if (!choices.some((f) => r[f] !== undefined)) errs.push(`Observation 缺 value[x]（${choices.join("|")} 一个都没有）`)
    }
    if (r.resourceType === "DiagnosticReport") {
      const miss = spec.diagnostic_report_must_have.filter((f) => r[f] === undefined)
      if (miss.length) errs.push(`DiagnosticReport 缺 ${miss.join("/")}`)
      const c = String(r.conclusion || "")
      if (!c.startsWith(spec.conclusion_prefix)) errs.push(`DiagnosticReport.conclusion 未以「${spec.conclusion_prefix}」开头（红线二）`)
    }
    if (r.resourceType === "Patient") {
      const exts = Array.isArray(r.extension) ? r.extension : []
      if (!exts.some((x) => x && x.url === spec.synthetic_extension_url && x.valueBoolean === true)) {
        errs.push("Patient 缺 syntheticCase=true 扩展（红线三：演示数据须可被下游区分）")
      }
    }
  }
  // 零时钟字段：同输入逐字节相同是 `test:contract` 能做的前提，也是集成方做缓存/幂等的依据。
  const flat = JSON.stringify(bundle)
  for (const f of spec.zero_clock_fields) if (flat.includes(`"${f}"`)) errs.push(`含时钟/元数据字段「${f}」⇒ 同输入不再逐字节相同`)
  return errs
}

/** 错误信封：所有码同形 + 文案零泄漏（集成方按这张表写分支）。 */
export function judgeEnvelope(spec, snap) {
  const errs = []
  const b = snap && snap.body
  if (!b || typeof b !== "object") return ["错误体不是对象"]
  const keys = Object.keys(b).sort().join(",")
  if (keys !== spec.error_shape_keys.join(",")) errs.push(`错误体键=${keys} ≠ ${spec.error_shape_keys.join(",")}`)
  const msg = String(b.message || "")
  for (const bad of spec.forbidden_in_error_message) if (msg.includes(bad)) errs.push(`message 含内部形态「${bad}」`)
  return errs
}

/** 卡片确定性：同输入两次逐字节相同（红旗面不经模型，也不含时钟/随机量）。 */
export function judgeDeterministic(a, b) {
  return a === b ? [] : ["同输入两次响应不一致（含时钟/随机量，或经了模型）"]
}

export function selftest() {
  const cases = []
  const push = (n, ok, got) => cases.push([n, ok, got])
  const spec = {
    service_ids: ["red-flag-screen"],
    required_service_fields: ["hook", "title", "description", "id", "usageRequirements"],
    required_card_fields: ["summary", "indicator", "detail", "source", "overrideReasons"],
    forbidden_card_fields: ["uuid", "links", "suggestions", "selectionBehavior"],
    summary_max_chars: 139,
    indicators: ["info", "warning", "critical"],
    source_label_must_contain: "医生终审",
    bundle_type: "collection",
    required_resource_types: ["Patient", "DiagnosticReport"],
    condition_must_have: ["code"],
    observation_must_have: ["status"],
    diagnostic_report_must_have: ["status", "conclusion"],
    zero_clock_fields: ["timestamp", "issued"],
    synthetic_extension_url: "https://github.com/lxh113377/doctor-ai-dx#fhir-light/syntheticCase",
    conclusion_prefix: "AI 辅助参考 · 医生终审",
    error_shape_keys: ["code", "message"],
    forbidden_in_error_message: ["at ", "file://"],
  }
  const svc = { hook: "patient-view", title: "t", description: "d", id: "red-flag-screen", usageRequirements: "u" }
  const discOk = { status: 200, body: { services: [svc] } }
  push("正例-discovery 合规", judgeDiscovery(spec, discOk).length === 0, "0")
  push("反例腿-discovery 缺服务 ⇒ 判红", judgeDiscovery(spec, { status: 200, body: { services: [] } }).length > 0, ">0")
  push("反例腿-discovery 多出服务也判红（多出的同样是漂移）",
    judgeDiscovery(spec, { status: 200, body: { services: [svc, { ...svc, id: "extra" }] } }).length > 0, ">0")
  push("反例腿-discovery 状态码非 200 ⇒ 判红", judgeDiscovery(spec, { status: 404, body: { services: [svc] } }).length > 0, ">0")

  const cardOk = { summary: "s", indicator: "critical", detail: "d", source: { label: "基层AI辅助诊断 · AI 辅助参考，医生终审", url: "u" }, overrideReasons: [{ code: "x" }] }
  push("正例-卡合规", judgeCard(spec, cardOk).length === 0, "0")
  push("反例腿-卡加 uuid ⇒ 判红（引入时钟/随机量）", judgeCard(spec, { ...cardOk, uuid: "1" }).length > 0, ">0")
  push("反例腿-卡 indicator 写 urgent ⇒ 判红", judgeCard(spec, { ...cardOk, indicator: "urgent" }).length > 0, ">0")
  push("反例腿-卡 source.label 去掉医生终审 ⇒ 判红", judgeCard(spec, { ...cardOk, source: { label: "基层AI辅助诊断" } }).length > 0, ">0")
  push("反例腿-卡 summary 撑到 140 ⇒ 判红", judgeCard(spec, { ...cardOk, summary: "x".repeat(140) }).length > 0, ">0")
  push("反例腿-卡删 overrideReasons ⇒ 判红", (() => { const c = { ...cardOk }; delete c.overrideReasons; return judgeCard(spec, c).length > 0 })(), ">0")

  const pat = { resourceType: "Patient", id: "pat-c1", extension: [{ url: spec.synthetic_extension_url, valueBoolean: true }] }
  const dr = { resourceType: "DiagnosticReport", status: "partial", conclusion: "AI 辅助参考 · 医生终审：降级" }
  const bundleOk = { resourceType: "Bundle", type: "collection", entry: [{ fullUrl: "urn:p", resource: pat }, { fullUrl: "urn:d", resource: dr }] }
  push("正例-FHIR 合规", judgeFhir(spec, bundleOk).length === 0, "0")
  push("反例腿-FHIR 注入 timestamp ⇒ 判红（同输入不再逐字节相同）",
    judgeFhir(spec, { ...bundleOk, entry: [...bundleOk.entry, { fullUrl: "urn:x", resource: { resourceType: "Observation", status: "final", timestamp: "2026" } }] }).length > 0, ">0")
  push("反例腿-FHIR DiagnosticReport 丢终审前缀 ⇒ 判红（红线二）",
    judgeFhir(spec, { ...bundleOk, entry: [bundleOk.entry[0], { fullUrl: "urn:d", resource: { ...dr, conclusion: "待医生终审" } }] }).length > 0, ">0")
  push("反例腿-FHIR Patient 缺 syntheticCase ⇒ 判红（红线三）",
    judgeFhir(spec, { ...bundleOk, entry: [{ fullUrl: "urn:p", resource: { resourceType: "Patient", id: "pat-c1" } }, bundleOk.entry[1]] }).length > 0, ">0")
  push("反例腿-FHIR 缺资源类型 ⇒ 判红", judgeFhir(spec, { resourceType: "Bundle", type: "collection", entry: [bundleOk.entry[0]] }).length > 0, ">0")

  push("正例-错误信封合规", judgeEnvelope(spec, { body: { code: 404, message: "not found: /api/nope" } }).length === 0, "0")
  push("反例腿-错误体多一个 detail 键 ⇒ 判红（镜像面曾吐 FastAPI 默认形）",
    judgeEnvelope(spec, { body: { code: 422, message: "x", detail: [] } }).length > 0, ">0")
  push("反例腿-错误文案含内部路径 ⇒ 判红", judgeEnvelope(spec, { body: { code: 500, message: "file:///app/x" } }).length > 0, ">0")
  push("反例腿-同输入两次不同 ⇒ 判红（确定性）", judgeDeterministic("a", "b").length > 0, ">0")

  let bad = 0
  for (const [n, ok, got] of cases) { console.log(`${ok ? "  pass" : "  FAIL"}  ${n}${ok ? "" : `（实得 ${String(got).slice(0, 60)}）`}`); if (!ok) bad++ }
  const neg = cases.filter(([n]) => n.startsWith("反例腿")).length
  console.log(`CONFORMANCE SELFTEST: ${bad === 0 ? "PASS" : `FAIL(${bad})`}（${cases.length} 例，含 ${neg} 条反例腿）｜rc=${bad === 0 ? 0 : 1}`)
  process.exit(bad === 0 ? 0 : 1)
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest()
  const asJson = process.argv.includes("--json")
  const baseIdx = process.argv.indexOf("--base")
  const base = baseIdx >= 0 ? process.argv[baseIdx + 1] : ""
  if (!base && !SPEC_URL) { console.error("[GATE:conformance:broken] 用例面取不到｜rc=2"); process.exit(2) }

  let spec
  try { spec = JSON.parse(readFileSync(SPEC_URL, "utf8")) } catch (e) {
    console.error(`[GATE:conformance:broken] 用例面读不到（${String(e.message).slice(0, 80)}）⇒ 零输入不得记绿｜rc=2`)
    process.exit(2)
  }
  if (!spec.cds || !Array.isArray(spec.cds.invocations) || spec.cds.invocations.length === 0) {
    console.error("[GATE:conformance:broken] 用例数组为空 ⇒ 判据没有被测对象｜rc=2")
    process.exit(2)
  }

  // 取数面：不给 --base 就直驱权威处理器（零网络零密钥）；给了就打真实部署（第三方自验线上）。
  let call, callCds
  if (base) {
    const doFetch = async (path, init) => {
      const res = await fetch(base.replace(/\/$/, "") + path, init)
      let body
      try { body = JSON.parse(await res.text()) } catch { body = null }
      return { status: res.status, body, headers: Object.fromEntries(res.headers) }
    }
    call = (path, init) => doFetch(path, init)
    callCds = (path, init) => doFetch(path, init)
  } else {
    let api, disc, invoke
    try {
      api = (await import("../functions/api/[[route]].js")).onRequest
      disc = (await import("../functions/cds-services/index.js")).onRequest
      invoke = (await import("../functions/cds-services/[service].js")).onRequest
    } catch (e) {
      console.error(`[GATE:conformance:broken] 权威处理器取不到（${String(e.message).slice(0, 80)}）｜rc=2`)
      process.exit(2)
    }
    const wrap = (fn) => async (path, init) => {
      const res = await fn({ request: new Request("https://dx.test" + path, init), env: {} })
      let body
      try { body = JSON.parse(await res.text()) } catch { body = null }
      return { status: res.status, body }
    }
    call = wrap(api)
    // ⚠️ CDS 面在 Pages 里是**两棵文件路由**：/cds-services → index.js，/cds-services/<id> → [service].js。
    //    直接拿一个处理器打所有路径＝自造一条线上不存在的路由（本判据第一版就这么错了，6 条调用腿全 404）。
    //    这里按同一份文件映射分发，被测行为才等于集成方真打到的那个处理器。
    const discWrapped = wrap(disc)
    const invokeWrapped = wrap(invoke)
    callCds = (p, init) => (p.replace(/\/$/, "") === "/cds-services" ? discWrapped(p, init) : invokeWrapped(p, init))
  }

  const jsonInit = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  console.log("== 0. 取数面非空证明（用例空了下面全部空转）==")
  check("SPEC", `用例面非空（invocations=${spec.cds.invocations.length} rejections=${spec.cds.rejections.length}）`,
    spec.cds.invocations.length >= 4 && spec.cds.rejections.length >= 4,
    "低于下限＝用例被裁剪，本件判定力不成立")

  console.log("== 1. CDS Hooks Discovery（集成方第一步必打的那个端点）==")
  const d = await callCds(spec.cds.discovery_path, { method: spec.cds.discovery_method })
  const dErrs = judgeDiscovery(spec.cds, d)
  check("DISCOVERY", "GET /cds-services 出规范形且服务集与声明全等", dErrs.length === 0, dErrs.slice(0, 3).join(" | "))
  // 方法探测：规范把路径钉死，非 GET 应落 404（本仓不引入 405，见 cds-services/index.js 头注）
  for (const p of spec.cds.method_probes) {
    // GET/HEAD 带 body 会被 undici 直接抛 TypeError（探针自身写错，不是被测对象的问题）⇒ 按方法给 init
    const init = p.method === "GET" || p.method === "HEAD" ? { method: p.method } : { method: p.method, headers: { "Content-Type": "application/json" }, body: "{}" }
    const r = await callCds(p.path, init)
    check("METHOD-" + p.id, `${p.method} ${p.path} → ${p.status}（不引入第四个错误码）`, r.status === p.status, `实测 ${r.status}`)
  }

  console.log("== 2. CDS 调用：卡片契约 + 行为承诺 + 确定性 ==")
  for (const c of spec.cds.invocations) {
    const r = await callCds("/cds-services/" + c.service, jsonInit({ hook: "patient-view", hookInstance: "cf-" + c.id, context: c.context }))
    const cards = (r.body && r.body.cards) || []
    const shapeErrs = cards.flatMap((card) => judgeCard(spec.cds, card))
    const inds = cards.map((x) => x.indicator)
    const indOk = JSON.stringify(inds) === JSON.stringify(c.expect.indicators)
    check("INVOKE-" + c.id,
      `${c.service} ${c.id}：${c.expect.card_count} 张卡／indicator ${c.expect.indicators.join(",") || "（空）"}`,
      r.status === 200 && cards.length === c.expect.card_count && indOk && shapeErrs.length === 0,
      `status=${r.status} cards=${cards.length} ind=${inds.join(",")} ${shapeErrs.slice(0, 2).join(" | ")}`)
    if (cards.length) {
      const r2 = await callCds("/cds-services/" + c.service, jsonInit({ hook: "patient-view", hookInstance: "cf2-" + c.id, context: c.context }))
      const errs = judgeDeterministic(JSON.stringify(r.body), JSON.stringify(r2.body))
      check("DETERMINISTIC-" + c.id, `${c.id}：同输入两次逐字节相同（红旗面不经模型、无时钟字段）`, errs.length === 0, errs.join(" | "))
    }
  }

  console.log("== 3. CDS 拒绝腿（集成方按这张表写分支）==")
  for (const rj of spec.cds.rejections) {
    const r = await callCds("/cds-services/" + rj.service, jsonInit(rj.body))
    const envErrs = judgeEnvelope(spec.envelope, r)
    check("REJECT-" + rj.id, `${rj.id} → ${rj.status}`, r.status === rj.status && envErrs.length === 0,
      `实测 ${r.status}（期望 ${rj.status}）${envErrs.slice(0, 2).join(" | ")}`)
  }

  console.log("== 4. FHIR-light：集成方依赖的资源不变量 ==")
  const dx = await call(spec.fhir.path, jsonInit(spec.fhir.request))
  const bundle = dx.body && dx.body.data && dx.body.data.fhir
  const fErrs = judgeFhir(spec.fhir, bundle)
  check("FHIR", `${spec.fhir.path} 的 data.fhir 满足对外资源不变量（${spec.fhir.required_resource_types.join("/")}）`,
    fErrs.length === 0, fErrs.slice(0, 3).join(" | "))
  if (bundle) {
    const dx2 = await call(spec.fhir.path, jsonInit(spec.fhir.request))
    const same = JSON.stringify(bundle) === JSON.stringify(dx2.body && dx2.body.data && dx2.body.data.fhir)
    check("FHIR-DETERMINISTIC", "同一请求两次 FHIR 逐字节相同（集成方可缓存/幂等）", same)
  }

  console.log("== 5. 信封与健康面（集成方启动自检）==")
  const health = await call(spec.envelope.health_path)
  check("HEALTH", "GET /api/health 出 {code:0,data:{llm_mode,version}}", health.status === 200 && health.body && health.body.code === 0
    && typeof (health.body.data || {}).llm_mode === "string" && typeof (health.body.data || {}).version === "string",
    JSON.stringify(health.body).slice(0, 120))
  const cs = await call(spec.envelope.cases_path)
  check("CASES", `GET /api/cases 出 ${spec.envelope.expected_case_count} 例脱敏合成病例`,
    cs.status === 200 && Array.isArray(cs.body && cs.body.data) && cs.body.data.length === spec.envelope.expected_case_count,
    `实测 ${cs.status}／${Array.isArray(cs.body && cs.body.data) ? cs.body.data.length : "非数组"}`)
  const nf = await call("/api/nope")
  const nfErrs = judgeEnvelope(spec.envelope, nf)
  check("ERROR-ENVELOPE", "未知路径 404 出 {code,message} 且文案零泄漏", nf.status === 404 && nfErrs.length === 0,
    `实测 ${nf.status} ${nfErrs.slice(0, 2).join(" | ")}`)

  const verdict = fail === 0 ? "pass" : "fail"
  const detail = `matched=${pass} mismatched=${fail}｜面 ${rows.length}｜mode=${base ? "live:" + base : "offline-inprocess"}`
  if (asJson) console.log(JSON.stringify({ state: fail === 0 ? "PASS" : "FAIL", pass, fail, rows, base: base || null }, null, 2))
  ;(asJson ? console.error : console.log)(`[GATE:conformance:${verdict}] ${detail}｜rc=${fail === 0 ? 0 : 1}`)
  process.exit(fail === 0 ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
