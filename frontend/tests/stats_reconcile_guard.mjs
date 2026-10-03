// 后台统计口径守卫（r96）：**用真 SQL 与暴力扫描对账**，不是正则比对源码。
//
// 为什么必须真跑：本仓已经为「正则对账」付过学费（#222 注册≠接线——源码里有字段但没人执行，
// 而正则恰恰认「源码里写了」就算通过）。这批指标是要给人看、给评审问的数字，
// 「看起来写得对」和「算出来对」之间隔着一个 SQLite。
//
// 做法：node:sqlite 起一张内存库，灌入 scripts/d1_schema.sql 建表，塞一批**确定性**合成数据，
// 然后同一批 SELECT 算两遍——一遍 SQL（走 chat_store.js 的 STATS_SQL 单一源），
// 一遍纯 JS 逐行扫；两边必须逐项相等。不等即口径 bug。
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { STATS_SQL, STATS_QUERY_COUNT, ENDED_PROXY_NOTE, PROVIDERS, ATTRIBUTION_FIELDS } from "../functions/lib/chat_store.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const schemaSql = readFileSync(REPO + "scripts/d1_schema.sql", "utf8")

// ============ 确定性合成数据（**不得用 Math.random**：数字要对账就必须可复算）============
// 8 个会话：3 个已评价分高、2 个已评价分低（含 1 分为 ≤2 的低分清单用）、1 个已评价且转人工、2 个未评价。
const SEED = [
  { id: "cv1", handed_off: 0, feedback: 5, first_ms: 120, provider: "codebuddy", intent: "general_medical" },
  { id: "cv2", handed_off: 0, feedback: 4, first_ms: 300, provider: "llm", intent: "med_ref_referral" },
  { id: "cv3", handed_off: 0, feedback: 3, first_ms: 180, provider: "rule", intent: "report_interp" },
  { id: "cv4", handed_off: 0, feedback: 2, first_ms: 900, provider: "llm", intent: "fee_flow" },
  { id: "cv5", handed_off: 0, feedback: 1, first_ms: 1500, provider: "fallback", intent: "symptom_consult" },
  { id: "cv6", handed_off: 1, feedback: 3, first_ms: 60, provider: "codebuddy", intent: "out_of_scope", reason_code: "USER_REQUESTED" },
  { id: "cv7", handed_off: 1, feedback: null, first_ms: 240, provider: "rule", intent: "general_medical", reason_code: "REPEATED_FAILURE" },
  { id: "cv8", handed_off: 0, feedback: null, first_ms: 0, provider: "rule", intent: "general_medical" },
]

function buildDb() {
  const db = new DatabaseSync(":memory:")
  db.exec(schemaSql)
  const insConv = db.prepare("INSERT INTO conversations (id, created_at, updated_at, turn_count, handed_off, satisfaction) VALUES (?, ?, ?, ?, ?, ?)")
  const insMsg = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, redacted_hits, red_flag, intent, confidence, kb_hits, source_refs, provider, latency_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
  const insEv = db.prepare("INSERT INTO intent_events (id, conversation_id, intent, confidence, matched, created_at) VALUES (?,?,?,?,?,?)")
  const insFb = db.prepare("INSERT INTO feedback (id, conversation_id, score, tag, comment, created_at) VALUES (?,?,?,?,?,?)")
  const insHo = db.prepare("INSERT INTO handoffs (id, conversation_id, reason_code, reason_text, context_digest, status, created_at) VALUES (?,?,?,?,?,?,?)")
  for (const s of SEED) {
    insConv.run(s.id, "2026-10-04T00:00:00.000Z", "2026-10-04T00:00:00.000Z", 2, s.handed_off, s.feedback)
    // handed_off=1 的会话必须有工单行（否则「转人工率」与「工单分布」两套数字会互相矛盾）
    if (s.handed_off) insHo.run(`ho_${s.id}`, s.id, s.reason_code, "", "", "open", "2026-10-04T00:00:05.000Z")
    // 用户消息：provider/latency 按惯例置 0（这条 wr 不影响首响均值）
    insMsg.run(`m_${s.id}_u`, s.id, "user", "主诉内容", "[]", 0, s.intent, 0.5, "[]", "[]", "rule", 0, "2026-10-04T00:00:01.000Z")
    insMsg.run(`m_${s.id}_a1`, s.id, "assistant", "助手首条回复", "[]", 0, s.intent, 0.6, JSON.stringify(["kb_entry_a"]), JSON.stringify(["kb_entry_a"]), s.provider, s.first_ms, "2026-10-04T00:00:02.000Z")
    // 第二条助手消息：延迟故意更大——若均值取「所有助手消息」而非「首条」，结果会偏，对账能抓出来
    insMsg.run(`m_${s.id}_a2`, s.id, "assistant", "助手追问", "[]", 0, s.intent, 0.6, "[]", "[]", s.provider, s.first_ms + 2000, "2026-10-04T00:00:03.000Z")
    insEv.run(`ev_${s.id}`, s.id, s.intent, 0.6, JSON.stringify(["匹配词"]), "2026-10-04T00:00:01.500Z")
    if (s.feedback !== null) insFb.run(`fb_${s.id}`, s.id, s.feedback, "", "", "2026-10-04T00:00:04.000Z")
  }
  return db
}

