// 红旗规则表守卫（第三十轮新增，台账 #83/#85；npm test 第 23 件套）。
// 为什么单独成件：红旗层是三条红线里唯一"数据即代码"的表，而它此前**零载入校验**——
//   实测 `backend/app/rules.py` 里 validate 函数只有 1 个（scope 那个），DANGER_RULES 一次都没被校验过。
//   表坏的代价不对称：漏一条危险信号 ≫ 多一条提示，而且两条同名会被去重分支**静默合并**（少报）。
// 形状抄 peer：kheireddinedev00/Medico `triage/rules.py`（本人 gh api 实测 size=13599B sha=19fc7fcc）——
//   不变量写在注释里、载入即 raise、错误点名违规项、无降级模式。不抄它的阈值与规则内容。
// 分工：镜像端的逻辑由 `backend/tests/test_red_flag_rules.py` **原生**测（上一轮教训：subprocess 调 Python
//   不计入 coverage.py）；本件只做**跨端事实对账**（表本体 + 同一份变异夹具的逐条结论）。
import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { RULE_TABLES, RED_FLAG_SEVERITIES, validateRedFlagTables } from "../functions/lib/rules.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const fixture = (p) => JSON.parse(readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8"))
const mutSpec = fixture("red_flag_mutations.json")
const redLine = fixture("red_line_phrases.json")

// Python 侧只给事实（表本体 + 校验结论 + 变异结果），断言全部留在本件里。
const dumpPath = fileURLToPath(new URL("../../backend/tests/red_flag_dump.py", import.meta.url))
const pyOut = execFileSync(process.env.PYTHON_BIN || "python", [dumpPath],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
let py
try { py = JSON.parse(pyOut.trim().split("\n").pop()) } catch { console.error("Py dump 不是合法 JSON：\n" + pyOut.slice(0, 400)); process.exit(1) }

const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v)
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

console.log("== 1. 输入非空证明（读空＝判据失效，不许静默通过）==")
check(`JS 表规模非空（DANGER=${RULE_TABLES.DANGER.length} COMBO=${RULE_TABLES.COMBO.length}）`,
  RULE_TABLES.DANGER.length >= 13 && RULE_TABLES.COMBO.length >= 4, "低于既有下限＝表被读空或整体改写")
check(`Py 表规模非空（DANGER=${py.danger.length} COMBO=${py.combo.length}）`,
  py.danger.length >= 13 && py.combo.length >= 4)
check(`变异夹具非空（cases=${mutSpec.cases.length}，须 ≥8）`, (mutSpec.cases || []).length >= 8,
  "夹具清空会让下面所有拒绝断言空转")

console.log("== 2. 双端整表逐字段全等（含顺序；把既往「探针同表」升级为「规则本体同表」）==")
check("DANGER 整表全等", sameJSON(RULE_TABLES.DANGER, py.danger),
  `JS[0]=${JSON.stringify(RULE_TABLES.DANGER[0]?.name)} Py[0]=${JSON.stringify(py.danger[0]?.name)}`)
check("COMBO 整表全等", sameJSON(RULE_TABLES.COMBO, py.combo),
  `JS 条数=${RULE_TABLES.COMBO.length} Py 条数=${py.combo.length}`)
check("否定词表与阳性例外词双端全等",
  sameJSON(RULE_TABLES.NEGATIONS, ["没有", "未见", "未出现", "无明显", "无伴", "不伴", "否认", "阴性", "无", "未"])
  && RULE_TABLES.NEGATIONS.length === 10, `实测 ${JSON.stringify(RULE_TABLES.NEGATIONS)}`)
check(`severity 值域双端同值（${RED_FLAG_SEVERITIES.join("/")}）`, sameJSON(RED_FLAG_SEVERITIES, py.severities),
  `Py=${JSON.stringify(py.severities)}`)

console.log("== 3. 载入即校验：未变异必须零拒绝（防校验器恒假）==")
const jsClean = validateRedFlagTables()
check("JS 校验器对现表放行", jsClean.length === 0, jsClean.slice(0, 3).join(" ;; "))
check("Py 校验器对现表放行", py.clean_errs.length === 0, py.clean_errs.slice(0, 3).join(" ;; "))

// 与 app/rules.py 的 apply_case 同语义：只改一处，原表只读。
const applyCase = (case_, danger, combo) => {
  const d = structuredClone(danger), c = structuredClone(combo)
  if (case_.op === "empty") return [[], []]
  const pool = case_.target === "danger" ? d : c
  const i = case_.index
  if (case_.op === "replace") { pool[i] = case_.replace; return [d, c] }
  const ref = case_.copy_name_from
  if (ref) pool[i].name = (ref.target === "danger" ? d : c)[ref.index].name
  for (const [k, v] of Object.entries(case_.set || {})) pool[i][k] = v
  return [d, c]
}

