#!/usr/bin/env node
// data/scope_rules.json → frontend/functions/lib/scope_rules.js + backend/app/scope_rules.py
// 为什么要有这个生成器：适用范围规则是**临床取舍**而不是代码逻辑，它应当可被非工程角色审阅、
// 可被逐条追问「凭什么不做」——所以权威是 JSON，代码只消费。三张表（scope/red_flag/knowledge）
// 自 v1.29.0 起方向统一：JSON → 双端生成物，单向、禁手改，由各自守卫做「权威 == 双端」三方对账。
// 用法：node scripts/export_scope.mjs [--check]。--check 只比对不写盘（scope_guard 每次跑它，抓「改 JSON 忘了导出」）。
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const AUTHORITY = ROOT + "data/scope_rules.json"
const JS_OUT = ROOT + "frontend/functions/lib/scope_rules.js"
const PY_OUT = ROOT + "backend/app/scope_rules.py"
const src = JSON.parse(readFileSync(AUTHORITY, "utf8"))

const FIELDS = ["id", "title", "keywords", "rationale", "action", "doctor_note"]
const rules = src.rules.map((r) => {
  const missing = FIELDS.filter((f) => r[f] === undefined)
  if (missing.length) throw new Error(`FAIL: 规则 ${r.id} 缺字段 ${missing.join(",")}（生成中止，不产出半成品）`)
  const extra = Object.keys(r).filter((k) => !FIELDS.includes(k))
  if (extra.length) throw new Error(`FAIL: 规则 ${r.id} 有未声明字段 ${extra.join(",")}（生成中止）`)
  return Object.fromEntries(FIELDS.map((f) => [f, r[f]]))
})
const ids = rules.map((r) => r.id)
if (new Set(ids).size !== ids.length) throw new Error(`FAIL: 规则 id 重复 ${ids.join(",")}`)

const pyVal = (v) => (Array.isArray(v)
  ? "[" + v.map((x) => pyVal(x)).join(", ") + "]"
  : v && typeof v === "object"
    ? "{" + Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyVal(x)}`).join(", ") + "}"
    : JSON.stringify(v))

const META = { negation_window_chars: src.negation_window_chars, negation_tokens_extra: src.negation_tokens_extra || [] }
if (typeof META.negation_window_chars !== "number" || META.negation_window_chars < 1) {
  throw new Error("FAIL: negation_window_chars 必须是正整数")
}
if (!Array.isArray(META.negation_tokens_extra)) throw new Error("FAIL: negation_tokens_extra 必须是数组")

const js = ["// 适用范围规则（构建期产物，禁手改）——由 scripts/export_scope.mjs 从 data/scope_rules.json 生成。",
  `// schema_version=${src.schema_version}；权威文件内含逐条 rationale 与第 29 轮实测依据。`,
  "// 改数据请改 data/scope_rules.json 后跑 `npm run scope:export`；tests/scope_guard.mjs 核三方全等。",
  "export const SCOPE_SCHEMA = " + JSON.stringify(src.schema_version) + ";",
  "export const SCOPE_META = " + JSON.stringify(META) + ";",
  "export const SCOPE_RULES = ["].join("\n")
  + "\n" + rules.map((r) => "  " + JSON.stringify(r) + ",").join("\n") + "\n];\n"
  + "export const SCOPE_RULE_IDS = SCOPE_RULES.map((r) => r.id);\n"

const py = ['# 适用范围规则（构建期产物，禁手改）——由 scripts/export_scope.mjs 从 data/scope_rules.json 生成。',
  `# schema_version=${src.schema_version}；与 functions/lib/scope_rules.js 同源同值，由 frontend/tests/scope_guard.mjs 对账。`,
  "from typing import Any", "", `SCOPE_SCHEMA: str = ${JSON.stringify(src.schema_version)}`,
  `SCOPE_META: dict[str, Any] = ${pyVal(META)}`, "",
  "SCOPE_RULES: list[dict[str, Any]] = ["]
  .concat(rules.map((r) => "    {" + FIELDS.map((f) => `"${f}": ${pyVal(r[f])}`).join(", ") + "},"))
  .concat(["]", "", "SCOPE_RULE_IDS: list[str] = [r[\"id\"] for r in SCOPE_RULES]", ""]).join("\n")

// --check：只比不写。存在的意义是抓「改了 JSON 忘了导出」——三方全等判据读的是数据等值，
// 格式漂移（同一份数据换种写法）它抓不到，逐字节这一层才抓得到。
if (process.argv.includes("--check")) {
  const drift = []
  for (const [file, want, label] of [[JS_OUT, js, "scope_rules.js"], [PY_OUT, py, "scope_rules.py"]]) {
    let have = ""
    try {
      have = readFileSync(file, "utf8")
    } catch {
      have = ""
    }
    if (have !== want) {
      drift.push(`${label} 与权威逐字节不一致（生成 ${want.split("\n").length} 行 / 盘上 ${have.split("\n").length} 行）`)
    }
  }
  if (drift.length) {
    console.error(`[GATE:scope-export-check-fail] ${drift.join(" ;; ")} —— 跑 npm --prefix frontend run scope:export 重建`)
    process.exit(1)
  }
  console.log(`[GATE:scope-export-check-pass] 两份生成物与 data/scope_rules.json 逐字节一致（rules=${rules.length}）`)
  process.exit(0)
}

writeFileSync(JS_OUT, js)
writeFileSync(PY_OUT, py)
console.log(`generated: ${rules.length} 条规则 (${ids.join(", ")}) → JS + Py`)