const db = buildDb()
const q = (sql) => db.prepare(sql).all()
const scalar = (sql) => Number((q(sql)[0] || {}).n || 0)

console.log("== 归因字段能在真实 SQLite 里落存并读回 ==")
check("messages 表六个归因列齐备（schema v3）", ATTRIBUTION_FIELDS.every((c) => schemaSql.includes(c)))
const one = q("SELECT intent, confidence, kb_hits, source_refs, provider, latency_ms FROM messages WHERE id = 'm_cv1_a1'")[0]
check("归因六个字段都读得回值", one && one.provider === "codebuddy" && one.confidence === 0.6 && JSON.parse(one.kb_hits).length === 1,
  JSON.stringify(one))
check("kb_hits / source_refs 是合法 JSON 数组", (() => {
  try { return [one.kb_hits, one.source_refs].every((v) => Array.isArray(JSON.parse(v))) } catch { return false }
})())
check("provider 取值落在降级链枚举内", PROVIDERS.every((p) => typeof p === "string") && q("SELECT DISTINCT provider FROM messages").map((r) => r.provider).every((p) => PROVIDERS.includes(p)),
  JSON.stringify(q("SELECT DISTINCT provider FROM messages").map((r) => r.provider)))

console.log("== 六口径：SQL 结果 vs 逐行暴力扫描 ==")
// —— 暴力基准（纯 JS，不碰 SQL）——
const rated = SEED.filter((s) => s.feedback !== null)
const brute = {
  sessions_total: SEED.length,
  avg_satisfaction: rated.reduce((a, s) => a + s.feedback, 0) / rated.length,
  ended_no_handoff: rated.filter((s) => s.handed_off === 0).length,
  ended_total: rated.length,
  handed_off_count: SEED.filter((s) => s.handed_off === 1).length,
  first_response: (() => {
    const firsts = SEED.filter((s) => s.first_ms > 0).map((s) => s.first_ms)
    return firsts.reduce((a, b) => a + b, 0) / firsts.length
  })(),
}

