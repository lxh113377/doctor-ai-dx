// 线上 live 链路评测（第二十四轮从参赛工作区收进本仓：此前 README 让人去跑一个 clone 后不存在的路径，
// ⇒ EVAL_CARD 的 P50/P95 对第三方是「只有结论、没有可跑的复现脚本」。报告写 .eval/（不入库，见 .gitignore）。
// 线上 live 链路评测：结构/引用/模式 + P50/P95/max 时延实测（直连，无代理）
// 证据用于 应用方案 与 答辩："AI 确实参与核心链路 + 时延达标 + 降级可用"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE } from "../frontend/functions/lib/knowledge.js"

// 参数一律走 argv 而不是环境变量：本脚本是**工具链面**（评测者手工跑），不是应用配置。
// 用 env 会被 tests/env_guard.mjs 按「应用从零启动的声明面」口径要求写进 backend/.env.example，
// 那会往使用者的人读入口里塞两个跑演示根本用不到的键（第二十三轮已为 CI 令牌避开过一次，同一判断）。
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const BASE = arg("--base", "https://doctor-ai-dx.pages.dev").replace(/\/$/, "")
const VALID = new Set(KNOWLEDGE_BASE.map((k) => k.id))
const suite = JSON.parse(readFileSync(new URL("../frontend/tests/fixtures/eval_cases.json", import.meta.url), "utf8"))

const lat = []
function pct(arr, p) { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * p))] }

async function post(path, body) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const ms = Date.now() - t0
  const json = await res.json()
  return { ms, ok: res.ok, data: json.data }
}

let structPass = 0, citePass = 0, modeLive = 0, modeFallback = 0, flagOk = 0, flagTotal = 0, abstainCount = 0
const failures = []

for (const c of suite.cases) {
  const caseId = c.case_id || "c1"
  const history = c.answers.map((a) => ({ role: "user", content: a }))
  const errs = []
  const r = await post("/api/dx/" + caseId, { case_id: caseId, history })
  lat.push(r.ms)
  const d = r.data
  if (!d) { errs.push("无响应"); failures.push({ id: c.id, errs }); continue }
  if (d.mode === "live") modeLive++; else if (d.mode === "rule-fallback") modeFallback++
  if (d.abstain === true) {
    // 线上第三态（#52）：弃权是另一种合法形状，但必须"只出弃权卡 + 红旗字段在场"，
    // 且同样计入"红旗不得被弃权吞掉"的检查——否则线上把弃权当成功掩盖漏报。
    if (d.scope_status !== "insufficient-information" && d.scope_status !== "out-of-scope") errs.push("abstain但scope非法")
    if (d.primary?.length !== 1 || d.primary[0]?.name !== "信息不足，建议补充问诊") errs.push("弃权态未收敛为弃权卡")
    if ((d.differential || []).length !== 0) errs.push("弃权态仍给鉴别诊断")
    if (!Array.isArray(d.flags)) errs.push("弃权态flags缺失")
    abstainCount++
  } else {
    if (!Array.isArray(d.primary) || d.primary.length < 2) errs.push("primary<2")
    if (!Array.isArray(d.differential) || d.differential.length < 2) errs.push("differential<2")
    if (d.scope_status !== "in-scope") errs.push(`未弃权但scope=${d.scope_status}`)
  }
  if (!Array.isArray(d.evidence) || d.evidence.length < 2) errs.push("evidence<2")
  const ids = [...(d.evidence || []).map((e) => e.id), ...(d.trace?.evidence_ids || []), ...d.primary.flatMap((p) => p.evidence_ids || [])]
  const bad = ids.filter((i) => !VALID.has(i))
  if (bad.length) errs.push("非法引用:" + bad.join(",")); else citePass++
  if (errs.length === 0) structPass++
  if (c.expect_flag === true) { flagTotal++; if (d.flags.length > 0) flagOk++ }
  if (errs.length) failures.push({ id: c.id, scene: c.scene, errs })
}

// workup/report 时延（3 演示病例，携带已生成 dx = 前端真实路径，单次 LLM）
const wrLat = []
for (const cid of ["c1", "c2", "c3"]) {
  const history = [{ role: "user", content: "压榨样胸痛向左肩放射出冷汗" }]
  const d = await post("/api/dx/" + cid, { case_id: cid, history })
  const w = await post("/api/workup/" + cid, { case_id: cid, history, dx: d.data }); wrLat.push(w.ms)
  const rp = await post("/api/report/" + cid, { case_id: cid, history, dx: d.data })
  wrLat.push(rp.ms)
  if (!w.data?.essential?.length) failures.push({ id: "workup-" + cid, errs: ["三组空"] })
  if (!rp.data?.soap?.subjective) failures.push({ id: "report-" + cid, errs: ["SOAP空"] })
}

const n = suite.cases.length
const report = {
  date: new Date().toISOString(), base: BASE,
  dx_latency_ms: { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
  workup_report_latency_ms: { n: wrLat.length, p50: pct(wrLat, 0.5), p95: pct(wrLat, 0.95), max: Math.max(...wrLat) },
  structure_pass: `${structPass}/${n}`,
  abstain_cases: `${abstainCount}/${n}`,
  citation_valid: `${citePass}/${n}`,
  mode_distribution: { live: modeLive, rule_fallback: modeFallback },
  red_flag_recall_live: `${flagOk}/${flagTotal}`,
  p95_within_10s: pct(lat, 0.95) <= 10000,
  failures,
}
const outputPath = arg("--report", "")
const reportPath = resolve(outputPath || fileURLToPath(new URL("../.eval/eval_report_live.json", import.meta.url)))
// .eval/ 不入库（见 .gitignore），所以全新 clone 里它不存在——报告落盘前自建目录，
// 否则「跑一次复现脚本」在干净环境里第一步就 ENOENT 崩掉（实测），复现承诺同样落空。
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))

// 性能与质量硬门禁：任一不达标即非零退出（P95≤10s 为线上性能约束，见 AGENTS.md 06 节）
const gate = []
if (report.failures.length) gate.push(`失败用例 ${report.failures.length}`)
if (!report.p95_within_10s) gate.push(`dx P95 ${report.dx_latency_ms.p95}ms > 10000ms`)
if (report.structure_pass !== `${n}/${n}`) gate.push(`结构 ${report.structure_pass}`)
if (report.citation_valid !== `${n}/${n}`) gate.push(`引用 ${report.citation_valid}`)
if (report.red_flag_recall_live !== `${flagTotal}/${flagTotal}`) gate.push(`红旗 ${report.red_flag_recall_live}`)
if (gate.length) {
  console.error("LIVE GATE FAIL: " + gate.join("；"))
  process.exit(1)
}
console.log("LIVE GATE PASS: 结构/引用/红旗全过 且 P95 ≤ 10s")
