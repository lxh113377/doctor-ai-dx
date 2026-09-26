// 性能基线门禁：对最近一次 live 评测报告做硬断言（P95≤10s + 新鲜度≤14 天 + 全过），
// 把"已实测的 4.7s"变成防退化资产。CI 无密钥且不出网，本脚本守的是"最新记录必须达标且未过期"。
// 用法：npm --prefix frontend run perf:gate（须先跑 npm --prefix frontend run eval:live）
// 报告缺失 ⇒ exit 2 UNKNOWN：新鲜度判据没有分母时不许记 PASS
// （同 scripts/ci_watch.py 的「一条 run 都没观察到＝UNKNOWN 而不是通过」口径）。
import { existsSync, readFileSync } from "node:fs"

const FRESH_DAYS = 14
const P95_LIMIT_MS = 10000
const reportPath = new URL("../.eval/eval_report_live.json", import.meta.url)

if (!existsSync(reportPath)) {
  console.log("UNKNOWN  .eval/eval_report_live.json 不存在 —— 先跑 npm --prefix frontend run eval:live（需公网可达）")
  process.exit(2)
}

const r = JSON.parse(readFileSync(reportPath, "utf8"))
const ageDays = (Date.now() - new Date(r.date).getTime()) / 86400000
const checks = [
  ["dx P95 ≤ 10s", r.dx_latency_ms?.p95 <= P95_LIMIT_MS],
  ["workup+report P95 ≤ 10s", (r.workup_report_latency_ms?.p95 ?? 0) <= P95_LIMIT_MS],
  ["结构全过", r.structure_pass === r.dx_latency_ms.n + "/" + r.dx_latency_ms.n],
  ["引用全过", r.citation_valid === r.dx_latency_ms.n + "/" + r.dx_latency_ms.n],
  ["线上红旗全过", (() => { const [h, t] = String(r.red_flag_recall_live).split("/"); return h === t })()],
  [`报告新鲜度 ≤ ${FRESH_DAYS} 天（当前 ${ageDays.toFixed(1)} 天，重跑 npm --prefix frontend run eval:live）`, ageDays <= FRESH_DAYS],
]
let fail = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`)
  if (!ok) fail++
}
console.log(fail === 0 ? "PERF GATE ALL PASS" : `PERF GATE FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