check(`会话总数 SQL=${scalar(STATS_SQL.total)} 与暴力 ${brute.sessions_total} 相等`, scalar(STATS_SQL.total) === brute.sessions_total, String(scalar(STATS_SQL.total)))
const avgSql = Number(q(STATS_SQL.rated)[0].avg_score)
check(`平均满意度 SQL=${avgSql} 与暴力 ${brute.avg_satisfaction} 相等`, Math.abs(avgSql - brute.avg_satisfaction) < 1e-9, String(avgSql))
check(`有评价会话数=${q(STATS_SQL.rated)[0].n} 与暴力 ${brute.ended_total} 相等`, Number(q(STATS_SQL.rated)[0].n) === brute.ended_total)
check(`未转人工且已评价 SQL=${scalar(STATS_SQL.ended_no_handoff)} 与暴力 ${brute.ended_no_handoff} 相等`, scalar(STATS_SQL.ended_no_handoff) === brute.ended_no_handoff)
check(`转人工会话数 SQL=${scalar(STATS_SQL.handed_off)} 与暴力 ${brute.handed_off_count} 相等`, scalar(STATS_SQL.handed_off) === brute.handed_off_count)
const frSql = Number(q(STATS_SQL.first_response)[0].n)
check(`平均首响 SQL=${frSql} 与「每会话首条助手消息」暴力 ${brute.first_response} 相等`, Math.abs(frSql - brute.first_response) < 1e-9, String(frSql))
// 反向对照：若取的是「所有助手消息」的均值，答案会明显不同 ⇒ 上面那条不是恒真
const allMsgAvg = Number(q("SELECT AVG(latency_ms) AS n FROM messages WHERE role='assistant'")[0].n)
check("N1 反向对照：全助手消息均值 ≠ 首响均值（证明取的是首条而非全部）", Math.abs(allMsgAvg - frSql) > 1e-6, `全部=${allMsgAvg} 首响=${frSql}`)

console.log("== 意图/provider 分布 ==")
const intentSql = Object.fromEntries(q(STATS_SQL.intent_distribution).map((r) => [r.intent, Number(r.n)]))
const intentBrute = SEED.reduce((acc, s) => { acc[s.intent] = (acc[s.intent] || 0) + 1; return acc }, {})
// 分布类比较按**键值内容**比，不比顺序：SQL 的 ORDER BY 对同票数的键没有确定性，
// 拿顺序当相等条件会把「顺序不同」误报成「数字错了」——别让不稳定排序制造假红。
check("意图分布 SQL 与暴力相等（按键值比，不比顺序）",
  Object.keys(intentBrute).every((k) => intentSql[k] === intentBrute[k]) && Object.keys(intentSql).length === Object.keys(intentBrute).length,
  `${JSON.stringify(intentSql)} vs ${JSON.stringify(intentBrute)}`)
const provSql = Object.fromEntries(q(STATS_SQL.provider_distribution).map((r) => [r.provider, Number(r.n)]))
const provBrute = SEED.reduce((acc, s) => { acc[s.provider] = (acc[s.provider] || 0) + 2; return acc }, {}) // 每会话 2 条助手消息
check("provider 分布 SQL 与暴力相等（每会话 2 条助手消息，按键值比）",
  Object.keys(provBrute).every((k) => provSql[k] === provBrute[k]) && Object.keys(provSql).length === Object.keys(provBrute).length,
  `${JSON.stringify(provSql)} vs ${JSON.stringify(provBrute)}`)

console.log("== 低分清单 ==")
const low = q(STATS_SQL.low_scores).map((r) => r.conversation_id)
const lowBrute = SEED.filter((s) => s.feedback !== null && s.feedback <= 2).map((s) => s.id)
check(`≤2 分会话 SQL=${JSON.stringify(low)} 与暴力 ${JSON.stringify(lowBrute)} 相等`,
  JSON.stringify(low.slice().sort()) === JSON.stringify(lowBrute.slice().sort()), JSON.stringify(low))

console.log("== 满意度分布 / 平均轮次 / 工单原因分布 ==")
// 位置纪律：本段必须在下面「口径边界」变异段**之前**——那一段会插入会话与评分，
// 放在它后面算出来的期望值就与库里的实际行数不符（r96 首跑 3 条假红即此成因）。
const scoreDist = Object.fromEntries(q(STATS_SQL.score_distribution).map((r) => [r.score, Number(r.n)]))
const scoreBrute = SEED.filter((s) => s.feedback !== null).reduce((a, s) => { a[s.feedback] = (a[s.feedback] || 0) + 1; return a }, {})
check("满意度分布 SQL 与暴力相等（按键值比）",
  Object.keys(scoreBrute).every((k) => scoreDist[k] === scoreBrute[k]) && Object.keys(scoreDist).length === Object.keys(scoreBrute).length,
  `${JSON.stringify(scoreDist)} vs ${JSON.stringify(scoreBrute)}`)
check("满意度分布之和 == 有评价会话数（分布与分母必须自洽）",
  Object.values(scoreDist).reduce((a, b) => a + b, 0) === brute.ended_total, `${JSON.stringify(scoreDist)}`)
