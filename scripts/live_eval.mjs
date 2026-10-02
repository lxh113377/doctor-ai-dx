// 线上 live 链路评测（第二十四轮从参赛工作区收进本仓：此前 README 让人去跑一个 clone 后不存在的路径，
// ⇒ EVAL_CARD 的 P50/P95 对第三方是「只有结论、没有可跑的复现脚本」。报告写 .eval/（不入库，见 .gitignore）。
// 线上 live 链路评测：结构/引用/模式 + P50/P95/max 时延实测（直连，无代理）
// 证据用于 应用方案 与 答辩："AI 确实参与核心链路 + 时延达标 + 降级可用"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE, KB_BY_ID } from "../frontend/functions/lib/knowledge.js"
import { supportRatio } from "../frontend/tests/grounding_ruler.mjs"
import { buildProvenance } from "./eval_provenance.mjs"

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
// --limit：通路间歇（台账 #146）时先跑前 N 例拿真读数，比"整批跑到超时然后什么都没有"有用。
// 用了它就**必须把"样本"这件事带进报告与终行**（分母两侧都印），否则 10 例的读数会被读成 31 例的。
const CASES_ALL = Array.isArray(suite.cases) ? suite.cases : []
const LIMIT = Number(arg("--limit", String(CASES_ALL.length)))
const CASES = Number.isFinite(LIMIT) && LIMIT > 0 ? CASES_ALL.slice(0, Math.floor(LIMIT)) : CASES_ALL
if (CASES.length === 0) {
  console.log(`FAIL :: 用例取到 0 例（面内 ${CASES_ALL.length} 例，limit=${arg("--limit", "未给")}）⇒ 零输入绝不记 ALL PASS`)
  console.log("[GATE:eval-empty-denominator]")
  process.exit(2)
}
if (CASES.length < CASES_ALL.length) console.log(`⚠️ 本轮是**样本**：前 ${CASES.length} 例 / 面内 ${CASES_ALL.length} 例——所有分母均按 ${CASES.length} 计，不得当全量引用`)

// 引用落地性（第七十七轮，台账 #202 的 live 面）：尺与 npm run probe:grounding 同一把
// （tests/grounding_ruler.mjs 单一源，不在此另立第二真值）。
// 为什么在 live 面才量得到：回填通道（functions/lib/engine.js 的 validateDiagnosis，
// LLM 未挂引用时回填全局检索证据）只在带 Key 的 live 分支触发，rule-fallback 面上构造性测不到——
// 第七十五轮的探针因此自带 blind 行而不是宣称全绿。
// 客户端响应只拿得到**最终** evidence_ids，分不清哪几个是 LLM 自己挂的、哪几个是回填的；
// 所以这里量的是结果侧的"支撑有无"（口径A＝诊断名 ⇄ 所引条目正文），不是回填计数——
// 低支撑=引用没落在讲这个病的条目上，回填是其成因之一而非唯一成因，读数按此措辞引用。
const kbText = (id) => { const k = KB_BY_ID.get(id); return k ? `${k.title || ""} ${k.condition || ""} ${k.text || ""}` : "" }
const gSelf = []
const gCtrl = []
const gBad = []


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
const modeByCase = {}
const failures = []

