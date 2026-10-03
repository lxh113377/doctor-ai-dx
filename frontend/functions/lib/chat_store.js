// D1 持久化门面：会话 / 消息 / 意图事件 / 转挂 / 反馈。
//
// 三条硬纪律：
// 1. **写入前必经 pii.js**：本模块是唯一写入口，脱敏在门内做，调用方无法绕过。
// 2. **D1 未绑定时不假装成功**：本地 wrangler dev 与 CI 常常没有 DB 绑定，此时返回
//    { persisted:false, reason }，由上层如实回报，绝不假装已保存。
// 3. **绑定名集中一处**：DB_BINDING 改名字只需动这里，避免散落各处。
import { redactPii } from "./pii.js"

export const DB_BINDING = "DB"
export const SCHEMA_VERSION = 3

/**
 * 消息行归因口径（r96）。每条助手回复必须能回答三个问题：
 *   谁给的（provider）｜为什么这么答（intent/confidence/kb_hits/source_refs）｜花了多久（latency_ms）。
 * 没有它们，后台看到的低分只是「不满意」三个字，永远归因不到 provider 或延迟。
 */
export const ATTRIBUTION_FIELDS = Object.freeze([
  "intent", "confidence", "kb_hits", "source_refs", "provider", "latency_ms",
])
/** provider 枚举：与面3 providers.ts 的降级链同口径，四方缺一即不完整。 */
export const PROVIDERS = Object.freeze(["codebuddy", "llm", "rule", "fallback"])

function normalizeAttribution(a) {
  const src = a || {}
  const provider = PROVIDERS.includes(src.provider) ? src.provider : "rule"
  const latency = Number.isFinite(Number(src.latency_ms)) && Number(src.latency_ms) >= 0 ? Math.round(Number(src.latency_ms)) : 0
  const jsonArr = (v) => {
    try {
      const parsed = Array.isArray(v) ? v : JSON.parse(String(v || "[]"))
      return JSON.stringify(Array.isArray(parsed) ? parsed.slice(0, 12) : [])
    } catch {
      return "[]"
    }
  }
  return {
    intent: String(src.intent || "general_medical").slice(0, 40),
    confidence: Math.max(0, Math.min(1, Number(src.confidence) || 0)),
    kb_hits: jsonArr(src.kb_hits),
    source_refs: jsonArr(src.source_refs),
    provider,
    latency_ms: latency,
  }
}

/** 会话保留期（天，r91 S10）：写入时算 expires_at，到期由 scripts/d1_cleanup.mjs 清理。
 *  演示数据全经 pii.js 脱敏，保留期只控存储量级，不是隐私兜底。 */
export const RETENTION_DAYS = 180

/** D1 是否可用。不可用时所有写操作走 no-op 分支并给出可归因原因。 */
export function d1Available(env = {}) {
  const db = env?.[DB_BINDING]
  return !!(db && typeof db.prepare === "function")
}

