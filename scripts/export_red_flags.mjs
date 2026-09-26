#!/usr/bin/env node
// data/red_flag_rules.json → frontend/functions/lib/red_flag_rules.js + backend/app/red_flag_rules.py
// 为什么要有这个生成器（第三十一轮 #89，承接第 30 轮的载入即校验）：红旗表是三条红线里唯一"数据即代码"的一张，
// 上一轮把**校验**补上了，但"改一条关键词要动两个源码文件"仍在——外置后改一处 JSON、跑一次导出，
// 双端生成物同刻同源，`red_flag_table_guard` 核「权威 == JS == Py」三方全等。
// 方向与 export_kb.mjs / export_scope.mjs 一致：单向生成、禁手改生成物。
// 铁律（lessons R48 内联→外置同族）：**读空/半空一律拒写盘**，绝不产出半成品或空表覆盖既有正确文件。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/red_flag_rules.json"
const JS_OUT = ROOT + "frontend/functions/lib/red_flag_rules.js"
const PY_OUT = ROOT + "backend/app/red_flag_rules.py"

const TOP_KEYS = ["schema_version", "bp", "negation", "positive_terms", "danger", "combo"]
const DANGER_FIELDS = ["name", "keywords", "severity", "advice"]
const COMBO_FIELDS = ["name", "all", "severity", "advice"]
// 条数下限是**当轮实交付量**留出的半空哨兵：读漏一段（分隔符/正则/键名写错）通常表现为条数骤减，
// 而不是零——所以只判 0 不够（lessons R48 的第二次踩法就是"抽到 1 个当 125 个用"）。
const MIN_COUNTS = { danger: 10, combo: 3, negation_tokens: 8 }

const src = JSON.parse(readFileSync(AUTHORITY, "utf8"))
const abort = (msg) => { console.error(`FAIL 生成中止（未写任何文件）：${msg}`); process.exit(2) }

const unknownTop = Object.keys(src).filter((k) => !TOP_KEYS.includes(k) && !k.startsWith("_"))
if (unknownTop.length) abort(`顶层未声明键 ${unknownTop.join(",")}（要么实现它，要么删掉它，不留哑字段）`)
for (const k of TOP_KEYS) if (src[k] === undefined) abort(`缺顶层键 ${k}`)
if (typeof src.schema_version !== "number" || src.schema_version < 1) abort("schema_version 必须是正整数")
if (!Array.isArray(src.danger) || !Array.isArray(src.combo)) abort("danger/combo 必须是数组")
if (src.danger.length < MIN_COUNTS.danger) abort(`danger 只有 ${src.danger.length} 条，低于下限 ${MIN_COUNTS.danger}（读空/半空＝提取环节坏了，禁止用残缺表覆盖生成物）`)
if (src.combo.length < MIN_COUNTS.combo) abort(`combo 只有 ${src.combo.length} 条，低于下限 ${MIN_COUNTS.combo}`)
const tokens = src.negation?.tokens
if (!Array.isArray(tokens) || tokens.length < MIN_COUNTS.negation_tokens) abort(`negation.tokens 只有 ${Array.isArray(tokens) ? tokens.length : "非数组"} 项，低于下限 ${MIN_COUNTS.negation_tokens}`)
if (!Array.isArray(src.positive_terms)) abort("positive_terms 必须是数组（可为空，但必须是数组）")
if (typeof src.negation.lookbehind_chars !== "number" || src.negation.lookbehind_chars < 1) abort("negation.lookbehind_chars 必须是正整数")
for (const k of ["systolic_crisis", "diastolic_crisis", "plausible_max_systolic", "plausible_max_diastolic", "plausible_min_systolic", "plausible_min_diastolic"]) {
  if (typeof src.bp[k] !== "number") abort(`bp.${k} 必须是数值`)
}

const pick = (r, fields, at) => {
  if (!r || typeof r !== "object") abort(`${at} 不是对象`)
  const missing = fields.filter((f) => r[f] === undefined)
  if (missing.length) abort(`${at} 缺字段 ${missing.join(",")}（不产出半成品）`)
  const extra = Object.keys(r).filter((k) => !fields.includes(k) && !k.startsWith("_"))
  if (extra.length) abort(`${at} 有未声明字段 ${extra.join(",")}`)
  return Object.fromEntries(fields.map((f) => [f, r[f]]))
}
const danger = src.danger.map((r, i) => pick(r, DANGER_FIELDS, `danger#${i}(${r?.name || "?"})`))
const combo = src.combo.map((r, i) => pick(r, COMBO_FIELDS, `combo#${i}(${r?.name || "?"})`))

