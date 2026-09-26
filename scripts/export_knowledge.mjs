#!/usr/bin/env node
// data/knowledge.json → frontend/functions/lib/knowledge.js + backend/app/knowledge.py
// 第三十二轮 #92（收 #55 第三块）：知识库是**临床数据**不是代码，权威必须是可被非工程角色逐条审阅、
// 可被机器校验的 JSON。方向由「js→py 单向导出」改为「JSON→双端生成」，与 scope_rules / red_flag_rules 一致。
// 生成中止（一个字节都不写）的形态：顶层键未知/缺、条目字段缺/多、半空（防只迁一半就发布）、
// 映射指向不存在的 id、词表重复或单字。校验与生成分离成纯函数，故 --selftest 能在不碰交付盘的前提下
// 证明这些中止真的会响。
// 用法：node scripts/export_knowledge.mjs [--check|--selftest]。--check 只比对不写盘（kb_guard 每次跑它）。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/knowledge.json"
const JS_OUT = ROOT + "frontend/functions/lib/knowledge.js"
const PY_OUT = ROOT + "backend/app/knowledge.py"

const TOP_KEYS = ["schema_version", "_editing", "_provenance", "entries", "synonyms", "symptom_to_kb", "red_flag_terms"]
const ENTRY_FIELDS = ["id", "title", "source", "year", "url", "scope", "section", "condition", "icd", "keywords", "text"]
// 半空止闸：只迁一半就发布比不迁更糟（生成物看着完整、数据其实缺）。下限取「现存量的约八成」，
// 不是可调参数——调它等于放宽数据完整性，须与 #70 一样在台账里写理由。
const MIN = { entries: 50, synonyms: 25, symptom_keys: 55, red_flag_terms: 20 }

// ---- 校验：纯函数，返回问题清单（不抛异常，好让 --selftest 喂垃圾进来验中止面）----
function validate(src) {
  const issues = []
  if (!src || typeof src !== "object" || Array.isArray(src)) return ["权威不是对象"]
  for (const k of Object.keys(src)) if (!TOP_KEYS.includes(k)) issues.push(`顶层未声明键 ${k}`)
  for (const k of TOP_KEYS) if (src[k] === undefined) issues.push(`顶层缺键 ${k}`)
  if (issues.length) return issues

  const entries = src.entries
  if (!Array.isArray(entries)) return issues.concat("entries 必须是数组")
  if (entries.length < MIN.entries) issues.push(`entries 只有 ${entries.length} 条（< ${MIN.entries} 半空止闸）——疑似只迁了一半就发布`)
  const seen = new Set()
  entries.forEach((e, i) => {
    if (!e || typeof e !== "object") {
      issues.push(`#${i}: 不是对象`)
      return
    }
    const keys = Object.keys(e)
    const missing = ENTRY_FIELDS.filter((f) => !keys.includes(f))
    const extra = keys.filter((f) => !ENTRY_FIELDS.includes(f))
    if (missing.length || extra.length) issues.push(`${e.id ?? `#${i}`}: 缺 ${missing.join("/") || "-"} 多 ${extra.join("/") || "-"}`)
    if (!/^kb-\d{3}$/.test(String(e.id))) issues.push(`${e.id}: id 形态非法`)
    if (seen.has(e.id)) issues.push(`${e.id}: id 重复`)
    seen.add(e.id)
    if (!Array.isArray(e.keywords) || e.keywords.length < 3) issues.push(`${e.id}: keywords 少于 3`)
    if (e.icd !== null && typeof e.icd !== "string") issues.push(`${e.id}: icd 必须是字符串或 null（不得省略）`)
    if (!/^\d{4}$/.test(String(e.year))) issues.push(`${e.id}: year 非 4 位数字`)
  })

  for (const key of ["synonyms", "symptom_to_kb"]) {
    if (!src[key] || typeof src[key] !== "object" || Array.isArray(src[key])) issues.push(`${key} 必须是对象`)
  }
  const minOf = { synonyms: MIN.synonyms, symptom_to_kb: MIN.symptom_keys }
  for (const key of ["synonyms", "symptom_to_kb"]) {
    const n = Object.keys(src[key] || {}).length
    if (n < minOf[key]) issues.push(`${key} 只有 ${n} 项（< ${minOf[key]} 半空止闸）`)
  }
  for (const [sym, targets] of Object.entries(src.symptom_to_kb || {})) {
    if (!Array.isArray(targets) || !targets.length) issues.push(`symptom_to_kb["${sym}"] 为空映射`)
    else for (const id of targets) if (!seen.has(id)) issues.push(`symptom_to_kb["${sym}"] 指向不存在的条目 ${id}`)
  }
  for (const [canon, syns] of Object.entries(src.synonyms || {})) {
    if (!Array.isArray(syns) || !syns.length) issues.push(`synonyms["${canon}"] 为空组`)
    else if (syns.some((s) => typeof s !== "string" || !s.trim())) issues.push(`synonyms["${canon}"] 含空/非字符串`)
  }
  const terms = src.red_flag_terms
  if (!Array.isArray(terms)) issues.push("red_flag_terms 必须是数组")
  else {
    if (terms.length < MIN.red_flag_terms) issues.push(`red_flag_terms 只有 ${terms.length} 词（< ${MIN.red_flag_terms} 半空止闸）`)
    if (new Set(terms).size !== terms.length) issues.push("red_flag_terms 有重复词")
    if (terms.some((t) => typeof t !== "string" || t.trim().length < 2)) issues.push("red_flag_terms 含空串或单字词")
  }
  return issues
}

// ---- 生成：纯函数，同一输入必得同一字节（可复现性由 --selftest 断言）----
const jsDict = (obj) => "{\n" + Object.entries(obj).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}"
const pyVal = (value) => JSON.stringify(value, (k, v) => (v === null ? "__PY_NULL__" : v)).replaceAll('"__PY_NULL__"', "None")

