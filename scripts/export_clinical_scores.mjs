#!/usr/bin/env node
// data/clinical_scores.json → frontend/functions/lib/clinical_scores.js + backend/app/clinical_scores.py
// 第一百零四轮。方向与 export_red_flags.mjs / export_scope.mjs / export_knowledge.mjs 一致：
// JSON 权威 → 双端生成物，单向生成、禁手改生成物。
// 铁律（lessons R48 内联→外置同族）：**读空/半空一律拒写盘**，绝不产出半成品或空表覆盖既有正确文件。
// 与红旗生成器的差异只有一处，且是本轮实测逼出来的：量表条目里的阈值全部是**数值**，
// 而 JSON 里写 `"value": "22"` 这种字符串在 JS 里照样能跑（`"22" >= 22` 为 true，靠隐式转换），
// 到 Py 侧则直接 TypeError ⇒ 两端形状必须在生成期就锁成数值，不留给运行时翻译。
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/clinical_scores.json"
const JS_OUT = ROOT + "frontend/functions/lib/clinical_scores.js"
const PY_OUT = ROOT + "backend/app/clinical_scores.py"

const TOP_KEYS = ["schema_version", "plausible_ranges", "consciousness_tokens", "derived", "scores"]
const SCORE_FIELDS = ["id", "title", "source", "hint", "items", "bands"]
const ITEM_FIELDS = ["label", "need", "op", "value", "points"]
const ITEM_REQUIRED = ["label", "need", "points"]
const BAND_FIELDS = ["min", "max", "level", "advice", "department"]
// 去向是**可选字段**：advice 不含转诊动作的档位不许凭空挂科室（那是编造），含则必填且必须在名册内。
// 名册不另起一份——取红旗权威 data/red_flag_rules.json 的 referral_departments（单一真值，两表共用）。
const BAND_OPTIONAL = ["department"]
const TRANSFER_RE = /转诊|转运|转上级|送医/
const REFERRAL_ROSTER = JSON.parse(readFileSync(ROOT + "data/red_flag_rules.json", "utf8")).referral_departments
const OPS = [">=", "<=", ">", "<"]
const LEVELS = ["高", "中", "低"]
const NEED_KINDS = ["rr", "sbp", "hr", "spo2", "temperature_c", "consciousness", "si"]
const MIN_COUNTS = { scores: 2, items_per_score: 2, consciousness_tokens: 6 }

const abort = (msg) => { console.error(`FAIL 生成中止（未写任何文件）：${msg}`); process.exit(2) }

if (!existsSync(AUTHORITY)) abort(`权威文件不存在：${AUTHORITY}`)
if (!Array.isArray(REFERRAL_ROSTER) || !REFERRAL_ROSTER.length) abort("红旗权威 data/red_flag_rules.json 的 referral_departments 名册取不到 ⇒ 量表去向无处校验（共用名册断了要当场红，不是悄悄放行自由文本）")
let src
try { src = JSON.parse(readFileSync(AUTHORITY, "utf8")) } catch (e) { abort(`权威 JSON 解析失败：${e.message}`) }

const unknownTop = Object.keys(src).filter((k) => !TOP_KEYS.includes(k) && !k.startsWith("_"))
if (unknownTop.length) abort(`顶层未声明键 ${unknownTop.join(",")}（要么实现它，要么删掉它，不留哑字段）`)
for (const k of TOP_KEYS) if (src[k] === undefined) abort(`缺顶层键 ${k}`)
if (typeof src.schema_version !== "number" || src.schema_version < 1) abort("schema_version 必须是正整数")

