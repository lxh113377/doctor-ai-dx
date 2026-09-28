// 性能基线门禁：对最近一次 live 评测报告做硬断言（P95≤10s + 新鲜度≤14 天 + 全过），
// 把"已实测的 4.7s"变成防退化资产。CI 无密钥且不出网，本脚本守的是"最新记录必须达标且未过期"。
// 用法：npm --prefix frontend run perf:gate（须先跑 npm --prefix frontend run eval:live）
// 可选：--report <path> 换报告面（参赛工作区用）；--cases-ref <git HEAD 内的用例 JSON 路径> 换分母基准。
//
// 第五轮 #169 收口：本文件是**CI 真正执行的那一份**（live-smoke.yml online-eval 作业）。
// 第五十二轮时参赛工作区 `work/perf_gate.mjs` 先修了三处缺陷（分母取自报告自述、比率按字符串 split、
// 无「线上命名⇄实到链路」对账），而这里没修 ⇒ 同事实两份实现、改错一半等于没改（#149 原话）。
// 本轮把三条判据搬进本文件并**加第四维（降级原因可归因）**，`work/perf_gate.mjs` 改为薄委托，
// 判据只住这一处。
//
// ⚠️ 适用范围如实写（第四十四轮实测）：本脚本唯一的 CI 执行点在 live-smoke.yml 的 online-eval 作业里，
//    而那里的报告是同一次作业的上一步刚生成的 ⇒「新鲜度 ≤14 天」在那个位置**恒真**，抓不到过期。
//    要能真的过期，得让证据跨 run 留存（作业把报告发布成 artifact），并由
//    scripts/live_freshness_guard.py 在**别的**作业里回读时间戳——同一事实只许一处判：
//    新鲜度的可失败判据在守卫那边；本脚本只管「这次产出的报告达标与否＋本机重跑时的新鲜度」。
// 报告缺失 ⇒ exit 2 UNKNOWN：新鲜度判据没有分母时不许记 PASS
// （同 scripts/ci_watch.py 的「一条 run 都没观察到＝UNKNOWN 而不是通过」口径）。
import { existsSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const FRESH_DAYS = 14
const P95_LIMIT_MS = 10000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const DEFAULT_REPORT = new URL("../.eval/eval_report_live.json", import.meta.url)
const DEFAULT_CASES_REF = "frontend/tests/fixtures/eval_cases.json"

function argOf(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : ""
}
const reportPath = argOf("--report") || path.resolve(fileURLToPath(DEFAULT_REPORT))
const casesRef = argOf("--cases-ref") || DEFAULT_CASES_REF
// 分母基准所属的仓：参赛工作区（医）与公开仓是**两个仓**，HEAD 里的用例文件路径也不同。
// 不给这个参数时取公开仓自己的 HEAD。
const casesRepo = path.resolve(argOf("--cases-repo") || REPO)

if (!existsSync(reportPath)) {
  console.log(`UNKNOWN  ${reportPath} 不存在 —— 先跑 npm --prefix frontend run eval:live（需公网可达）`)
  process.exit(2)
}

const r = JSON.parse(readFileSync(reportPath, "utf8"))
const ageDays = (Date.now() - new Date(r.date).getTime()) / 86400000

// 分母不得取自被检产物自己：报告里的 `dx_latency_ms.n` 是生产方自述，
// 用例集从 31 缩到 20 时它自己跟自己相等，照样 PASS。现从 **git HEAD 的用例文件**现算。
function headCases() {
  const txt = execFileSync("git", ["-C", casesRepo, "show", `HEAD:${casesRef}`], { encoding: "utf8" })
  const cs = JSON.parse(txt).cases
  return {
    total: cs.length,
    positives: cs.filter((c) => c.expect_flag === true).length,
  }
}
let ref = null
try {
  ref = headCases()
} catch (e) {
  console.log(`UNVERIFIED  分母基准｜HEAD:${casesRef} 取不到（${String(e.message).slice(0, 60).replace(/\n/g, " ")}）⇒ 本维不得记绿`)
}
const ratio = (s) => {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(String(s || "").trim())
  return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]
}
const [rfh, rft] = ratio(r.red_flag_recall_live)
const liveCount = Number((r.mode_distribution || {}).live ?? NaN)
const fallbackTotal = Number(r.fallback_cases_total ?? (r.mode_distribution || {}).rule_fallback ?? 0)
const causeDist = r.fallback_cause_distribution || {}
const causeSum = Object.values(causeDist).reduce((a, b) => a + Number(b || 0), 0)
const causeSeen = Number(r.fallback_cause_field_cases ?? 0)
const unattributed = Number(causeDist.unattributed || 0)

