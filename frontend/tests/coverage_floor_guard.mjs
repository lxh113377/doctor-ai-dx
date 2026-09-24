// 覆盖率地板棘轮门禁：读 c8 的 coverage-summary.json，按**模块级**地板核对（只准收紧，不准放宽）。
// 三条硬要求（都对应真实失效形态）：
//  ① 输入非空证明（R247）：summary 缺失/为空/模块缺席一律判红，禁止把"没数据"当成"通过"。
//  ② 模块级地板：全局总量会掩盖红线模块单独退化（rules.js 掉到 60% 而总量仍达标）。
//  ③ 声明清单与实际产物对账：模块被改名/删除也必须被拦，否则地板静默失效。
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const FLOOR = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/coverage_floor.json", import.meta.url)), "utf-8"))
const SUMMARY_PATH = fileURLToPath(new URL("../coverage/coverage-summary.json", import.meta.url))

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

function normalize(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^.*\/functions\//, "")
}

check("覆盖率数据存在且非空（先证输入非空，再谈达标）", existsSync(SUMMARY_PATH),
  `缺失即先跑 npm run coverage:js —— 路径 ${SUMMARY_PATH}`)
if (!existsSync(SUMMARY_PATH)) {
  console.log("\nRESULT: 1 pass / 1 fail")
  process.exit(1)
}

const raw = readFileSync(SUMMARY_PATH, "utf-8")
const summary = JSON.parse(raw)
const files = new Map(Object.keys(summary).filter((k) => k !== "total").map((k) => [normalize(k), summary[k]]))
check("summary 至少覆盖 6 个 lib 模块", files.size >= 6, `实际 ${files.size}`)

// ③ 声明清单对账：地板里写了但产物里没有的模块 = 改名/删除/未被统计，必须报错
const missing = Object.keys(FLOOR.js_modules).filter((m) => !files.has(m))
check("地板声明的模块在覆盖率产物中全部存在（防改名后地板静默失效）",
  missing.length === 0, missing.join(" "))

// ② 模块级地板
for (const [mod, floors] of Object.entries(FLOOR.js_modules)) {
  const m = files.get(mod)
  if (!m) continue
  for (const key of ["statements", "branches", "functions"]) {
    const floor = floors[key]
    const got = m[key]?.pct
    check(`${mod} ${key} ≥ 地板 ${floor}%`, Number.isFinite(got) && got >= floor, `实测 ${got}%`)
  }
}

// 全局地板
for (const key of ["statements", "branches", "functions"]) {
  const floor = FLOOR.js_total[key]
  const got = summary.total?.[key]?.pct
  check(`TOTAL ${key} ≥ 地板 ${floor}%`, Number.isFinite(got) && got >= floor, `实测 ${got}%`)
}

// 红线模块必须显式在册（防止有人从地板清单里删掉某模块来"达标"）
check("红线模块 rules.js / engine.js / fhir.js 均在地板清单内",
  ["lib/rules.js", "lib/engine.js", "lib/fhir.js"].every((m) => m in FLOOR.js_modules))

// 余量报告（收紧依据；不做断言，避免噪声）
const headroom = Object.entries(FLOOR.js_modules)
  .filter(([mod]) => files.has(mod))
  .map(([mod, f]) => `${mod} 分支余量 ${(files.get(mod).branches.pct - f.branches).toFixed(1)}pt`)
console.log(`\nCOVERAGE FLOOR SUMMARY: ${headroom.join(" | ")}`)
console.log(`  全局分支 ${summary.total.branches.pct}%（地板 ${FLOOR.js_total.branches}%）`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