const PR = src.plausible_ranges
const PR_KEYS = ["hr", "rr", "spo2", "temperature_c", "sbp"]
for (const k of PR_KEYS) {
  const v = PR[k]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    abort(`plausible_ranges.${k} 必须是两个数值的数组（脏读值域缺档＝脏读值直接进评分）`)
  }
  if (v[0] >= v[1]) abort(`plausible_ranges.${k} 下界必须小于上界，实测 ${v.join(",")}`)
}
if (!Array.isArray(src.consciousness_tokens) || src.consciousness_tokens.length < MIN_COUNTS.consciousness_tokens) {
  abort(`consciousness_tokens 只有 ${Array.isArray(src.consciousness_tokens) ? src.consciousness_tokens.length : "非数组"} 项，低于下限 ${MIN_COUNTS.consciousness_tokens}`)
}
for (const t of src.consciousness_tokens) {
  if (typeof t !== "string" || t.trim().length < 2) abort(`consciousness_tokens 含空值/裸单字「${t}」（裸单字子串会横扫全文，第二十四轮假阳性同族）`)
}

if (!Array.isArray(src.derived)) abort("derived 必须是数组（可为空，但必须是数组）")
const derived = src.derived.map((d, i) => {
  const at = `derived#${i}(${d?.id || "?"})`
  if (!d || typeof d !== "object") abort(`${at} 不是对象`)
  // `_` 前缀是文档位（_note/_editing），与顶层/scores 层同一口径；三处白名单漏一处就会在生成期
  // 拦下自己写的注释（本轮实测：derived#0 带 `_note` 直接 rc=2 零写盘）。
  const extra = Object.keys(d).filter((k) => !["id", "kind", "numerator", "denominator", "round"].includes(k) && !k.startsWith("_"))
  if (extra.length) abort(`${at} 有未声明字段 ${extra.join(",")}`)
  if (d.kind !== "ratio") abort(`${at} kind 目前只实现 ratio（写了没实装的形态＝假装它生效）`)
  for (const k of ["id", "numerator", "denominator"]) {
    if (typeof d[k] !== "string" || !d[k].trim()) abort(`${at}.${k} 必须是非空字符串`)
  }
  if (!Number.isInteger(d.round) || d.round < 0 || d.round > 4) abort(`${at}.round 必须是 0..4 的整数`)
  for (const k of ["numerator", "denominator"]) {
    if (!PR_KEYS.includes(d[k])) abort(`${at}.${k}="${d[k]}" 不在 plausible_ranges 名单内（派生量的输入没有值域护栏＝脏读值进评分）`)
  }
  return { id: d.id, kind: d.kind, numerator: d.numerator, denominator: d.denominator, round: d.round }
})
const DERIVED_IDS = derived.map((d) => d.id)