const checks = [
  ["dx P95 ≤ 10s", r.dx_latency_ms?.p95 <= P95_LIMIT_MS],
  ["workup+report P95 ≤ 10s", (r.workup_report_latency_ms?.p95 ?? 0) <= P95_LIMIT_MS],
  ["结构全过（分母＝HEAD 用例数，非报告自述）",
    !!ref && r.structure_pass === ref.total + "/" + ref.total && Number(r.dx_latency_ms?.n) === ref.total,
    `实得 ${r.structure_pass}／n=${r.dx_latency_ms?.n}，基准 ${ref ? ref.total : "?"} 例`],
  ["引用全过（分母同上）", !!ref && r.citation_valid === ref.total + "/" + ref.total,
    `实得 ${r.citation_valid}，基准 ${ref ? ref.total : "?"} 例`],
  ["线上红旗全过（分母＝HEAD 中 expect_flag=true 的例数）",
    !!ref && rfh === rft && rft === ref.positives, `实得 ${r.red_flag_recall_live}，基准 ${ref ? ref.positives : "?"} 例`],
  // 文件名与判据名都写着"线上"，但 mode_distribution.live 实测可为 0（全走 rule-fallback）
  // ⇒ 所谓"线上 P95 860ms"量的是回落链路。命名与行为不对账＝把降级态当质量读数。
  ["线上命名⇄实到链路对账（live 例数须等于 HEAD 用例数）",
    !!ref && liveCount === ref.total,
    `live ${Number.isNaN(liveCount) ? "?" : liveCount}／基准 ${ref ? ref.total : "?"} 例`
    + (ref && liveCount === ref.total ? "" : " ⇒ 本报告的 P95 是**回落链路**耗时，不得当线上质量读数")],
  [`报告新鲜度 ≤ ${FRESH_DAYS} 天（当前 ${ageDays.toFixed(1)} 天，重跑 npm --prefix frontend run eval:live）`, ageDays <= FRESH_DAYS],
]

// 第四维：降级**可归因**（#146）。回落本身是设计内行为，说不清为什么回落才是缺陷。
// 三态：无回落 ⇒ 该维不适用（不记绿也不记红）；线上构建尚无该字段 ⇒ UNVERIFIED；有字段但归因不全 ⇒ FAIL。
let causeState = "NA"
let causeNote = `回落 ${fallbackTotal} 例 ⇒ 无需归因`
if (fallbackTotal > 0) {
  if (causeSeen === 0) {
    causeState = "UNVERIFIED"
    causeNote = `回落 ${fallbackTotal} 例、其中 ${causeSeen} 例的响应带 fallback_cause ⇒ 线上构建早于该字段（发版后自愈），本轮不判绿也不判红`
  } else if (causeSeen !== fallbackTotal || causeSum !== fallbackTotal || unattributed > 0) {
    causeState = "FAIL"
    causeNote = `回落 ${fallbackTotal} 例／带字段 ${causeSeen} 例／原因合计 ${causeSum} 条／unattributed ${unattributed} 例`
      + ` ⇒ ${JSON.stringify(causeDist)}（不可归因的降级不算可运维）`
  } else {
    causeState = "PASS"
    causeNote = `回落 ${fallbackTotal} 例全部可归因 ${JSON.stringify(causeDist)}`
  }
}
if (causeState === "FAIL") checks.push(["降级原因可归因（回落例须 100% 带类别）", false, causeNote])
else console.log(`${causeState === "PASS" ? "PASS" : "UNVERIFIED"}  降级原因可归因（回落例须 100% 带类别）  ${causeNote}`)

let fail = ref ? 0 : 1
for (const [name, ok, note] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  ${note}` : ""}`)
  if (!ok) fail++
}
console.log(fail === 0 ? `PERF GATE ALL PASS${causeState === "UNVERIFIED" ? "（含 1 维 UNVERIFIED：原因归因待线上构建携带字段）" : ""}` : `PERF GATE FAIL (${fail})`)
process.exit(fail === 0 ? 0 : 1)
