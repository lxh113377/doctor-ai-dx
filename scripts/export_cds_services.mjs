#!/usr/bin/env node
// data/cds_services.json → frontend/functions/lib/cds_services.js + backend/app/cds_services.py
// 为什么要有这个生成器（第八十五轮对标落地）：CDS Hooks 的服务目录是"对外集成面"的描述件，
// 权威面（Pages Functions/JS）与镜像面（FastAPI/Py）必须逐字段同形，否则同一个 hook 在两端返回不同
// title/usageRequirements，集成方按文档接线就会拿到另一套东西——这与 export_red_flags.mjs 立论相同：
// 一份真值两处抄＝漂移的开端，所以单向生成 + 三方全等判据（tests/cds_guard.mjs）。
// 方向：JSON 权威 → 双端生成物，禁手改生成物。
// 铁律（lessons R48 内联→外置同族）：**读空/半空一律拒写盘**，绝不产出半成品目录覆盖既有正确文件。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/cds_services.json"
const JS_OUT = ROOT + "frontend/functions/lib/cds_services.js"
const PY_OUT = ROOT + "backend/app/cds_services.py"

const TOP_KEYS = [
  "schema_version", "specVersion", "source", "indicatorMap", "urgencies",
  "services", "overrideReasons", "summaryTemplates", "detailTemplates",
]
// 服务条目的字段集＝CDS Hooks 2.0 discovery 对每个 service 的规定集（规范原文 46-131 行）。
// 刻意不含 capability/extension 等 2.0 未列项：写了就是"文档里没有却被我们声明"的第二真值。
const SERVICE_FIELDS = ["id", "hook", "title", "description", "usageRequirements"]
const SOURCE_FIELDS = ["label", "url"]
const REASON_FIELDS = ["code", "system", "display"]
const MIN_COUNTS = { services: 2, overrideReasons: 3 }
const TEMPLATE_KEYS = ["red_flag", "scope"]

const src = JSON.parse(readFileSync(AUTHORITY, "utf8"))
const abort = (msg) => { console.error(`FAIL 生成中止（未写任何文件）：${msg}`); process.exit(2) }

const unknownTop = Object.keys(src).filter((k) => !TOP_KEYS.includes(k) && !k.startsWith("_"))
if (unknownTop.length) abort(`顶层未声明键 ${unknownTop.join(",")}（要么实现它，要么删掉它，不留哑字段）`)
for (const k of TOP_KEYS) if (src[k] === undefined) abort(`缺顶层键 ${k}`)
if (typeof src.schema_version !== "number" || src.schema_version < 1) abort("schema_version 必须是正整数")
if (src.specVersion !== "2.0") abort(`specVersion 实测 ${JSON.stringify(src.specVersion)}：本适配层逐字段核过的是 2.0，声明别的版本即判红（不冒充未验证过的兼容性）`)
if (!Array.isArray(src.services) || src.services.length < MIN_COUNTS.services) abort(`services 只有 ${Array.isArray(src.services) ? src.services.length : "非数组"} 条，低于下限 ${MIN_COUNTS.services}`)
if (!Array.isArray(src.overrideReasons) || src.overrideReasons.length < MIN_COUNTS.overrideReasons) abort(`overrideReasons 少于 ${MIN_COUNTS.overrideReasons} 条：可驳回理由是「医生终审」红线的接口承载，缺它等于把卡变成强制医嘱`)
if (!Array.isArray(src.urgencies) || src.urgencies.join(",") !== "info,warning,critical") abort(`urgencies 必须是 ["info","warning","critical"]（规范原文 Card Attributes 的允许集与顺序），实测 ${JSON.stringify(src.urgencies)}`)

