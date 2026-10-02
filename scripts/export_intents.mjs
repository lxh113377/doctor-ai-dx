#!/usr/bin/env node
// data/intents.json → frontend/functions/lib/intents.js + backend/app/intents.py
// 与 export_knowledge.mjs / export_red_flags.mjs 同构：权威 → 生成物 → 守卫三方全等。
// 用法：node scripts/export_intents.mjs [--check|--selftest]
//   无参       写盘（两份生成物）
//   --check    只比对不写盘（intents_guard 每次跑它），漂移 exit 1
//   --selftest 内存里喂垃圾权威，证明校验面会响（不碰交付盘），失败 exit 1
// 退出码：0 一致/写盘成功；1 --check 漂移或 --selftest 有判据未过；2 权威读取失败或校验不通过（一个字节都不写盘）
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/intents.json"
const JS_OUT = ROOT + "frontend/functions/lib/intents.js"
const PY_OUT = ROOT + "backend/app/intents.py"

// 顶层键白名单：`_` 前缀是人读的说明键（沿用 knowledge.json 的约定），不参与数据校验。
const TOP_KEYS = ["schema_version", "_editing", "_provenance", "min_intents", "intents"]
const INTENT_FIELDS = [
  "id", "label", "keywords", "negative_terms", "reply_policy", "confidence_floor", "handoff_policy",
]
const ID_RE = /^[a-z][a-z0-9_]{2,31}$/
const POLICY_RE = /^(route_dx|service_refund|service_order_query|service_tech_support|abstain_and_handoff)$/
const HANDOFF_POLICY_RE = /^(always_handoff|escalate_if_missing_slot|escalate_if_repeated|abstain_or_low_confidence)$/

// 必须存在的五类（缺任一类 ⇒ 语义面残缺，比数据半空更严重）。红旗优先级不在此列：
// 它硬编码在 intent.js 的 detectIntent() 入口，不受本表影响。
const REQUIRED_IDS = ["general_medical", "refund", "order_query", "tech_support", "out_of_scope"]

// 半空止闸：只迁一半就发布比不迁更糟（生成物看着完整、数据其实缺）。下限=权威声明的条数，
// 与 `min_intents` 交叉校验，两者不一致即中止 —— 防止调低声明值来绕过止闸。
const MIN = { intents: 5 }
const MIN_KEYWORDS = 3

function validate(src) {
  const issues = []
  if (!src || typeof src !== "object") return ["权威不是对象"]

  for (const k of Object.keys(src)) {
    if (k.startsWith("_")) continue
    if (!TOP_KEYS.includes(k)) issues.push(`顶层未声明键 ${k}`)
  }
  for (const k of TOP_KEYS) {
    if (k.startsWith("_")) continue
    if (!(k in src)) issues.push(`顶层缺键 ${k}`)
  }

  const list = src.intents
  if (!Array.isArray(list)) return issues.concat(["intents 不是数组"])

  const declared = Number(src.min_intents)
  if (!Number.isInteger(declared) || declared < MIN.intents) {
    issues.push(`min_intents 必须是 >= ${MIN.intents} 的整数（当前 ${JSON.stringify(src.min_intents)}）—— 调低它等于放宽完整性`)
  }
  if (list.length < MIN.intents) {
    issues.push(`intents 只有 ${list.length} 条（< ${MIN.intents} 半空止闸）—— 疑似只迁了一半就发布`)
  }
  if (list.length < declared) {
    issues.push(`intents 实际 ${list.length} 条 < 声明的 min_intents ${declared} 条`)
  }

  const seen = new Set()
  for (const it of list) {
    if (!it || typeof it !== "object") { issues.push("条目不是对象"); continue }
    for (const f of Object.keys(it)) {
      if (!INTENT_FIELDS.includes(f)) issues.push(`条目 ${it.id || "(无 id)"} 多字段 ${f}`)
    }
    for (const f of INTENT_FIELDS) {
      if (!(f in it)) issues.push(`条目 ${it.id || "(无 id)"} 缺 ${f}`)
    }
    if (!ID_RE.test(it.id || "")) issues.push(`id 形态非法 ${JSON.stringify(it.id)}（须 ${ID_RE}）`)
    if (seen.has(it.id)) issues.push(`id 重复 ${it.id}`)
    seen.add(it.id)

    if (typeof it.label !== "string" || !it.label.trim()) issues.push(`${it.id} label 必须是非空字符串`)
    if (!Array.isArray(it.keywords) || it.keywords.length < MIN_KEYWORDS) {
      issues.push(`${it.id} keywords 少于 ${MIN_KEYWORDS}`)
    }
    if (!Array.isArray(it.negative_terms)) issues.push(`${it.id} negative_terms 必须是数组（可为空数组）`)
    if (!POLICY_RE.test(it.reply_policy || "")) issues.push(`${it.id} reply_policy 非法 ${JSON.stringify(it.reply_policy)}`)
    if (!HANDOFF_POLICY_RE.test(it.handoff_policy || "")) {
      issues.push(`${it.id} handoff_policy 非法 ${JSON.stringify(it.handoff_policy)}`)
    }
    const cf = it.confidence_floor
    if (typeof cf !== "number" || !(cf > 0 && cf <= 1)) issues.push(`${it.id} confidence_floor 必须落在 (0,1]`)

    const kws = Array.isArray(it.keywords) ? it.keywords : []
    if (kws.some((k) => typeof k !== "string" || !k.trim())) issues.push(`${it.id} keywords 含空串或非字符串`)
    if (new Set(kws).size !== kws.length) issues.push(`${it.id} keywords 有重复词`)
    // 否定词出现在正向词表里 ⇒ 该词会自我否决，语义自相矛盾
    const negs = Array.isArray(it.negative_terms) ? it.negative_terms : []
    for (const n of negs) {
      if (kws.includes(n)) issues.push(`${it.id} 的否定词 ${JSON.stringify(n)} 同时出现在 keywords 里（自我否决）`)
    }
  }

  for (const need of REQUIRED_IDS) {
    if (!seen.has(need)) issues.push(`缺必需意图 ${need}（五类语义面残缺，比半空更严重）`)
  }
  return issues
}
const HEADER_JS = (version) => [
  "// 意图注册表（构建期产物，禁手改）——由 scripts/export_intents.mjs 从 data/intents.json 生成。",
  `// schema_version=${version}；改表请改权威文件后跑 npm run intents:export。`,
  "// 三方全等由 frontend/tests/intents_guard.mjs 对账。",
  "",
].join("\n")