const BP = src.bp
const NEG = { tokens, lookbehind_chars: src.negation.lookbehind_chars }
const POS = src.positive_terms
const pyVal = (v) => (Array.isArray(v)
  ? "[" + v.map((x) => pyVal(x)).join(", ") + "]"
  : v && typeof v === "object"
    ? "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyVal(x)}`).join(", ") + "}"
    : JSON.stringify(v))

const head = (lang) => lang === "js"
  ? ["// 红旗规则表（构建期产物，禁手改）——由 scripts/export_red_flags.mjs 从 data/red_flag_rules.json 生成。",
    `// schema_version=${src.schema_version}；改表请改权威文件后跑 \`npm run redflags:export\`。`,
    "// 三方全等由 frontend/tests/red_flag_table_guard.mjs 对账；六类不变量由 functions/lib/rules.js 的载入期校验把守。"].join("\n")
  : ["# 红旗规则表（构建期产物，禁手改）——由 scripts/export_red_flags.mjs 从 data/red_flag_rules.json 生成。",
    `# schema_version=${src.schema_version}；与 functions/lib/red_flag_rules.js 同源同值，由 red_flag_table_guard.mjs 对账。`,
    "from typing import Any"].join("\n")

const js = head("js") + "\n\n"
  + `export const RED_FLAG_SCHEMA = ${JSON.stringify(src.schema_version)};\n`
  + `export const BP_THRESHOLDS = ${JSON.stringify(BP)};\n`
  + `export const NEGATION = ${JSON.stringify(NEG)};\n`
  + `export const POSITIVE_TERMS = ${JSON.stringify(POS)};\n`
  + "export const DANGER_RULES = [\n" + danger.map((r) => "  " + JSON.stringify(r) + ",").join("\n") + "\n];\n"
  + "export const COMBO_RULES = [\n" + combo.map((r) => "  " + JSON.stringify(r) + ",").join("\n") + "\n];\n"
const py = head("py") + "\n\n"
  + `RED_FLAG_SCHEMA: int = ${JSON.stringify(src.schema_version)}\n`
  + `BP_THRESHOLDS: dict[str, Any] = ${pyVal(BP)}\n`
  + `NEGATION: dict[str, Any] = ${pyVal(NEG)}\n`
  + `POSITIVE_TERMS: list[dict[str, Any]] = ${pyVal(POS)}\n`
  + "DANGER_RULES: list[dict[str, Any]] = [\n"
  + danger.map((r) => "    {" + DANGER_FIELDS.map((f) => `"${f}": ${pyVal(r[f])}`).join(", ") + "},").join("\n") + "\n]\n"
  + "COMBO_RULES: list[dict[str, Any]] = [\n"
  + combo.map((r) => "    {" + COMBO_FIELDS.map((f) => `"${f}": ${pyVal(r[f])}`).join(", ") + "},").join("\n") + "\n]\n"

if (process.argv.includes("--check")) {
  // 「生成物 == 权威」的新鲜度判据：不写盘，只把即将写出的内容与盘上现有内容逐字节比。
  // 没有这一步，"改了 JSON 忘了导出"要等到某次守卫比对才暴露；而 CI 里跑一次 --check 是零成本的。
  const { existsSync } = await import("node:fs")
  const drift = []
  for (const [file, want] of [[JS_OUT, js], [PY_OUT, py]]) {
    if (!existsSync(file)) { drift.push(`${file}：不存在`); continue }
    if (readFileSync(file, "utf8") !== want) drift.push(`${file}：与权威不同（跑 npm run redflags:export）`)
  }
  if (drift.length) { console.error(`FAIL 生成物漂移：\n  - ${drift.join("\n  - ")}`); process.exit(1) }
  console.log(`[GATE:redflags-export-check-pass] 两份生成物与权威逐字节一致（danger=${danger.length} combo=${combo.length}）`)
  process.exit(0)
}
writeFileSync(JS_OUT, js)
writeFileSync(PY_OUT, py)
console.log(`generated: danger=${danger.length} combo=${combo.length} tokens=${NEG.tokens.length} positives=${POS.length} → JS + Py`)
console.log(`[GATE:redflags-export-pass] ${JS_OUT.replace(ROOT, "")} / ${PY_OUT.replace(ROOT, "")}`)