const pick = (r, fields, at) => {
  if (!r || typeof r !== "object") abort(`${at} 不是对象`)
  const missing = fields.filter((f) => r[f] === undefined || String(r[f]).trim() === "")
  if (missing.length) abort(`${at} 缺字段 ${missing.join(",")}（不产出半成品）`)
  const extra = Object.keys(r).filter((k) => !fields.includes(k) && !k.startsWith("_"))
  if (extra.length) abort(`${at} 有未声明字段 ${extra.join(",")}`)
  return Object.fromEntries(fields.map((f) => [f, r[f]]))
}
const services = src.services.map((r, i) => pick(r, SERVICE_FIELDS, `services#${i}(${r?.id || "?"})`))
const ids = services.map((s) => s.id)
if (new Set(ids).size !== ids.length) abort(`services id 重复：${ids.join(",")}（id 是 URL 路径段，重复即路由不确定）`)
for (const s of services) {
  if (!/^[a-z][a-z0-9-]*$/.test(s.id)) abort(`service id ${s.id} 不是小写连串形（要拼进 /cds-services/{id}）`)
  if (!/^[a-z][a-z0-9-]*$/.test(s.hook)) abort(`hook ${s.hook} 不是 noun-verb 形（规范 1122-1130 行：主语在前、活动在后）`)
}
const source = pick(src.source, SOURCE_FIELDS, "source")
if (!source.label.includes("医生终审")) abort(`source.label 未含「医生终审」：这条是产品红线二的接口承载位——CDS 客户端常驻渲染 source.label，写在这里才叫"持续显示"，实测值 ${JSON.stringify(source.label)}`)
if (!/^https:\/\//.test(source.url)) abort(`source.url 必须是 https 绝对地址（规范：生产数据交换 scheme MUST be https），实测 ${JSON.stringify(source.url)}`)
const reasons = src.overrideReasons.map((r, i) => pick(r, REASON_FIELDS, `overrideReasons#${i}`))
for (const r of reasons) if (!r.display.trim()) abort(`overrideReasons ${r.code} 的 display 为空（规范明文：给了理由就必须给 display）`)
const imap = src.indicatorMap
for (const sev of ["高", "中", "低"]) {
  if (!imap[sev]) abort(`indicatorMap 缺严重度 ${sev}`)
  if (!src.urgencies.includes(imap[sev])) abort(`indicatorMap[${sev}] = ${imap[sev]} 不在规范允许集内`)
}
const dupInd = Object.values(imap).filter((v, i, a) => a.indexOf(v) !== i)
if (dupInd.length) abort(`indicatorMap 把不同严重度映射到同一 indicator ${dupInd.join(",")}：三档严重度塌成两档就等于丢信息`)
const sumT = src.summaryTemplates
const detT = src.detailTemplates
for (const k of TEMPLATE_KEYS) {
  if (!sumT[k] || !detT[k]) abort(`summaryTemplates.${k} / detailTemplates.${k} 缺失`)
  if (sumT[k].length > 120) abort(`summaryTemplates.${k} 模板本身 ${sumT[k].length} 字符，加上变量必超规范的 <140`)
}
if (Object.keys(sumT).length !== TEMPLATE_KEYS.length || Object.keys(detT).length !== TEMPLATE_KEYS.length) abort(`模板键集合必须恰为 ${TEMPLATE_KEYS.join("/")}（多出来的键没人消费＝哑字段）`)

const pyVal = (v) => (Array.isArray(v)
  ? "[" + v.map((x) => pyVal(x)).join(", ") + "]"
  : v && typeof v === "object"
    ? "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyVal(x)}`).join(", ") + "}"
    : JSON.stringify(v))

const head = (lang) => lang === "js"
  ? ["// CDS Hooks 服务目录（构建期产物，禁手改）——由 scripts/export_cds_services.mjs 从 data/cds_services.json 生成。",
    `// schema_version=${src.schema_version}；改目录请改权威文件后跑 \`npm run cds:export\`。`,
    "// 三方全等（权威⇄JS⇄Py）与逐字段规范形由 frontend/tests/cds_guard.mjs 对账。"].join("\n")
  : ["# CDS Hooks 服务目录（构建期产物，禁手改）——由 scripts/export_cds_services.mjs 从 data/cds_services.json 生成。",
    `# schema_version=${src.schema_version}；与 functions/lib/cds_services.js 同源同值，由 cds_guard.mjs 对账。`,
    "from typing import Any"].join("\n")

