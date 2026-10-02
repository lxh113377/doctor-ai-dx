// CDS Hooks 服务目录守卫（第八十五轮对标落地；npm test 第 29 件套的前半）。
// 分工：本件管**目录本体**（权威 JSON ⇄ JS 生成物 ⇄ Py 生成物 三方全等 + 规范形 + 红线承载位），
//       cds_hooks_guard.mjs 管**对外行为**（discovery / cards / 4xx 的双端一致与反例）。
// 为什么值得单独成件：目录是对外承诺的集成面。一旦与实现分叉，集成方按 discovery 接线就会拿到
// 另一套东西——这正是仓内 AGENTS §4「不要新增第二份真值」在 hooks 面的落法。
// 判据带变异自证：只测「通过」的守卫等于没测（负例优先）；下方 8 个坏样本每一个都必须被拒。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  CDS_DETAIL_TEMPLATES,
  CDS_INDICATOR_MAP,
  CDS_OVERRIDE_REASONS,
  CDS_SCHEMA,
  CDS_SERVICES,
  CDS_SOURCE,
  CDS_SPEC_VERSION,
  CDS_SUMMARY_TEMPLATES,
  CDS_URGENCIES,
} from "../functions/lib/cds_services.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v)
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

const authority = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/cds_services.json", import.meta.url)), "utf8"))
const pyOut = execFileSync(process.env.PYTHON_BIN || "python", ["tests/cds_dump.py"],
  { cwd: `${ROOT}backend`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
let py
try { py = JSON.parse(pyOut.trim().split("\n").pop()).catalog } catch {
  console.error("Py catalog dump 不是合法 JSON：\n" + pyOut.slice(0, 400)); process.exit(1)
}

console.log("== 1. 输入非空证明（读空＝判据失效，不许静默通过）==")
check(`JS 目录规模非空（services=${CDS_SERVICES.length} overrideReasons=${CDS_OVERRIDE_REASONS.length}）`,
  CDS_SERVICES.length >= 2 && CDS_OVERRIDE_REASONS.length >= 3, "低于下限＝表被读空或整体改写")
check(`Py 目录规模非空（services=${py.services.length} reasons=${py.override_reasons.length}）`,
  py.services.length >= 2 && py.override_reasons.length >= 3)
check(`权威目录规模非空（services=${authority.services.length} reasons=${authority.overrideReasons.length}）`,
  authority.services.length >= 2 && authority.overrideReasons.length >= 3)

console.log("== 2. 三方全等：权威 JSON == JS 生成物 == Py 生成物 ==")
check("服务清单三方全等", sameJSON(authority.services, CDS_SERVICES) && sameJSON(CDS_SERVICES, py.services),
  `权威=${authority.services.map((s) => s.id).join("/")} JS=${CDS_SERVICES.map((s) => s.id).join("/")} Py=${py.services.map((s) => s.id).join("/")}`)
check("source / urgencies / indicatorMap 三方全等",
  sameJSON(authority.source, CDS_SOURCE) && sameJSON(CDS_SOURCE, py.source)
  && sameJSON(authority.urgencies, CDS_URGENCIES) && sameJSON(CDS_URGENCIES, py.urgencies)
  && sameJSON(authority.indicatorMap, CDS_INDICATOR_MAP) && sameJSON(CDS_INDICATOR_MAP, py.indicator_map))
check("overrideReasons 三方全等", sameJSON(authority.overrideReasons, CDS_OVERRIDE_REASONS)
  && sameJSON(CDS_OVERRIDE_REASONS, py.override_reasons))
check("文案模板三方全等（summary+detail）",
  sameJSON(authority.summaryTemplates, CDS_SUMMARY_TEMPLATES) && sameJSON(CDS_SUMMARY_TEMPLATES, py.summary_templates)
  && sameJSON(authority.detailTemplates, CDS_DETAIL_TEMPLATES) && sameJSON(CDS_DETAIL_TEMPLATES, py.detail_templates),
  `JS summary keys=${Object.keys(CDS_SUMMARY_TEMPLATES).join(",")}`)
check("specVersion 三方全等", authority.specVersion === CDS_SPEC_VERSION && CDS_SPEC_VERSION === py.spec_version,
  `权威=${authority.specVersion} JS=${CDS_SPEC_VERSION} Py=${py.spec_version}`)
check("schema_version 双端一致", CDS_SCHEMA === authority.schema_version && CDS_SCHEMA === py.schema_version,
  `JS=${CDS_SCHEMA} 权威=${authority.schema_version} Py=${py.schema_version}`)
const checkOut = execFileSync(process.execPath, ["scripts/export_cds_services.mjs", "--check"],
  { cwd: ROOT, encoding: "utf8" })
check("生成物与权威逐字节一致（cds:check 不写盘只比对）",
  checkOut.includes("[GATE:cds-export-check-pass]"), checkOut.slice(0, 200))

console.log("== 3. 规范形：字段集合必须恰好是规范声明的那些（多一个也是错）==")
const SERVICE_FIELDS = ["id", "hook", "title", "description", "usageRequirements"]
// 本件用的校验器与生成器里的字段白名单同源同判据；这里**独立再判一次**，
// 因为生成器只在写盘时跑——手改生成物（绕过导出）时只有本件会红。
function validateCatalog(cat) {
  const errs = []
  if (cat.specVersion !== "2.0") errs.push(`specVersion=${cat.specVersion}：适配层逐字段核过的是 2.0`)
  if (!Array.isArray(cat.urgencies) || cat.urgencies.join(",") !== "info,warning,critical") {
    errs.push(`urgencies 必须恰为 ["info","warning","critical"]（规范 Card Attributes 的允许集与顺序），实测 ${JSON.stringify(cat.urgencies)}`)
  }
  const seen = new Map()
  for (const s of cat.services || []) {
    const keys = Object.keys(s).sort().join(",")
    if (keys !== [...SERVICE_FIELDS].sort().join(",")) errs.push(`服务 ${s.id} 字段集=${keys}（规范 discovery 只声明这五个）`)
    if (!/^[a-z][a-z0-9-]*$/.test(s.id || "")) errs.push(`service id ${s.id} 不是小写连串形（要拼进 /cds-services/{id}）`)
    if (!/^[a-z][a-z0-9-]*$/.test(s.hook || "")) errs.push(`hook ${s.hook} 不是 noun-verb 形（规范 1122-1130 行）`)
    for (const f of SERVICE_FIELDS) if (!String(s[f] ?? "").trim()) errs.push(`服务 ${s.id} 的 ${f} 为空`)
    if (seen.has(s.id)) errs.push(`service id 重复：${s.id}（同一 id 在 discovery 里出现两次，路由归属不确定）`)
    seen.set(s.id, s.hook)
  }
  const indVals = Object.values(cat.indicatorMap || {})
  for (const v of indVals) if (!cat.urgencies.includes(v)) errs.push(`indicatorMap 值 ${v} 不在规范允许集`)
  if (new Set(indVals).size !== indVals.length) errs.push(`indicatorMap 非单射 ${JSON.stringify(cat.indicatorMap)}：不同严重度塌成同一档＝丢信息`)
  if (!String(cat.source?.label || "").includes("医生终审")) errs.push("source.label 不含「医生终审」（红线二的接口承载位）")
  if (!/^https:\/\//.test(String(cat.source?.url || ""))) errs.push(`source.url=${cat.source?.url}：规范要求生产用 https`)
  if ((cat.overrideReasons || []).length < 1) errs.push("overrideReasons 为空：不可驳回的卡等于强制医嘱")
  for (const r of cat.overrideReasons || []) {
    if (!String(r.display || "").trim()) errs.push(`overrideReason ${r.code} 的 display 为空（规范：给了理由就必须给 display）`)
    if (!String(r.system || "").trim()) errs.push(`overrideReason ${r.code} 缺 system`)
  }
  for (const k of ["red_flag", "scope"]) {
    const t = cat.summaryTemplates?.[k]
    if (!t) errs.push(`缺 summaryTemplates.${k}`)
    else if (t.length > 120) errs.push(`summaryTemplates.${k} 模板本体 ${t.length} 字符，加变量必超 <140`)
    if (!cat.detailTemplates?.[k]) errs.push(`缺 detailTemplates.${k}`)
  }
  if (Object.keys(cat.summaryTemplates || {}).length !== 2) errs.push(`summaryTemplates 键数=${Object.keys(cat.summaryTemplates || {}).length}，实现只消费 red_flag/scope 两个`)
  return errs
}
const liveCat = {
  specVersion: CDS_SPEC_VERSION, urgencies: CDS_URGENCIES, indicatorMap: CDS_INDICATOR_MAP,
  services: CDS_SERVICES, source: CDS_SOURCE, overrideReasons: CDS_OVERRIDE_REASONS,
  summaryTemplates: CDS_SUMMARY_TEMPLATES, detailTemplates: CDS_DETAIL_TEMPLATES,
}
const liveErrs = validateCatalog(liveCat)
check(`现役目录通过规范形校验（services=${liveCat.services.length}）`, liveErrs.length === 0, liveErrs.join(" | "))

console.log("== 4. 变异自证：八个坏目录必须逐个被拒（否则上面那条校验器是空的）==")
const clone = () => JSON.parse(JSON.stringify(liveCat))
const MUTS = [
  ["source.label 丢掉「医生终审」", (c) => { c.source.label = "基层AI辅助诊断" }],
  ["两个服务同 id", (c) => { c.services[1].id = c.services[0].id }],
  ["urgencies 顺序颠倒", (c) => { c.urgencies = ["critical", "warning", "info"] }],
  ["indicatorMap 中/低 塌成同档", (c) => { c.indicatorMap["低"] = c.indicatorMap["中"] }],
  ["服务缺 usageRequirements", (c) => { c.services[0].usageRequirements = "" }],
  ["source.url 降级成 http", (c) => { c.source.url = "http://doctor-ai-dx.pages.dev" }],
  ["overrideReason 的 display 为空", (c) => { c.overrideReasons[0].display = "  " }],
  ["模板多出无人消费的键", (c) => { c.summaryTemplates["orphan"] = "x" }],
]
let caught = 0
for (const [name, mutate] of MUTS) {
  const c = clone()
  mutate(c)
  const errs = validateCatalog(c)
  if (errs.length) { caught++; console.log("  PASS 变异被拒：", name, `→ ${errs[0].slice(0, 56)}`) }
  else console.log("  FAIL 变异未被拒：", name)
}
check(`八个变异体全部被拒（实测 ${caught}/8）`, caught === MUTS.length, `${MUTS.length - caught} 个坏目录被放行`)

console.log("== 5. 红线一的静态承载：适配层不得引用模型链路 ==")
for (const [file, banned] of [
  ["frontend/functions/lib/cds_hooks.js", ["engine.js", "llm", "fetch(", "DEEPSEEK", "rag.js", "Date.now", "Math.random"]],
  ["backend/app/services/cds_hooks.py", ["services.engine", "from .engine", "llm", "requests", "httpx", "time.", "random"]],
]) {
  const srcText = readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), "utf8")
  const hit = banned.filter((b) => srcText.includes(b))
  check(`${file} 不含模型/时钟/随机引用（禁串 ${banned.length} 个，命中 ${hit.length}）`, hit.length === 0, `实测命中 ${JSON.stringify(hit)}`)
}

console.log(`CDS 目录守卫: ${fail === 0 ? `ALL PASS(${pass})` : `FAIL(${fail})`}（三方全等 + 规范形 + ${MUTS.length} 变异 + 红线承载）`)
process.exit(fail === 0 ? 0 : 1)