for (const c of CASES) {
  const caseId = c.case_id || "c1"
  const history = c.answers.map((a) => ({ role: "user", content: a }))
  const errs = []
  const r = await post("/api/dx/" + caseId, { case_id: caseId, history })
  lat.push(r.ms)
  const d = r.data
  if (!d) { errs.push("无响应"); failures.push({ id: c.id, errs }); continue }
  if (d.mode === "live") modeLive++; else if (d.mode === "rule-fallback") modeFallback++
  modeByCase[c.id] = { mode: String(d.mode), abstain: d.abstain === true, cause: String(d.fallback_cause ?? ""),
    // 线上构建是否已携带该字段（发版前的旧构建根本没这个键）——判据据此分"不可归因"与"尚未上线"，
    // 不把部署状态伪装成代码缺陷（同 freeze_check 的 UNVERIFIED 档）。
    has_cause_field: Object.prototype.hasOwnProperty.call(d, "fallback_cause") }
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
  // 落地性逐条计分（非弃权例；弃权例的 primary 是承诺的弃权卡，不参与"挂错条"判定）
  if (d.abstain !== true) {
    const items = [...(d.primary || []), ...(d.differential || [])]
    items.forEach((it, ii) => {
      const ids = (it && Array.isArray(it.evidence_ids)) ? it.evidence_ids : []
      const cited = ids.map(kbText).filter(Boolean)
      const claim = String((it && it.name) || "")
      if (!cited.length || claim.length < 2) return
      const m = supportRatio(claim, cited)
      if (m.ratio === null) return
      gSelf.push(m.ratio)
      const own = new Set(ids)
      const alt = KNOWLEDGE_BASE.map((k) => k.id).filter((x) => !own.has(x))
      if (alt.length) {
        const pick = [alt[(gSelf.length * 7) % alt.length]]
        const mc = supportRatio(claim, pick.map(kbText).filter(Boolean))
        if (mc.ratio !== null) gCtrl.push(mc.ratio)
      }
      if (m.ratio < 0.34) {
        // 本可改引的条目：全库里对该结论名支撑最高、且**不在它现有引用里**的那一条。
        // 为什么当场算而不是留给下一轮：处置 12 条低支撑时第一个要问的就是"那它该引谁"，
        // 让下一轮重新跑一遍线上才能拿到这个数，等于把同一笔网络成本付两次（且通路按时刻可断）。
        // 归类口径（不引入任何外部断言，纯读数）：alt_ratio 明显高于 ratio ⇒ 内容侧问题（语料里有更合适的条目，是挂错）；
        // alt_ratio 也低 ⇒ 机制/语料侧问题（这 60 条里根本没有讲这个病的条目），两者处置动作不同，不许混成一条待办。
        const own = new Set(ids)
        let alt = null
        for (const k of KNOWLEDGE_BASE) {
          if (own.has(k.id)) continue
          const s = supportRatio(claim, [kbText(k.id)])
          if (s.ratio === null) continue
          if (!alt || s.ratio > alt.ratio) alt = { id: k.id, source: k.source, year: k.year, ratio: s.ratio }
        }
        gBad.push({
          case: c.id, scene: c.scene, item: claim.slice(0, 30), ids,
          ratio: Number(m.ratio.toFixed(3)),
          alt_id: alt ? alt.id : null, alt_source: alt ? alt.source : null,
          alt_ratio: alt ? Number(alt.ratio.toFixed(3)) : null,
          kind: alt ? (alt.ratio >= m.ratio + 0.2 ? "挂错条(内容侧有更适条目)" : "语料无对应条目(机制/语料侧)") : "无替代候选",
        })
      }

    })
  }

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

const n = CASES.length
const gm = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const liveSelf = gm(gSelf); const liveCtrl = gm(gCtrl)
const grounding_obj = {
  items_scored: gSelf.length, control_scored: gCtrl.length,
  mean_support: liveSelf === null ? null : Number(liveSelf.toFixed(3)),
  mean_control: liveCtrl === null ? null : Number(liveCtrl.toFixed(3)),
  below_034: gBad.length,
  // 0.34 不是本轮拍的：它取第七十五轮同尺两侧边界（自证 1.000／刻意错配 0.059）之间的低位，
  // 且本轮只作分布读数不作闸（R236 补注③：标定前先测两侧）。
  ruler: "frontend/tests/grounding_ruler.mjs（与 npm run probe:grounding 同一把）",
  sample: CASES.length < CASES_ALL.length ? `前 ${CASES.length}/${CASES_ALL.length} 例` : "全量",
  weakest: gBad,
}
console.log(`引用落地性（live 面，口径A＝诊断名⇄所引条目）：计分 ${gSelf.length} 条｜对照 ${gCtrl.length} 条｜`
  + `mean_support=${grounding_obj.mean_support}｜mean_control=${grounding_obj.mean_control}｜低于 0.34 的 ${gBad.length} 条｜样本=${grounding_obj.sample}`)
const wrongBind = gBad.filter((x) => x.kind.startsWith("挂错条")).length
console.log(`低支撑归类（同一把尺，alt＝全库里对该结论名支撑最高且未被引的条目）：挂错条 ${wrongBind} 条／语料无对应条目 ${gBad.length - wrongBind} 条／无替代候选 ${gBad.filter((x) => !x.alt_id).length} 条`)
if (gSelf.length && liveCtrl !== null && liveSelf !== null && liveSelf <= liveCtrl) {
  console.log("⚠️ [GATE:live-grounding-flat] 本轮 live 读数的自证支撑不高于刻意错配 ⇒ 与 rule-fallback 面（1.000/0.059）形状不同，须逐例看是不是引用没落在讲这个病的条目上")
} else if (gSelf.length) {
  console.log("[GATE:live-grounding-scored] 两侧读数已取到，可作 #202 的标定依据（不当闸）")
}
const report = {
  date: new Date().toISOString(), base: BASE,
  // #218：live 读数此前**一个 provenance 字段都没有**，所以「P95 4602ms」挂不到任何一组输入字节上。
  // 注意取数时刻＝本次请求跑完之后、落盘之前；引擎/知识若在期间被改，下面记的是改后的字节，
  // 而工作树相对 HEAD 的脏度一并记在 provenance.git 里，由判据去分「已提交」与「在途」。
  provenance: buildProvenance({
    casesPath: fileURLToPath(new URL("../frontend/tests/fixtures/eval_cases.json", import.meta.url)),
    runnerPath: "scripts/live_eval.mjs",
  }),
  dx_latency_ms: { n: lat.length, p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.max(...lat) },
  workup_report_latency_ms: { n: wrLat.length, p50: pct(wrLat, 0.5), p95: pct(wrLat, 0.95), max: Math.max(...wrLat) },
  structure_pass: `${structPass}/${n}`,
  abstain_cases: `${abstainCount}/${n}`,
  citation_valid: `${citePass}/${n}`,
  mode_distribution: { live: modeLive, rule_fallback: modeFallback },
  // 降级原因分布（#146）：只有"回落了多少例"而说不出"为什么回落"，运维就只能猜。
  // 空原因一律记 unattributed —— 让"不可归因"本身成为一个会被门禁抓住的读数，而不是默认无害。
  fallback_cause_distribution: Object.values(modeByCase)
    .filter((x) => x.mode !== "live")
    .reduce((acc, x) => {
      const k = x.cause || "unattributed"
      acc[k] = (acc[k] || 0) + 1
      return acc
    }, {}),
  // 回落例里"响应确实带 fallback_cause 字段"的例数。线上构建早于该字段时此数为 0 ⇒
  // 判据据此走 UNVERIFIED（尚未上线）而不是 FAIL（代码不可归因），也不得记 PASS。
  fallback_cause_field_cases: Object.values(modeByCase).filter((x) => x.mode !== "live" && x.has_cause_field).length,
  fallback_cases_total: Object.values(modeByCase).filter((x) => x.mode !== "live").length,
  mode_by_case: modeByCase,
  unexpected_fallback: Object.values(modeByCase).filter((x) => x.mode !== 'live' && !x.abstain).length,
  red_flag_recall_live: `${flagOk}/${flagTotal}`,
  p95_within_10s: pct(lat, 0.95) <= 10000,
  grounding: grounding_obj,
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
// 第四十六轮补的下限判据，且**装在 CI 真正跑的那一份里**：
// 上一轮我把同名判据加进了参赛工作区的副本（iCAN…/03-评测/live_eval.mjs），而 `npm run eval:live`
// 指向的是本文件 ⇒ 10:35Z 的 live=6/25 与 10:44Z 的 live=0/31 在 CI 侧全都报绿。
// 同一事实两处实现，改错那一半等于没改（台账 #149）。
// 只钉 live === 0 这条无阈值可辩的下限：回落里混着设计内弃权（域外/信息不足用规则答是正确行为），
// 占比阈值等 unexpected_fallback 攒够基线再定；本轮先把按例读数记进报告并由作业发成工件。
if (modeLive === 0) gate.push('线上大模型通道一次都没走通（live=0、rule_fallback=' + modeFallback
  + '、非设计内回落=' + report.unexpected_fallback + '）⇒ 本报告不得作为 EVAL_CARD 头条数字来源')
console.log('通道读数: live=' + modeLive + ' rule_fallback=' + modeFallback + ' abstain=' + abstainCount
  + ' 非设计内回落=' + report.unexpected_fallback + '/' + n + '（占比阈值待定，先攒基线）')
if (report.structure_pass !== `${n}/${n}`) gate.push(`结构 ${report.structure_pass}`)
if (report.citation_valid !== `${n}/${n}`) gate.push(`引用 ${report.citation_valid}`)
if (report.red_flag_recall_live !== `${flagTotal}/${flagTotal}`) gate.push(`红旗 ${report.red_flag_recall_live}`)
if (gate.length) {
  console.error("LIVE GATE FAIL: " + gate.join("；"))
  process.exit(1)
}
console.log("LIVE GATE PASS: 结构/引用/红旗全过 且 P95 ≤ 10s")