const HEADER_PY = (version) => [
  "# 意图注册表（构建期产物，禁手改）——由 scripts/export_intents.mjs 从 data/intents.json 生成。",
  `# schema_version=${version}；与 functions/lib/intents.js 同源同值，由 intents_guard.mjs 对账。`,
  "",
].join("")

// 生成物保持**声明式原样**（不做关键词改写/归一），让「权威 == 生成物」是逐字节可比的事实，
// 而不是经过一层转换后的巧合 —— 转换层是漂移的常见来源。
function build(src) {
  const version = src.schema_version
  const rows = src.intents.map((it) => ({
    id: it.id,
    label: it.label,
    keywords: [...it.keywords],
    negative_terms: [...it.negative_terms],
    reply_policy: it.reply_policy,
    confidence_floor: it.confidence_floor,
    handoff_policy: it.handoff_policy,
  }))

  const js = [
    HEADER_JS(version),
    `export const INTENTS_SCHEMA_VERSION = ${JSON.stringify(version)}`,
    `export const MIN_INTENTS = ${JSON.stringify(src.min_intents)}`,
    "",
    "export const INTENTS = Object.freeze([",
    ...rows.map((r) => "  Object.freeze({ " + [
      `id: ${JSON.stringify(r.id)}`,
      `label: ${JSON.stringify(r.label)}`,
      `keywords: Object.freeze(${JSON.stringify(r.keywords)})`,
      `negative_terms: Object.freeze(${JSON.stringify(r.negative_terms)})`,
      `reply_policy: ${JSON.stringify(r.reply_policy)}`,
      `confidence_floor: ${JSON.stringify(r.confidence_floor)}`,
      `handoff_policy: ${JSON.stringify(r.handoff_policy)}`,
    ].join(", ") + " }),"),
    "])",
    "",
    "export const INTENT_IDS = Object.freeze(INTENTS.map((i) => i.id))",
    "export const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]))",
    "export const REQUIRED_INTENT_IDS = Object.freeze([",
    ...REQUIRED_IDS.map((r) => `  ${JSON.stringify(r)},`),
    "])",
    "",
  ].join("\n")

  const py = [
    HEADER_PY(version),
    `INTENTS_SCHEMA_VERSION = ${JSON.stringify(version)}`,
    `MIN_INTENTS = ${JSON.stringify(src.min_intents)}`,
    "",
    "INTENTS = [",
    ...rows.map((r) => "    { " + [
      `"id": ${JSON.stringify(r.id)}`,
      `"label": ${JSON.stringify(r.label)}`,
      `"keywords": ${JSON.stringify(r.keywords)}`,
      `"negative_terms": ${JSON.stringify(r.negative_terms)}`,
      `"reply_policy": ${JSON.stringify(r.reply_policy)}`,
      `"confidence_floor": ${r.confidence_floor}`,
      `"handoff_policy": ${JSON.stringify(r.handoff_policy)}`,
    ].join(", ") + " },"),
    "]",
    "",
    "INTENT_IDS = [i[\"id\"] for i in INTENTS]",
    "INTENT_BY_ID = {i[\"id\"]: i for i in INTENTS}",
    "REQUIRED_INTENT_IDS = " + JSON.stringify(REQUIRED_IDS),
    "",
  ].join("\n")

  return { js, py }
}
function selftest() {
  let bad = 0
  const row = (name, ok, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` :: ${detail}`}`)
    if (!ok) bad++
  }
  const real = JSON.parse(readFileSync(AUTHORITY, "utf8"))
  const clone = (x) => JSON.parse(JSON.stringify(x))
  const hits = (mutate) => {
    const s = clone(real)
    mutate(s)
    return validate(s)
  }
  row("正向对照：当前权威 validate() 零问题", validate(real).length === 0, validate(real).slice(0, 3).join(" ;; "))
  const shapes = [
    ["未知顶层键", (s) => { s.extra = [] }, /顶层未声明键/],
    ["缺顶层键", (s) => { delete s.min_intents }, /顶层缺键/],
    ["intents 半空（截到 2 条）", (s) => { s.intents = s.intents.slice(0, 2) }, /半空止闸/],
    ["调低 min_intents 绕过止闸", (s) => { s.min_intents = 1 }, /min_intents 必须/],
    ["条目缺字段", (s) => { delete s.intents[0].handoff_policy }, /缺 handoff_policy/],
    ["条目多字段", (s) => { s.intents[0].bonus = 1 }, /多字段 bonus/],
    ["id 形态非法", (s) => { s.intents[0].id = "Refund" }, /id 形态非法/],
    ["id 重复", (s) => { s.intents[1].id = s.intents[0].id }, /id 重复/],
    ["keywords 少于 3", (s) => { s.intents[0].keywords = ["a", "b"] }, /keywords 少于 3/],
    ["keywords 重复", (s) => { s.intents[0].keywords = ["a", "a", "b"] }, /有重复词/],
    ["否定词自我否决", (s) => { s.intents[1].negative_terms = [s.intents[1].keywords[0]] }, /自我否决/],
    ["confidence_floor 越界", (s) => { s.intents[0].confidence_floor = 1.5 }, /confidence_floor 必须/],
    ["reply_policy 非法", (s) => { s.intents[0].reply_policy = "随便" }, /reply_policy 非法/],
    ["handoff_policy 非法", (s) => { s.intents[0].handoff_policy = "也许" }, /handoff_policy 非法/],
    ["缺必需意图 refund", (s) => { s.intents = s.intents.filter((i) => i.id !== "refund") }, /缺必需意图 refund/],
  ]
  for (const [name, mutate, re] of shapes) {
    const issues = hits(mutate)
    row(`中止面 ${name}`, issues.some((x) => re.test(x)), issues.slice(0, 2).join(" ;; ") || "未报任何问题")
  }
  const a = build(real)
  const b = build(clone(real))
  row("生成可复现：同一输入两次 build() 字节相同", a.js === b.js && a.py === b.py)
  row("生成物与盘上两端逐字节相同（即 --check 的正向对照）",
    a.js === readFileSync(JS_OUT, "utf8") && a.py === readFileSync(PY_OUT, "utf8"))
  const stripped = clone(real)
  stripped.intents = stripped.intents.slice(1)
  row("对账面非恒真：少一条就与盘上不同", build(stripped).js !== a.js && build(stripped).py !== a.py)
  console.log(bad === 0
    ? `[GATE:intents-export-selftest-pass] 中止面 ${shapes.length} 条 + 正向/反向对照全过`
    : `[GATE:intents-export-selftest-fail] ${bad} 项未过`)
  return bad ? 1 : 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--selftest")) return selftest()
  let src
  try {
    src = JSON.parse(readFileSync(AUTHORITY, "utf8"))
  } catch (e) {
    console.error(`FAIL 生成中止：data/intents.json 读取/解析失败（${String(e.message).slice(0, 140)}）`)
    return 2
  }
  const issues = validate(src)
  if (issues.length) {
    console.error(`FAIL 生成中止（未写任何文件）：${issues.length} 项不合法\n  - ${issues.slice(0, 10).join("\n  - ")}`)
    return 2
  }
  const { js, py } = build(src)
  if (argv.includes("--check")) {
    const drift = []
    for (const [file, want, label] of [[JS_OUT, js, "intents.js"], [PY_OUT, py, "intents.py"]]) {
      let have = ""
      try { have = readFileSync(file, "utf8") } catch { have = "" }
      if (have !== want) drift.push(`${label} 与权威不一致（生成 ${want.split("\n").length} 行 / 盘上 ${have.split("\n").length} 行）`)
    }
    if (drift.length) {
      console.error(`[GATE:intents-export-check-fail] ${drift.join(" ;; ")} —— 跑 npm --prefix frontend run intents:export 重建`)
      return 1
    }
    console.log(`[GATE:intents-export-check-pass] 两份生成物与 data/intents.json 逐字节一致（intents=${src.intents.length}）`)
    return 0
  }
  writeFileSync(JS_OUT, js, "utf8")
  writeFileSync(PY_OUT, py, "utf8")
  console.log(`generated: ${src.intents.length} 类意图 → JS + Py`)
  return 0
}

process.exit(main())