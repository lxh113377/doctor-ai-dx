// D1 持久化门面：会话 / 消息 / 意图事件 / 转挂 / 反馈。
//
// 三条硬纪律：
// 1. **写入前必经 pii.js**：本模块是唯一写入口，脱敏在门内做，调用方无法绕过。
// 2. **D1 未绑定时不假装成功**：本地 wrangler dev 与 CI 常常没有 DB 绑定，此时返回
//    { persisted:false, reason }，由上层如实回报，绝不假装已保存。
// 3. **绑定名集中一处**：DB_BINDING 改名字只需动这里，避免散落各处。
import { redactPii } from "./pii.js"

export const DB_BINDING = "DB"
export const SCHEMA_VERSION = 1

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
  const messages = await all(env, "SELECT role, content, red_flag, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC", conversationId)
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
 * 满意度统计。
 * avg_score 用 SQL AVG 而不是取回全量在 JS 里算——量级上去后一次性取全表会把 Worker 内存打爆，
 * 而这是最容易被忽略的一处性能陷阱。
 */
export async function satisfactionStats(env) {
  if (!d1Available(env)) return { available: false, reason: "D1 未绑定" }
  const agg = await all(
    env,
    "SELECT COUNT(*) AS conversations, SUM(handed_off) AS handed_off, AVG(turn_count) AS avg_turns FROM conversations",
  )
  const fb = await all(env, "SELECT COUNT(*) AS rated, AVG(score) AS avg_score FROM feedback")
  const dist = await all(env, "SELECT score, COUNT(*) AS n FROM feedback GROUP BY score ORDER BY score ASC")
  const intents = await all(env, "SELECT intent, COUNT(*) AS n FROM intent_events GROUP BY intent ORDER BY n DESC")
  const reasons = await all(env, "SELECT reason_code, COUNT(*) AS n FROM handoffs GROUP BY reason_code ORDER BY n DESC")
  const total = agg[0]?.conversations || 0
  const handed = agg[0]?.handed_off || 0
  return {
    available: true,
    conversations: total,
    handed_off: handed,
    handoff_rate: total > 0 ? Math.round((handed / total) * 1000) / 1000 : 0,
    avg_turns: agg[0]?.avg_turns != null ? Math.round(agg[0].avg_turns * 100) / 100 : 0,
    rated: fb[0]?.rated || 0,
    avg_score: fb[0]?.avg_score != null ? Math.round(fb[0].avg_score * 100) / 100 : null,
    score_distribution: dist,
    intent_distribution: intents,
    handoff_reasons: reasons,
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