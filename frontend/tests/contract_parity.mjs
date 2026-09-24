// 双端黄金用例契约测试：同 31 组确定性输入分别跑 Functions(JS) 与 backend(Python) 引擎，
// 逐字段比对 dx/workup/report（数值容差 0.002 吸收两端浮点舍入差异；键序不敏感、数组序敏感）。
// 目的：拦截"一端修复、另一端静默漂移"。CI 中与前端套件同 job 执行。
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { buildDiagnosis, buildWorkup, buildReport } from "../functions/lib/engine.js"

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")
const suite = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8"))
const env = {}

const jsRecords = []
for (const item of suite.cases) {
  const caseId = item.case_id || "c1"
  const history = item.answers.map((answer) => ({ role: "user", content: answer }))
  const dx = await buildDiagnosis(caseId, history, env)
  const workup = await buildWorkup(caseId, history, env, dx)
  const report = await buildReport(caseId, history, env, dx)
  jsRecords.push({ id: item.id, dx, workup, report })
}

const dumpPath = fileURLToPath(new URL("../../backend/tests/contract_dump.py", import.meta.url))
const proc = spawnSync(PY, [dumpPath], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 })
if (proc.status !== 0) {
  console.error(`python dump 失败（${PY}）:\n${(proc.stderr || "").slice(0, 2000)}`)
  process.exit(1)
}
const pyRecords = JSON.parse(proc.stdout)

const NUM_TOLERANCE = 0.002

function collectDiff(a, b, path, diffs) {
  if (diffs.length > 40) return
  const av = a === undefined ? null : a
  const bv = b === undefined ? null : b
  if (av === null || bv === null || typeof av !== "object" || typeof bv !== "object") {
    if (typeof av === "number" && typeof bv === "number") {
      if (Math.abs(av - bv) > NUM_TOLERANCE) diffs.push(`${path}: ${av} != ${bv}`)
      return
    }
    if (av !== bv) diffs.push(`${path}: ${JSON.stringify(av)} != ${JSON.stringify(bv)}`)
    return
  }
  if (Array.isArray(av) || Array.isArray(bv)) {
    if (!Array.isArray(av) || !Array.isArray(bv) || av.length !== bv.length) {
      diffs.push(`${path}: 数组形状不同 ${av?.length} vs ${bv?.length}`)
      return
    }
    for (let i = 0; i < av.length; i++) collectDiff(av[i], bv[i], `${path}[${i}]`, diffs)
    return
  }
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)])
  for (const key of keys) collectDiff(av[key], bv[key], path ? `${path}.${key}` : key, diffs)
}

const caseResults = []
const pyById = new Map(pyRecords.map((r) => [r.id, r]))
let failCount = 0
for (const js of jsRecords) {
  const py = pyById.get(js.id)
  if (!py) {
    caseResults.push({ id: js.id, diffs: ["python 侧缺该用例"] })
    failCount++
    continue
  }
  const diffs = []
  for (const part of ["dx", "workup", "report"]) collectDiff(js[part], py[part], part, diffs)
  if (diffs.length) { failCount++; caseResults.push({ id: js.id, diffs }) }
}

if (jsRecords.length !== pyRecords.length) {
  console.error(`用例数不一致 JS=${jsRecords.length} PY=${pyRecords.length}`)
  process.exit(1)
}
for (const r of caseResults) {
  console.error(`[漂移] ${r.id}:`)
  for (const d of r.diffs.slice(0, 8)) console.error(`  - ${d}`)
}
console.log(`双端契约比对: ${jsRecords.length - failCount}/${jsRecords.length} 一致 ${failCount === 0 ? "ALL PASS" : "FAIL"}`)
process.exit(failCount === 0 ? 0 : 1)