const turnsSql = Number(q(STATS_SQL.avg_turns)[0].n)
check(`平均轮次 SQL=${turnsSql} 与暴力 2 相等（每会话 turn_count=2）`, turnsSql === 2, String(turnsSql))
const reasonsSql = Object.fromEntries(q(STATS_SQL.handoff_reasons).map((r) => [r.reason_code, Number(r.n)]))
const reasonsBrute = SEED.filter((s) => s.handed_off).reduce((a, s) => { a[s.reason_code] = (a[s.reason_code] || 0) + 1; return a }, {})
check("工单原因分布 SQL 与暴力相等", JSON.stringify(reasonsSql) === JSON.stringify(reasonsBrute), `${JSON.stringify(reasonsSql)} vs ${JSON.stringify(reasonsBrute)}`)
check("工单总数 == 转人工会话数（两套数字不许互相矛盾）",
  Object.values(reasonsSql).reduce((a, b) => a + b, 0) === brute.handed_off_count)

console.log("== 口径边界：未评价 ≠ 0 分 ==")
const beforeAvg = Number(q(STATS_SQL.rated)[0].avg_score)
const beforeEnded = Number(q(STATS_SQL.rated)[0].n)
db.prepare("INSERT INTO conversations (id, created_at, updated_at, turn_count, handed_off) VALUES (?,?,?,?,?)").run("cv9_new_unrated", "2026-10-04T00:10:00.000Z", "2026-10-04T00:10:00.000Z", 1, 0)
const afterAvg = Number(q(STATS_SQL.rated)[0].avg_score)
const afterEnded = Number(q(STATS_SQL.rated)[0].n)
check("新增未评价会话 ⇒ 会话总数 +1", scalar(STATS_SQL.total) === brute.sessions_total + 1, String(scalar(STATS_SQL.total)))
check("新增未评价会话 ⇒ 平均满意度**分毫不变**（未评价不被当成 0 分）", afterAvg === beforeAvg && afterEnded === beforeEnded,
  `avg ${beforeAvg}→${afterAvg} / 分母 ${beforeEnded}→${afterEnded}`)
// 反向对照：真的补一个 1 分，平均必须变化 —— 否则上面那条可能因为「分母取错」而恒真
db.prepare("INSERT INTO feedback (id, conversation_id, score, tag, comment, created_at) VALUES (?,?,?,?,?,?)").run("fb_cv9", "cv9_new_unrated", 1, "", "", "2026-10-04T00:11:00.000Z")
check("N2 反向对照：补一个 1 分后平均满意度确实下降（证明分母真的在动）",
  Number(q(STATS_SQL.rated)[0].avg_score) < beforeAvg, `原 ${beforeAvg} → ${Number(q(STATS_SQL.rated)[0].avg_score)}`)

console.log("== 拒绝 N+1（查询次数恒定） ==")
check(`STATS_SQL 条目数 ${Object.keys(STATS_SQL).length} 与声明的 STATS_QUERY_COUNT=${STATS_QUERY_COUNT} 一致`, Object.keys(STATS_SQL).length === STATS_QUERY_COUNT)
const storeSrc = readFileSync(REPO + "frontend/functions/lib/chat_store.js", "utf8")
const statsBody = String(/export async function getStats[\s\S]*?\n}/.exec(storeSrc)?.[0] || "")
check("getStats 体内 prepare 调用全部走 STATS_SQL 常量（没有额外 SQL 字面量）",
  !/prepare\(\s*["'`]SELECT/i.test(statsBody.replace(/STATS_SQL\.\w+/g, "")), "存在裸 SQL 字面量意味着查询数会随改动漂移")
check("getStats 体内无循环结构（for/while/map 里套 await 即 N+1）", !/\bfor\s*\(|\bwhile\s*\(/.test(statsBody))
check("ENDED_PROXY_NOTE 明示了「已结束」是代理口径", String(ENDED_PROXY_NOTE).includes("代理"), ENDED_PROXY_NOTE)

console.log(`\nSTATS RECONCILE GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