console.log("== 4. 同一份变异夹具双端各施一遍：两边都必须拒、且点名同一不变量 ==")
const jsMissed = [], pyMissed = [], phraseMissed = []
for (const case_ of mutSpec.cases) {
  const [d, c] = applyCase(case_, RULE_TABLES.DANGER, RULE_TABLES.COMBO)
  const jsErrs = validateRedFlagTables(d, c)
  const pyErrs = py.mutations[case_.id]
  if (pyErrs === undefined) { phraseMissed.push(`${case_.id}：Py 侧无该条目（dumper 与夹具脱节）`); continue }
  const hit = (list) => list.some((e) => e.includes(case_.expect))
  if (!jsErrs.length) jsMissed.push(case_.id)
  else if (!hit(jsErrs)) phraseMissed.push(`JS「${case_.id}」未点名「${case_.expect}」：${jsErrs[0]}`)
  if (!pyErrs.length) pyMissed.push(case_.id)
  else if (!hit(pyErrs)) phraseMissed.push(`Py「${case_.id}」未点名「${case_.expect}」：${pyErrs[0]}`)
  check(`变异「${case_.id}」双端均拒`, jsErrs.length > 0 && pyErrs.length > 0,
    `JS=${jsErrs.length} Py=${pyErrs.length}`)
}
check("JS 无漏拒", jsMissed.length === 0, `漏了 ${jsMissed.join(",")}`)
check("Py 无漏拒", pyMissed.length === 0, `漏了 ${pyMissed.join(",")}`)
check("错误信息两侧均点名不变量", phraseMissed.length === 0, phraseMissed.slice(0, 3).join(" ;; "))

console.log("== 5. 覆盖面：每条声明的不变量都至少被一条变异打到 ==")
const touched = new Set()
for (const case_ of mutSpec.cases) for (const cls of mutSpec.invariant_classes) if (case_.expect === cls) touched.add(cls)
const untouched = mutSpec.invariant_classes.filter((c) => !touched.has(c))
check(`不变量全覆盖（声明 ${mutSpec.invariant_classes.length} 类，被覆盖 ${touched.size} 类）`,
  untouched.length === 0, `未被任何变异触及：${untouched.join(",")}——声明了却没人验＝假安全`)

console.log("== 6. 静态自产文案过裸子串红线（禁用词单一源＝fixtures/red_line_phrases.json）==")
const forbidden = redLine.forbidden_phrases
check(`禁用词清单非空（${forbidden.length} 项）`, forbidden.length >= 3, "读空＝扫描失效")
const offenders = []
for (const [kind, list] of [["DANGER", RULE_TABLES.DANGER], ["COMBO", RULE_TABLES.COMBO]]) {
  list.forEach((r, i) => {
    for (const f of forbidden) {
      if (String(r.advice || "").includes(f) || String(r.name || "").includes(f)) offenders.push(`${kind}#${i}(${r.name}) 含「${f}」`)
    }
  })
}
check(`全部 advice/name 无裸子串命中（扫 ${RULE_TABLES.DANGER.length + RULE_TABLES.COMBO.length} 条 × ${forbidden.length} 词）`,
  offenders.length === 0, offenders.slice(0, 3).join(" ;; "))

// 反第二真值：禁用词清单只准存在于 fixture。上面两条扫描各自读它，但若有人再手抄一份三元素数组，
// 两份就会在不同轮各自被改——那正是本轮 #85 要消灭的形态（abstain_guard/scope_guard 此前各有一份）。
const DUP_SKIP = new Set(["node_modules", "dist", ".wrangler", "coverage", "archive", "sbom", ".git"])
const dupFiles = []
let dupScanned = 0
const walkForDup = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.isDirectory()) continue
    const abs = resolve(dir, e.name)
    if (e.isDirectory()) { if (!DUP_SKIP.has(e.name)) walkForDup(abs); continue }
    if (!/\.(mjs|js|py|json)$/.test(e.name) || e.name === "red_line_phrases.json") continue
    dupScanned++
    const text = readFileSync(abs, "utf8")
    if (/"替代医生"\s*,\s*"自动诊断"/.test(text)) dupFiles.push(relative(ROOT, abs).replace(/\\/g, "/"))
  }
}
walkForDup(ROOT)
check(`禁用词清单无第二份手抄（扫 ${dupScanned} 个源文件，命中 ${dupFiles.length} 处内联清单）`,
  dupFiles.length === 0 && dupScanned >= 50,
  dupFiles.length ? `手抄处：${dupFiles.slice(0, 4).join(", ")}——请改为读 fixtures/red_line_phrases.json`
    : `只扫到 ${dupScanned} 个文件＝扫描面失效，不许静默通过`)

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