function build(src) {
  const ordered = src.entries.map((e) => Object.fromEntries(ENTRY_FIELDS.map((f) => [f, e[f]])))
  const js = `// ============================================================
// 医学知识库（RAG 语料，带完整元数据）+ 同义词表 + 检索加权词 + 症状映射
// ⚠️ 构建期产物，禁手改 —— 由 scripts/export_knowledge.mjs 从 data/knowledge.json 生成（schema_version=${src.schema_version}）。
//    改数据请改 data/knowledge.json 后跑 \`npm --prefix frontend run kb:export\`；
//    frontend/tests/kb_guard.mjs 核「权威 == 双端生成物」三方全等，漂移即判红。
// 单一权威源：所有 evidence_id 必须来自本表，检索/校验均以此为准。
// 合规：仅引用公开指南/共识的标题与要点摘要，不含未授权全文。
// 每条：id/title/source/year/url/scope/section/condition/icd/keywords/text
// icd：WHO ICD-10（默认版）初筛映射，组合条目用分号并列；综合征/分诊类条目为 null，待临床复核后方可作为编码依据
// condition：该条支持的主要诊断（用于确定性降级时映射）
// keywords：用于 BM25 + 同义词召回的症状/体征线索
// ============================================================

export const KNOWLEDGE_BASE = [
${ordered.map((e) => "  " + JSON.stringify(e)).join(",\n")}
]

export const SYNONYMS = ${jsDict(src.synonyms)}

export const RED_FLAG_KEYWORDS = [
${src.red_flag_terms.map((t) => "    " + JSON.stringify(t)).join(",\n")}
]

export const SYMPTOM_TO_KB = ${jsDict(src.symptom_to_kb)}

// ---- O(1) 索引（供 rag/engine 复用，避免每次 find/filter 全表扫描）----
export const KB_BY_ID = new Map(KNOWLEDGE_BASE.map((k) => [k.id, k]))
export const KB_ID_SET = new Set(KNOWLEDGE_BASE.map((k) => k.id))
export const kbTitleOf = (id) => KB_BY_ID.get(id)?.title || id
export const kbConditionOf = (id) => KB_BY_ID.get(id)?.condition || ""
`
  const py = `# ============================================================
# 医学知识库（RAG 语料，带完整元数据）+ 同义词表 + 检索加权词 + 症状映射
# ⚠️ 构建期产物，禁手改 —— 由 scripts/export_knowledge.mjs 从 data/knowledge.json 生成
#    （schema_version=${src.schema_version}），与 functions/lib/knowledge.js 同源同值，
#    由 frontend/tests/kb_guard.mjs 核三方全等。改数据请改 JSON 后跑 \`npm --prefix frontend run kb:export\`。
# ============================================================
from typing import Any

# 类型注解由生成器统一注入：值域异构（str/list 混合），不标注 ⇒ mypy 推断为 dict[str, object]
# ⇒ 下游数十条「object 不可下标」假性告警（第十五轮实测 26 条里 19 条属此类）。
KNOWLEDGE_BASE: list[dict[str, Any]] = [
${ordered.map((e) => "    " + pyVal(e) + ",").join("\n")}
]

SYNONYMS: dict[str, list[str]] = {
${Object.entries(src.synonyms).map(([k, v]) => `    ${pyVal(k)}: ${pyVal(v)},`).join("\n")}
}

RED_FLAG_KEYWORDS: list[str] = [
${src.red_flag_terms.map((t) => "    " + pyVal(t) + ",").join("\n")}
]

SYMPTOM_TO_KB: dict[str, list[str]] = {
${Object.entries(src.symptom_to_kb).map(([k, v]) => `    ${pyVal(k)}: ${pyVal(v)},`).join("\n")}
}
`
  return { js, py }
}

const clone = (o) => JSON.parse(JSON.stringify(o))