function unavailable(reason = "D1 未绑定") {
  return { persisted: false, reason }
}

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix) {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 建会话（幂等：已存在则不覆盖 created_at）。 */
export async function ensureConversation(env, conversationId) {
  if (!d1Available(env)) return unavailable()
  const id = conversationId || newId("cv")
  await env[DB_BINDING]
    .prepare("INSERT OR IGNORE INTO conversations (id, created_at, updated_at, turn_count, handed_off) VALUES (?, ?, ?, 0, 0)")
    .bind(id, nowIso(), nowIso())
    .run()
  return { persisted: true, conversation_id: id }
}

/**
 * 追加一条消息。**content 在此脱敏**，hits 一并存库（只存类型与计数，不存原值）。
 */
export async function appendMessage(env, { conversation_id, role, content, red_flag = 0 }) {
  if (!d1Available(env)) return unavailable()
  const clean = redactPii(content)
  await env[DB_BINDING]
    .prepare("INSERT INTO messages (id, conversation_id, role, content, redacted_hits, red_flag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(
      newId("msg"),
      conversation_id,
      role === "assistant" ? "assistant" : "user",
      clean.text,
      JSON.stringify(clean.hits),
      red_flag ? 1 : 0,
      nowIso(),
    )
    .run()
  return { persisted: true, redacted_hits: clean.hits }
}

/** 记录一次意图判定，供后台按意图分布统计与回溯。 */
export async function recordIntentEvent(env, { conversation_id, intent, confidence, matched = [] }) {
  if (!d1Available(env)) return unavailable()
  await env[DB_BINDING]
    .prepare("INSERT INTO intent_events (id, conversation_id, intent, confidence, matched, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("ev"), conversation_id, intent, Number(confidence) || 0, JSON.stringify(matched.slice(0, 12)), nowIso())
    .run()
  return { persisted: true }
}

/** 记录转人工事件。reason_code 必填——后台要按原因聚合，没有它就没法分派。 */
export async function recordHandoff(env, { conversation_id, reason_code, reason_text, context_digest = "" }) {
  if (!d1Available(env)) return unavailable()
  if (!reason_code) return { persisted: false, reason: "handoff 缺 reason_code，拒绝写入" }
  const id = newId("ho")
  await env[DB_BINDING]
    .prepare("INSERT INTO handoffs (id, conversation_id, reason_code, reason_text, context_digest, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, conversation_id, reason_code, String(reason_text || "").slice(0, 200), String(context_digest || "").slice(0, 120), "open", nowIso())
    .run()
  await env[DB_BINDING]
    .prepare("UPDATE conversations SET handed_off = 1, updated_at = ? WHERE id = ?")
    .bind(nowIso(), conversation_id)
    .run()
  return { persisted: true, handoff_id: id }
}

/** 满意度打分的纯校验（抽成函数才能在没有 D1 的环境里被守卫断言，见 d1_persist_guard.mjs）。 */
export function isValidScore(score) {
  const n = Number(score)
  return Number.isInteger(n) && n >= 1 && n <= 5
}

/** 满意度打分：1..5，越界直接拒绝（不静默截断——静默截断会让统计失真而没人发现）。 */
export async function setFeedback(env, { conversation_id, score, tag = "", comment = "" }) {
  if (!isValidScore(score)) return { persisted: false, reason: "score 必须是 1..5 的整数" }
  if (!d1Available(env)) return unavailable()
  const n = Number(score)
  await env[DB_BINDING]
    .prepare("INSERT OR REPLACE INTO feedback (id, conversation_id, score, tag, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("fb"), conversation_id, n, String(tag || "").slice(0, 40), redactPii(comment).text.slice(0, 200), nowIso())
    .run()
  await env[DB_BINDING]
    .prepare("UPDATE conversations SET satisfaction = ?, updated_at = ? WHERE id = ?")
    .bind(n, nowIso(), conversation_id)
    .run()
  return { persisted: true }
}

/** 轮次 +1（每次用户发言记一次，便于统计平均轮次）。 */
export async function bumpTurn(env, conversation_id) {
  if (!d1Available(env)) return unavailable()
  await env[DB_BINDING]
    .prepare("UPDATE conversations SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?")
    .bind(nowIso(), conversation_id)
    .run()
  return { persisted: true }
}

/**
 * 一回合批量落库（r91，S4）：把「建会话 + 两条消息 + 意图事件 + （可选）转人工 + 轮次+1」
 * 从逐条 .run()（最多 6 次串行往返）合并为**单次 .batch()**。D1 的 batch 是隐式事务——
 * 要么整回合落库、要么整回合不落，顺带消除了「用户消息存了、助手回复没存」的半回合脏态。
 * handoff 给出时由这里生成真实工单 id（ho_ 前缀）并随返回值带回，供后台 PATCH 直接使用。
 */
export async function persistTurnBatch(env, { conversation_id, user_text, assistant_text, red_flag = 0, intent, confidence, matched = [], handoff = null, attribution = null }) {
  if (!d1Available(env)) return unavailable()
  const cid = conversation_id || newId("cv")
  const ts = nowIso()
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString()
  const cleanUser = redactPii(String(user_text || ""))
  const cleanAsst = redactPii(String(assistant_text || ""))
  // 归因字段只挂在**助手**消息上：用户消息没有 provider/latency 可言，给它们填 0 会污染首响均值。
  const attr = normalizeAttribution(attribution)
  const MSG_COLS = "id, conversation_id, role, content, redacted_hits, red_flag, intent, confidence, kb_hits, source_refs, provider, latency_ms, created_at"
  const statements = [
    env[DB_BINDING]
      .prepare("INSERT OR IGNORE INTO conversations (id, created_at, updated_at, turn_count, handed_off, expires_at) VALUES (?, ?, ?, 0, 0, ?)")
      .bind(cid, ts, ts, expiresAt),
    env[DB_BINDING]
      .prepare(`INSERT INTO messages (${MSG_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId("msg"), cid, "user", cleanUser.text, JSON.stringify(cleanUser.hits), 0, attr.intent, attr.confidence, "[]", "[]", attr.provider, 0, ts),
    env[DB_BINDING]
      .prepare(`INSERT INTO messages (${MSG_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId("msg"), cid, "assistant", cleanAsst.text, JSON.stringify(cleanAsst.hits), red_flag ? 1 : 0,
        attr.intent, attr.confidence, attr.kb_hits, attr.source_refs, attr.provider, attr.latency_ms, ts),
    env[DB_BINDING]
      .prepare("INSERT INTO intent_events (id, conversation_id, intent, confidence, matched, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("ev"), cid, intent, Number(confidence) || 0, JSON.stringify((matched || []).slice(0, 12)), ts),
    env[DB_BINDING]
      .prepare("UPDATE conversations SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?")
      .bind(ts, cid),
  ]
  let handoff_id = null
  if (handoff) {
    handoff_id = newId("ho")
    statements.push(
      env[DB_BINDING]
        .prepare("INSERT INTO handoffs (id, conversation_id, reason_code, reason_text, context_digest, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(handoff_id, cid, handoff.reason_code, String(handoff.reason_text || "").slice(0, 200), String(handoff.context_digest || "").slice(0, 120), "open", ts),
      env[DB_BINDING]
        .prepare("UPDATE conversations SET handed_off = 1, updated_at = ? WHERE id = ?")
        .bind(ts, cid),
    )
  }
  await env[DB_BINDING].batch(statements)
  return { persisted: true, conversation_id: cid, handoff_id }
}
// —— 以下为只读查询面（后台用）。读写同文件但分区：后台的查询口径（统计怎么算、列表怎么排）
// 需要独立演进，改它不该碰到写入路径。d1Available / DB_BINDING / redactPii 已在写面声明，此处直接复用。

const MAX_LIMIT = 100

function clampLimit(limit) {
  const n = Number(limit)
  if (!Number.isInteger(n) || n < 1) return 20
  return Math.min(MAX_LIMIT, n)
}

function clampOffset(offset) {
  const n = Number(offset)
  return Number.isInteger(n) && n > 0 ? n : 0
}

async function all(env, sql, ...params) {
  const { results } = await env[DB_BINDING].prepare(sql).bind(...params).all()
  return results || []
}

/** 会话列表：按更新时间倒序。返回体只含脱敏后的首条摘要。 */
export async function listConversations(env, { limit, offset } = {}) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定", items: [] }
  const rows = await all(
    env,
    "SELECT id, created_at, updated_at, turn_count, handed_off, satisfaction FROM conversations ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    clampLimit(limit),
    clampOffset(offset),
  )
  return { available: true, items: rows }
}

/** 会话详情：消息 + 意图事件 + 转挂 + 反馈。内容再脱敏一次（ defense in depth：写时已脱敏，读时再脱一次）。 */
export async function getConversationDetail(env, conversationId) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定" }
  const conversations = await all(env, "SELECT * FROM conversations WHERE id = ?", conversationId)
  if (conversations.length === 0) return { available: true, found: false }
  // 归因六列随详情返回：回放页要逐条显示「这条是谁答的、依据哪几条知识、花了多久」。
  const messages = await all(
    env,
    "SELECT role, content, red_flag, created_at, intent, confidence, kb_hits, source_refs, provider, latency_ms FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    conversationId,
  )
  const intent_events = await all(env, "SELECT intent, confidence, matched, created_at FROM intent_events WHERE conversation_id = ? ORDER BY created_at ASC", conversationId)
  const handoffs = await all(env, "SELECT reason_code, reason_text, status, created_at FROM handoffs WHERE conversation_id = ? ORDER BY created_at ASC", conversationId)
  const feedback = await all(env, "SELECT score, tag, created_at FROM feedback WHERE conversation_id = ?", conversationId)
  return {
    available: true,
    found: true,
    conversation: conversations[0],
    messages: messages.map((m) => ({ ...m, content: redactPii(m.content).text })),
    intent_events,
    handoffs,
    feedback: feedback[0] || null,
  }
}

/** 转人工队列：待处理在前，按创建时间升序（先到先处理）。 */
export async function listHandoffs(env, { limit } = {}) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定", items: [] }
  const rows = await all(
    env,
    "SELECT id, conversation_id, reason_code, reason_text, status, created_at FROM handoffs ORDER BY (status = 'open') DESC, created_at ASC LIMIT ?",
    clampLimit(limit),
  )
  return { available: true, items: rows }
}

/**
 * 后台六口径满意度统计（r96）。
 *
 * 三条口径纪律（违反任一条，看板上的数字就不可信）：
 * ① 每个数字必须携带**分母**——写不清分母的指标等于谣言，评审一问就塌；
 * ② 未评价 ≠ 0 分 ⇒ 没 feedback 行的会话**不进**平均满意度的分子也不进分母；
 * ③ 查询次数与会话数无关（固定 6 条 SQL），禁止 N+1：列表每多一行就多一次查询是不可接受的形状。
 *
 * 「已结束」的代理口径：conversations 表目前没有 closed_at（schema v3 未引入），
 * 以「存在 feedback 行」视为该会话已评价并结束；这是**显式声明的代理**，不是巧合，
 * 一旦后续引入 conversations.closed_at，本处的分母口径必须随之改写并在守卫里同步。
 */
export const ENDED_PROXY_NOTE = "已结束＝存在 feedback 行（conversations 无 closed_at，此为显式代理口径）"

/**
 * 统计 SQL 单一源（r96）：抽成常量是为了让 `stats_reconcile_guard.mjs` 能在 `node:sqlite`
 * 里**执行同一批字符串**与暴力扫描的结果对账。若 SQL 写回 getStats 里，对账只能靠正则匹配，
 * 而正则对账恰恰是本仓已经付过学费的假通过形态（#222 注册≠接线）。
 */
export const STATS_SQL = Object.freeze({
  total: "SELECT COUNT(*) AS n FROM conversations",
  rated: "SELECT COUNT(*) AS n, AVG(score) AS avg_score FROM feedback",
  ended_no_handoff: "SELECT COUNT(*) AS n FROM conversations c JOIN feedback f ON f.conversation_id = c.id WHERE c.handed_off = 0",
  handed_off: "SELECT COUNT(*) AS n FROM conversations WHERE handed_off = 1",
  // 平均首响：每个会话取**按发送时间排序的第一条助手消息**的 latency_ms 再求均值。
  // 2026-10-04 被 stats_reconcile_guard 抓到的一版错误写法：`MIN(latency_ms) WHERE latency_ms>0`
  // ——它会把「首条延迟为 0（未计量）」的会话算成它**第二条**消息的延迟，且过滤痕在取最小值之前，
  // 于是「没计量」被静默替换成「后来那条很慢」，平均值被抬高。
  // 正解：先按 created_at 定首条，再对 latency_ms=0（未计量）的行整体剔除。
  first_response: "SELECT AVG(t.first_ms) AS n FROM (SELECT m.latency_ms AS first_ms FROM messages m WHERE m.role = 'assistant' AND m.created_at = (SELECT MIN(m2.created_at) FROM messages m2 WHERE m2.conversation_id = m.conversation_id AND m2.role = 'assistant')) t WHERE t.first_ms > 0",
  intent_distribution: "SELECT intent, COUNT(*) AS n FROM intent_events GROUP BY intent ORDER BY n DESC",
  provider_distribution: "SELECT provider, COUNT(*) AS n, AVG(latency_ms) AS avg_ms FROM messages WHERE role = 'assistant' GROUP BY provider ORDER BY n DESC",
  low_scores: "SELECT conversation_id, score, created_at FROM feedback WHERE score <= 2 ORDER BY created_at DESC LIMIT 20",
  avg_turns: "SELECT AVG(turn_count) AS n FROM conversations",
  handoff_reasons: "SELECT reason_code, COUNT(*) AS n FROM handoffs GROUP BY reason_code ORDER BY n DESC",
  score_distribution: "SELECT score, COUNT(*) AS n FROM feedback GROUP BY score ORDER BY score ASC",
})

/** 十一条 SQL：**次数恒定，与会话数无关**，这是拒绝 N+1 的可断言事实。 */
export const STATS_QUERY_COUNT = 11

export async function getStats(env) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定", metrics: null }
  const one = async (sql, ...params) => (await all(env, sql, ...params))[0] || {}
  const row = (name, value, denominator, note, sql) => ({
    value: Number.isFinite(Number(value)) ? Number(value) : 0,
    denominator: Number(denominator) || 0,
    denominator_note: note,
    recompute_sql: sql,
  })

  const [total, rated, endedNoHandoff, firstResp, handedOff, lowScores, avgTurns, reasons, scoreDist] = await Promise.all([
    one(STATS_SQL.total),
    one(STATS_SQL.rated),
    one(STATS_SQL.ended_no_handoff),
    one(STATS_SQL.first_response),
    one(STATS_SQL.handed_off),
    all(env, STATS_SQL.low_scores),
    one(STATS_SQL.avg_turns),
    all(env, STATS_SQL.handoff_reasons),
    all(env, STATS_SQL.score_distribution),
  ])

  const intentRows = await all(env, STATS_SQL.intent_distribution)
  const providerRows = await all(env, STATS_SQL.provider_distribution)

  const ended = rated.n || 0
  return {
    available: true,
    ended_proxy_note: ENDED_PROXY_NOTE,
    metrics: {
      sessions_total: row("sessions_total", total.n, total.n, "全部会话行", STATS_SQL.total),
      avg_satisfaction: row(
        "avg_satisfaction",
        Number(rated.avg_score || 0).toFixed(2),
        ended,
        "分母＝有 feedback 行的会话数；未评价不计入（未评价 ≠ 0 分）",
        STATS_SQL.rated,
      ),
      first_contact_resolution: row(
        "first_contact_resolution",
        ended ? Number(endedNoHandoff.n / ended).toFixed(4) : 0,
        ended,
        `未触发转人工且已评价的会话 / 已评价会话（${ENDED_PROXY_NOTE}）`,
        STATS_SQL.ended_no_handoff,
      ),
      handoff_rate: row(
        "handoff_rate",
        total.n ? Number(handedOff.n / total.n).toFixed(4) : 0,
        total.n,
        "触发过工单的会话 / 全部会话",
        STATS_SQL.handed_off,
      ),
      avg_first_response_ms: row(
        "avg_first_response_ms",
        Math.round(Number(firstResp.n || 0)),
        ended,
        "各会话首条助手消息的 AVG(latency_ms)；latency_ms=0 的行不参与",
        STATS_SQL.first_response,
      ),
      intent_distribution: intentRows.map((r) => ({ intent: r.intent, count: r.n })),
      provider_distribution: providerRows.map((r) => ({ provider: r.provider, count: r.n, avg_latency_ms: Math.round(r.avg_ms || 0) })),
      handoff_reasons: reasons.map((r) => ({ reason_code: r.reason_code, n: r.n })),
      score_distribution: scoreDist.map((r) => ({ score: r.score, n: r.n })),
      avg_turns: row("avg_turns", Number(avgTurns.n || 0).toFixed(2), total.n, "全部会话的 AVG(turn_count)", STATS_SQL.avg_turns),
      low_score_sessions: lowScores.map((r) => ({ conversation_id: r.conversation_id, score: r.score, created_at: r.created_at })),
    },
  }
}

/** 工单合法状态集（与 d1_schema.sql 的 CHECK 同源口径；schema 加状态必须同步这里与守卫）。 */
export const HANDOFF_STATUSES = Object.freeze(["open", "assigned", "closed"])

/**
 * 工单状态机（r91，S3）：合法迁移表的唯一真相源，守卫按它断言。
 * open→assigned（坐席接单）/ open→closed（直接关闭）/ assigned→closed（处理完关闭）；
 * closed 是终态，任何回退与重放都拒绝——「关闭了的工单又被悄悄改回 open」比没有状态机更糟。
 */
const HANDOFF_TRANSITIONS = Object.freeze({
  open: Object.freeze(["assigned", "closed"]),
  assigned: Object.freeze(["closed"]),
  closed: Object.freeze([]),
})

export function canTransitionHandoff(from, to) {
  return (HANDOFF_TRANSITIONS[from] || []).includes(to)
}

/**
 * 指派/关闭转人工工单（补齐 r90 缺口「判定齐了，接管没人」）。
 * 返回 {ok, code, ...}：422 非法目标态或**关闭时缺少满意度评分** / 503 存储不可用 / 404 不存在 / 409 非法迁移。
 *
 * r96：**关闭工单必须同时回收满意度**（三件套之一）。
 * 为什么强制：愿意走完工单流程的用户本来就是少数，若关闭不收评分，评分样本会系统性偏向
 * 「没出问题也没被问」的那一批 ⇒ 满意度看上去很高，实则是有偏样本。这与「未评价 ≠ 0 分」
 * 是同一件事的两面：一边不许把沉默当 0 分，另一边要保证真正想评价的人不被漏掉。
 * 收不到评分时的正确处理是拒绝关闭（422）而不是静默关闭——静默关闭=丢失一次回收机会且无人察觉。
 */
export async function updateHandoffStatus(env, { id, status, score = null, tag = "", comment = "" }) {
  if (!HANDOFF_STATUSES.includes(status) || status === "open") {
    return { ok: false, code: 422, reason: "status 必须是 assigned 或 closed（open 是初始态，不可回设）" }
  }
  if (!d1Available(env)) return { ok: false, code: 503, reason: "转人工工单存储不可用，请稍后重试" }
  const rows = await all(env, "SELECT id, conversation_id, status FROM handoffs WHERE id = ?", id)
  const row = rows[0]
  if (!row) return { ok: false, code: 404, reason: "工单不存在" }
  if (!canTransitionHandoff(row.status, status)) {
    return { ok: false, code: 409, reason: `非法状态迁移 ${row.status} -> ${status}` }
  }
  // 顺序说明：状态合法性(422) → 存储可用(503) → 存在性(404) → 迁移合法(409) → 评分要求(422)。
  // 评分要求**必须排在存在性之后**——r96 初版把它放在最前面，结果 admin_auth_guard 的
  // 「工单不存在 ⇒ 404」被错报成 422：参数缺失把「对象不存在」盖住了。
  // 顺序不是风格问题：404 与 422 对调用方的处理路径完全不同（重试 vs 补参数）。
  const wantsClose = status === "closed"
  if (wantsClose && !isValidScore(score)) {
    return { ok: false, code: 422, reason: "关闭工单必须同时回收满意度评分（score 为 1..5 整数）", requires_score: true }
  }
  if (!wantsClose) {
    await env[DB_BINDING].prepare("UPDATE handoffs SET status = ? WHERE id = ?").bind(status, id).run()
    return { ok: true, id, status, feedback_collected: false }
  }
  // 关闭 + 评分在同一个 batch 里：要么「关闭且收到评分」，要么两者都不发生——
  // 分两次写会出现「工单已关闭但评分丢了」的半完成态，而后者是不可观测的（没人会去复核）。
  const ts = nowIso()
  const statements = [
    env[DB_BINDING].prepare("UPDATE handoffs SET status = ? WHERE id = ?").bind(status, id),
    env[DB_BINDING]
      .prepare("INSERT OR REPLACE INTO feedback (id, conversation_id, score, tag, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(newId("fb"), row.conversation_id, Number(score), String(tag || "").slice(0, 40), redactPii(String(comment || "")).text.slice(0, 200), ts),
    env[DB_BINDING]
      .prepare("UPDATE conversations SET satisfaction = ?, updated_at = ? WHERE id = ?")
      .bind(Number(score), ts, row.conversation_id),
  ]
  await env[DB_BINDING].batch(statements)
  return { ok: true, id, status, feedback_collected: true, conversation_id: row.conversation_id, score: Number(score) }
}

/**
 * 满意度统计（**r96 起为 getStats 的薄适配层**，零额外 SQL）。
 *
 * 为什么不再自己查一遍：r95 与 r96 之间存在两份口径不同的统计实现（这份没有分母、
 * 那份有分母），两份必然漂移——而漂移出来的数字没人发现，因为它们都会正常返回。
 * 现在口径只有 getStats 一处，这里只做字段名映射供旧调用方过渡。
 * avg_score 用 SQL AVG 而不是取回全量在 JS 里算——量级上去后一次性取全表会把 Worker 内存打爆。
 */
export async function satisfactionStats(env) {
  const s = await getStats(env)
  if (!s.available) return { available: false, reason: s.reason }
  const m = s.metrics
  return {
    available: true,
    conversations: m.sessions_total.value,
    handed_off: Math.round(m.handoff_rate.value * m.sessions_total.value),
    handoff_rate: m.handoff_rate.value,
    avg_turns: m.avg_turns.value,
    rated: m.avg_satisfaction.denominator,
    avg_score: m.avg_satisfaction.denominator > 0 ? m.avg_satisfaction.value : null,
    score_distribution: m.score_distribution,
    intent_distribution: m.intent_distribution.map((r) => ({ intent: r.intent, n: r.count })),
    handoff_reasons: m.handoff_reasons,
    metrics: m,
    ended_proxy_note: s.ended_proxy_note,
  }
}

/** Top 未解决问题：取转人工原因 × 意图的交叉，供知识库维护闭环使用（见 docs/KNOWLEDGE_MAINTENANCE.md）。 */
export async function topUnresolved(env, limit = 10) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定", items: [] }
  const rows = await all(
    env,
    "SELECT h.reason_code AS reason_code, e.intent AS intent, COUNT(*) AS n FROM handoffs h LEFT JOIN intent_events e ON e.conversation_id = h.conversation_id GROUP BY h.reason_code, e.intent ORDER BY n DESC LIMIT ?",
    clampLimit(limit),
  )
  return { available: true, items: rows }
}