const js = head("js") + "\n\n"
  + `export const CDS_SCHEMA = ${JSON.stringify(src.schema_version)};\n`
  + `export const CDS_SPEC_VERSION = ${JSON.stringify(src.specVersion)};\n`
  + `export const CDS_SOURCE = ${JSON.stringify(source)};\n`
  + `export const CDS_URGENCIES = ${JSON.stringify(src.urgencies)};\n`
  + `export const CDS_INDICATOR_MAP = ${JSON.stringify(imap)};\n`
  + "export const CDS_SERVICES = [\n" + services.map((s) => "  " + JSON.stringify(s) + ",").join("\n") + "\n];\n"
  + "export const CDS_OVERRIDE_REASONS = [\n" + reasons.map((r) => "  " + JSON.stringify(r) + ",").join("\n") + "\n];\n"
  + `export const CDS_SUMMARY_TEMPLATES = ${JSON.stringify(sumT)};\n`
  + `export const CDS_DETAIL_TEMPLATES = ${JSON.stringify(detT)};\n`
const py = head("py") + "\n\n"
  + `CDS_SCHEMA: int = ${JSON.stringify(src.schema_version)}\n`
  + `CDS_SPEC_VERSION: str = ${JSON.stringify(src.specVersion)}\n`
  + `CDS_SOURCE: dict[str, Any] = ${pyVal(source)}\n`
  + `CDS_URGENCIES: list[str] = ${pyVal(src.urgencies)}\n`
  + `CDS_INDICATOR_MAP: dict[str, Any] = ${pyVal(imap)}\n`
  + "CDS_SERVICES: list[dict[str, Any]] = [\n"
  + services.map((s) => "    {" + SERVICE_FIELDS.map((f) => `"${f}": ${pyVal(s[f])}`).join(", ") + "},").join("\n") + "\n]\n"
  + "CDS_OVERRIDE_REASONS: list[dict[str, Any]] = [\n"
  + reasons.map((r) => "    {" + REASON_FIELDS.map((f) => `"${f}": ${pyVal(r[f])}`).join(", ") + "},").join("\n") + "\n]\n"
  + `CDS_SUMMARY_TEMPLATES: dict[str, Any] = ${pyVal(sumT)}\n`
  + `CDS_DETAIL_TEMPLATES: dict[str, Any] = ${pyVal(detT)}\n`

if (process.argv.includes("--check")) {
  // 「生成物 == 权威」的新鲜度判据：不写盘，只把即将写出的内容与盘上现有内容逐字节比。
  const { existsSync } = await import("node:fs")
  const drift = []
  for (const [file, want] of [[JS_OUT, js], [PY_OUT, py]]) {
    if (!existsSync(file)) { drift.push(`${file}：不存在`); continue }
    if (readFileSync(file, "utf8") !== want) drift.push(`${file}：与权威不同（跑 npm run cds:export）`)
  }
  if (drift.length) { console.error(`FAIL 生成物漂移：\n  - ${drift.join("\n  - ")}`); process.exit(1) }
  console.log(`[GATE:cds-export-check-pass] 两份生成物与权威逐字节一致（services=${services.length} reasons=${reasons.length}）`)
  process.exit(0)
}
writeFileSync(JS_OUT, js)
writeFileSync(PY_OUT, py)
console.log(`generated: services=${services.length} reasons=${reasons.length} spec=${src.specVersion} → JS + Py`)
console.log(`[GATE:cds-export-pass] ${JS_OUT.replace(ROOT, "")} / ${PY_OUT.replace(ROOT, "")}`)