// ---- 离线自证：中止面逐条真响 + 正向对照（合法权威零问题、生成字节可复现）----
function selftest() {
  let bad = 0
  const row = (name, ok, detail = "") => {
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` :: ${detail}`}`)
    if (!ok) bad++
  }
  const real = JSON.parse(readFileSync(AUTHORITY, "utf8"))
  const hits = (mutate) => {
    const s = clone(real)
    mutate(s)
    return validate(s)
  }
  row("正向对照：当前权威 validate() 零问题", validate(real).length === 0, validate(real).slice(0, 3).join(" ;; "))
  const shapes = [
    ["未知顶层键", (s) => { s.extra_table = [] }, /顶层未声明键/],
    ["缺顶层键", (s) => { delete s.red_flag_terms }, /顶层缺键/],
    ["entries 半空（截到 10 条）", (s) => { s.entries = s.entries.slice(0, 10) }, /半空止闸/],
    ["symptom_to_kb 半空", (s) => { s.symptom_to_kb = Object.fromEntries(Object.entries(s.symptom_to_kb).slice(0, 5)) }, /symptom_to_kb 只有/],
    ["条目缺字段", (s) => { delete s.entries[0].text }, /缺 text/],
    ["条目多字段", (s) => { s.entries[0].bonus = 1 }, /多 bonus/],
    ["id 重复", (s) => { s.entries[1].id = s.entries[0].id }, /id 重复/],
    ["id 形态非法", (s) => { s.entries[0].id = "kb-1" }, /id 形态非法/],
    ["icd 省略（等价于 undefined）", (s) => { delete s.entries[0].icd }, /缺 icd/],
    ["icd 写成数字", (s) => { s.entries[0].icd = 123 }, /icd 必须是字符串/],
    ["keywords 少于 3", (s) => { s.entries[0].keywords = ["a"] }, /keywords 少于 3/],
    ["year 非 4 位", (s) => { s.entries[0].year = "20" }, /year 非 4 位/],
    ["映射指向不存在的 id", (s) => { s.symptom_to_kb["假症状"] = ["kb-999"] }, /指向不存在的条目 kb-999/],
    ["映射空数组", (s) => { s.symptom_to_kb["假症状"] = [] }, /为空映射/],
    ["同义词空组", (s) => { s.synonyms["空组"] = [] }, /为空组/],
    ["加权词重复", (s) => { s.red_flag_terms.push(s.red_flag_terms[0]) }, /有重复词/],
    ["加权词单字", (s) => { s.red_flag_terms.push("咳") }, /含空串或单字词/],
  ]
  for (const [name, mutate, re] of shapes) {
    const issues = hits(mutate)
    row(`中止面 ${name}`, issues.some((x) => re.test(x)) , issues.slice(0, 2).join(" ;; ") || "未报任何问题")
  }
  const a = build(real)
  const b = build(clone(real))
  row("生成可复现：同一输入两次 build() 字节相同", a.js === b.js && a.py === b.py)
  row("生成物与盘上两端逐字节相同（即 --check 的正向对照）",
    a.js === readFileSync(JS_OUT, "utf8") && a.py === readFileSync(PY_OUT, "utf8"))
  // 反向对照：删掉一条数据后生成物必须与盘上不同（否则上面的对账是常量比较）
  const stripped = clone(real)
  stripped.entries = stripped.entries.slice(1)
  row("对账面非恒真：少一条就与盘上不同", build(stripped).js !== a.js && build(stripped).py !== a.py)
  console.log(bad === 0 ? `[GATE:kb-export-selftest-pass] 中止面 ${shapes.length} 条 + 正向/反向对照全过` : `[GATE:kb-export-selftest-fail] ${bad} 项未过`)
  return bad ? 1 : 0
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--selftest")) return selftest()
  let src
  try {
    src = JSON.parse(readFileSync(AUTHORITY, "utf8"))
  } catch (e) {
    console.error(`FAIL 生成中止：data/knowledge.json 读取/解析失败（${String(e.message).slice(0, 140)}）`)
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
    for (const [file, want, label] of [[JS_OUT, js, "knowledge.js"], [PY_OUT, py, "knowledge.py"]]) {
      let have = ""
      try {
        have = readFileSync(file, "utf8")
      } catch {
        have = ""
      }
      if (have !== want) drift.push(`${label} 与权威不一致（生成 ${want.split("\n").length} 行 / 盘上 ${have.split("\n").length} 行）`)
    }
    if (drift.length) {
      console.error(`[GATE:kb-export-check-fail] ${drift.join(" ;; ")} —— 跑 npm --prefix frontend run kb:export 重建`)
      return 1
    }
    console.log(`[GATE:kb-export-check-pass] 两份生成物与 data/knowledge.json 逐字节一致（entries=${src.entries.length} symptom_keys=${Object.keys(src.symptom_to_kb).length}）`)
    return 0
  }
  writeFileSync(JS_OUT, js, "utf8")
  writeFileSync(PY_OUT, py, "utf8")
  console.log(`generated: ${src.entries.length} 条知识 / ${Object.keys(src.synonyms).length} 组同义词 / ${Object.keys(src.symptom_to_kb).length} 个症状映射 / ${src.red_flag_terms.length} 个检索加权词 → JS + Py`)
  return 0
}

process.exit(main())