if (!Array.isArray(src.scores) || src.scores.length < MIN_COUNTS.scores) {
  abort(`scores 只有 ${Array.isArray(src.scores) ? src.scores.length : "非数组"} 条，低于下限 ${MIN_COUNTS.scores}（读空/半空＝提取环节坏了，禁止用残缺表覆盖生成物）`)
}
const ids = new Set()
const scores = src.scores.map((s, i) => {
  const at = `scores#${i}(${s?.id || "?"})`
  if (!s || typeof s !== "object") abort(`${at} 不是对象`)
  const missing = SCORE_FIELDS.filter((f) => s[f] === undefined)
  if (missing.length) abort(`${at} 缺字段 ${missing.join(",")}（不产出半成品）`)
  const extra = Object.keys(s).filter((k) => !SCORE_FIELDS.includes(k) && !k.startsWith("_"))
  if (extra.length) abort(`${at} 有未声明字段 ${extra.join(",")}`)
  if (ids.has(s.id)) abort(`${at} 的 id 与前一条重复（同名会让双端对账把两条并成一条）`)
  ids.add(s.id)
  if (typeof s.source !== "string" || s.source.trim().length < 8) abort(`${at}.source 缺失或过短——阈值没有公开出处就不许进临床判读层`)
  if (!Array.isArray(s.items) || s.items.length < MIN_COUNTS.items_per_score) abort(`${at}.items 少于 ${MIN_COUNTS.items_per_score} 项`)
  const items = s.items.map((it, j) => {
    const itAt = `${at}/items#${j}(${it?.label || "?"})`
    if (!it || typeof it !== "object") abort(`${itAt} 不是对象`)
    const missReq = ITEM_REQUIRED.filter((f) => it[f] === undefined)
    if (missReq.length) abort(`${itAt} 缺必填字段 ${missReq.join(",")}`)
    const itExtra = Object.keys(it).filter((k) => !ITEM_FIELDS.includes(k) && !k.startsWith("_"))
    if (itExtra.length) abort(`${itAt} 有未声明字段 ${itExtra.join(",")}`)
    if (!NEED_KINDS.includes(it.need) && !DERIVED_IDS.includes(it.need)) {
      abort(`${itAt}.need="${it.need}" 既不在取值名单 ${NEED_KINDS.join("/")} 也不是派生量 ${DERIVED_IDS.join("/") || "（无）"}`)
    }
    if (!("value" in it)) {
      if (it.op !== undefined) abort(`${itAt} 无 value 却给了 op（无阈值的项只能是计数型命中，op 是哑字段）`)
      return { label: it.label, need: it.need, points: it.points }
    }
    if (!OPS.includes(it.op)) abort(`${itAt}.op 只能是 ${OPS.join(" ")}，实测 ${JSON.stringify(it.op)}`)
    if (typeof it.value !== "number" || !Number.isFinite(it.value)) abort(`${itAt}.value 必须是数值，实测 ${JSON.stringify(it.value)}（类型 ${typeof it.value}）——字符串在 JS 侧靠隐式转换能跑、在 Py 侧直接 TypeError，两端形状必须在这里就锁死`)
    return { label: it.label, need: it.need, op: it.op, value: it.value, points: it.points }
  })
  if (!Array.isArray(s.bands) || !s.bands.length) abort(`${at}.bands 不能为空（有分项却没有触发档＝算了不判）`)
  const maxPoints = items.reduce((a, b) => a + (Number(b.points) || 0), 0)
  const bands = s.bands.map((b, j) => {
    const bAt = `${at}/bands#${j}`
    if (!b || typeof b !== "object") abort(`${bAt} 不是对象`)
    const bMiss = BAND_FIELDS.filter((f) => !BAND_OPTIONAL.includes(f) && b[f] === undefined)
    if (bMiss.length) abort(`${bAt} 缺字段 ${bMiss.join(",")}`)
    const bExtra = Object.keys(b).filter((k) => !BAND_FIELDS.includes(k) && !k.startsWith("_"))
    if (bExtra.length) abort(`${bAt} 有未声明字段 ${bExtra.join(",")}`)
    for (const k of ["min", "max"]) if (typeof b[k] !== "number" || !Number.isFinite(b[k])) abort(`${bAt}.${k} 必须是数值`)
    if (b.min > b.max) abort(`${bAt} min>max（空档区间永不可触发）`)
    if (b.min < 1) abort(`${bAt}.min 不得小于 1（0 分即触发＝把「未评估」读成异常）`)
    if (b.min > maxPoints) abort(`${bAt}.min=${b.min} 超过本量表满分 ${maxPoints} ⇒ 永不可触发＝死档`)
    if (!LEVELS.includes(b.level)) abort(`${bAt}.level 只能是 ${LEVELS.join("/")}，实测 ${JSON.stringify(b.level)}`)
    if (typeof b.advice !== "string" || b.advice.trim().length < 10) abort(`${bAt}.advice 缺失或短于 10 字（医生看不到处置＝等于没提示）`)
    if (b.department !== undefined && (typeof b.department !== "string" || !REFERRAL_ROSTER.includes(b.department))) {
      abort(`${bAt}.department=${JSON.stringify(b.department)} 不在 referral_departments 名册内（名册取自红旗权威，两表共用一份去向词汇）`)
    }
    if (TRANSFER_RE.test(b.advice) && !b.department) abort(`${bAt} 的 advice 说了转诊/转运却没给去向（最贵的一步留给医生现想）`)
    return { min: b.min, max: b.max, level: b.level, advice: b.advice, ...(b.department ? { department: b.department } : {}) }
  })
  const overlapped = bands.flatMap((a, x) => bands.slice(x + 1).filter((b) => a.min <= b.max && b.min <= a.max).map((b) => `${a.min}-${a.max}⇄${b.min}-${b.max}`))
  if (overlapped.length) abort(`${at}.bands 区间重叠 ${overlapped.join(",")}（同一分数落进两档＝取哪档由遍历顺序决定，双端可能各取一档）`)
  return { id: s.id, title: s.title, source: s.source, hint: s.hint, items, bands }
})

const pyVal = (v) => (Array.isArray(v)
  ? "[" + v.map((x) => pyVal(x)).join(", ") + "]"
  : v && typeof v === "object"
    ? "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyVal(x)}`).join(", ") + "}"
    : JSON.stringify(v))

const cleanPR = Object.fromEntries(PR_KEYS.map((k) => [k, PR[k]]))
const head = (lang) => lang === "js"
  ? ["// 临床评分量表表（构建期产物，禁手改）——由 scripts/export_clinical_scores.mjs 从 data/clinical_scores.json 生成。",
    `// schema_version=${src.schema_version}；改表请改权威文件后跑 \`npm run scores:export\`。`,
    "// 三方全等（权威⇄JS⇄Py）由 frontend/tests/clinical_score_guard.mjs 逐字段复算对账；判读逻辑不住这里，住 functions/lib/rules.js ↔ backend/app/rules.py。"].join("\n")
  : ["# 临床评分量表表（构建期产物，禁手改）——由 scripts/export_clinical_scores.mjs 从 data/clinical_scores.json 生成。",
    `# schema_version=${src.schema_version}；与 functions/lib/clinical_scores.js 同源同值，由 clinical_score_guard.mjs 对账。`,
    "from typing import Any"].join("\n")

const js = head("js") + "\n\n"
  + `export const CLINICAL_SCORE_SCHEMA = ${JSON.stringify(src.schema_version)};\n`
  + `export const PLAUSIBLE_RANGES = ${JSON.stringify(cleanPR)};\n`
  + `export const CONSCIOUSNESS_TOKENS = ${JSON.stringify(src.consciousness_tokens)};\n`
  + `export const DERIVED_VALUES = ${JSON.stringify(derived)};\n`
  + "export const SCORE_TABLES = [\n" + scores.map((s) => "  " + JSON.stringify(s) + ",").join("\n") + "\n];\n"
const py = head("py") + "\n\n"
  + `CLINICAL_SCORE_SCHEMA: int = ${JSON.stringify(src.schema_version)}\n`
  + `PLAUSIBLE_RANGES: dict[str, list[Any]] = ${pyVal(cleanPR)}\n`
  + `CONSCIOUSNESS_TOKENS: list[str] = ${pyVal(src.consciousness_tokens)}\n`
  + `DERIVED_VALUES: list[dict[str, Any]] = ${pyVal(derived)}\n`
  + "SCORE_TABLES: list[dict[str, Any]] = [\n"
  + scores.map((s) => "    {" + SCORE_FIELDS.map((f) => `"${f}": ${pyVal(s[f])}`).join(", ") + "},").join("\n") + "\n]\n"

if (process.argv.includes("--check")) {
  const drift = []
  for (const [file, want] of [[JS_OUT, js], [PY_OUT, py]]) {
    if (!existsSync(file)) { drift.push(`${file}：不存在`); continue }
    if (readFileSync(file, "utf8") !== want) drift.push(`${file}：与权威不同（跑 npm run scores:export）`)
  }
  if (drift.length) { console.error(`FAIL 生成物漂移：\n  - ${drift.join("\n  - ")}`); process.exit(1) }
  console.log(`[GATE:scores-export-check-pass] 两份生成物与权威逐字节一致（scores=${scores.length} derived=${derived.length} tokens=${src.consciousness_tokens.length}）`)
  process.exit(0)
}
writeFileSync(JS_OUT, js)
writeFileSync(PY_OUT, py)
console.log(`generated: scores=${scores.length} items=${scores.reduce((a, s) => a + s.items.length, 0)} derived=${derived.length} tokens=${src.consciousness_tokens.length} → JS + Py`)
console.log(`[GATE:scores-export-pass] ${JS_OUT.replace(ROOT, "")} / ${PY_OUT.replace(ROOT, "")}`)
