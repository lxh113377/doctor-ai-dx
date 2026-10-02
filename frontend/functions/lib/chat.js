// /api/chat 编排器：把「红旗闸门 → 意图 → FAQ → 转人工 → 脱敏落库」串成一条确定性链。
//
// 这个面**从不调用大模型**：意图、弃权、是否转人工、回答措辞全部是确定性代码产出。
// 表达层（Agent SDK）在面3 agent-service，见 docs/ARCHITECTURE.md 的三面职责矩阵。
// 这样做有两个好处：一是客服三类与红旗路径的输出可复算、可审计；二是模型不可用时
// 对话面依然完整可用（失败安全降级），不需要为「没网/没Key」写第二套流程。
//
// 顺序即红线：scanFlags 在 detectIntent() 入口第一步执行，命中即短路，后面什么都不跑。
import { detectIntent, shouldRetrieveFaq, RED_FLAG_INTENT } from "./intent.js"
import { decideHandoff } from "./handoff.js"
import { buildFaqAnswer } from "./faq.js"
import { synthesize, SLOT_ASK_TEXT } from "./chat_synth.js"
import { replyPolicyOf } from "./intent.js"
import * as store from "./chat_store.js"
import { APP_VERSION } from "./version.js"

/** 对话轮次上限：与 limits.js 的 MAX_HISTORY_ITEMS=64 同族口径。**这是入站护栏，不是容量声明。 */
export const CHAT_MAX_TURNS = 32

/** 槽位判定用的标识符形态：6 位以上数字串（挂号号/订单号/报告编号）或「号：xxx」显式写法。 */
const SLOT_RE = /(\d{6,})|(?:编号|号码|单号|号)\s*[:：]?\s*[A-Za-z0-9-]{4,}/

/** 只有查询/退费两类需要槽位；技术支持与医疗问诊不适用。 */
const SLOT_REQUIRED_POLICIES = new Set(["service_refund", "service_order_query"])

function countExchanges(history) {
  return Math.floor((Array.isArray(history) ? history.length : 0) / 2)
}

function hasSlot(text, history) {
  if (SLOT_RE.test(String(text || ""))) return true
  const prior = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.role === "user")
    .map((h) => String(h.content || ""))
  return prior.some((s) => SLOT_RE.test(s))
}

/**
 * 主入口。返回 { data } —— 由路由层包进既有信封 { code:0, data }。
 * 抛错一律用 limits.js 的 RequestBadShape 系列（422），沿用既有故障编号口径。
 */
export async function handleChat({ text, history = [], conversation_id = null, env = {} }) {
  const raw = String(text ?? "").trim()
  if (!raw) {
    const { RequestBadShape, BAD_SHAPE_MESSAGE } = await import("./limits.js")
    throw new RequestBadShape(BAD_SHAPE_MESSAGE)
  }
  if (raw.length > 2000) {
    const { RequestBadShape, BAD_SHAPE_MESSAGE } = await import("./limits.js")
    throw new RequestBadShape(BAD_SHAPE_MESSAGE)
  }
  const turns = countExchanges(history)
  if (turns > CHAT_MAX_TURNS) {
    const { RequestTooLarge, TOO_LARGE_MESSAGE } = await import("./limits.js")
    throw new RequestTooLarge(TOO_LARGE_MESSAGE)
  }

  // ---- 1. 意图（红旗闸门在 detectIntent 内部第一步）----
  const det = detectIntent(raw)

  // ---- 2. FAQ：只有医疗问诊类意图检索临床知识库 ----
  const faq = shouldRetrieveFaq(det.intent) ? buildFaqAnswer(raw, det.flags) : null

  // ---- 3. 转人工判定 ----
  const policy = replyPolicyOf(det.intent)
  const missingSlot = SLOT_REQUIRED_POLICIES.has(policy) && !hasSlot(raw, history)
  // S5：缺槽位首轮**追问一轮**（askedSlotBefore 靠 history 里上一条助手消息是否含追问话术识别，
  // 话术常量与生成处共用 SLOT_ASK_TEXT 单一源）；追问过仍缺 ⇒ 才升级 MISSING_SLOT 转人工。
  const lastAssistant = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.role === "assistant")
    .map((h) => String(h.content || ""))
    .pop()
  const askedSlotBefore = !!lastAssistant && lastAssistant.includes(SLOT_ASK_TEXT)
  const escalateSlot = missingSlot && askedSlotBefore
  const handoff = decideHandoff({
    intent: det.intent,
    confidence: det.confidence,
    flags: det.flags,
    need_human: det.need_human,
    unresolved_turns: turns,
    missing_slot: escalateSlot,
    abstain: faq ? faq.abstain : false,
  })

  // ---- 4. 确定性话术（面3 不可用时前端直接吃这段）----
  const answer = synthesize({
    intent: det.intent,
    flags: det.flags,
    handoff_reason_text: handoff.need_handoff ? handoff.reason_text : "",
    faq,
    slot_followup: missingSlot && !escalateSlot,
  })

  // ---- 5. 脱敏落库（D1 未绑定时如实回报 persisted:false）----
  // r91（S4）：一回合的全部写合并为单次 .batch()（隐式事务 + 消除串行往返），见 chat_store.persistTurnBatch。
  const turn = await store.persistTurnBatch(env, {
    conversation_id,
    user_text: raw,
    assistant_text: answer.text,
    red_flag: det.intent === RED_FLAG_INTENT ? 1 : 0,
    intent: det.intent,
    confidence: det.confidence,
    matched: det.matched,
    handoff: handoff.need_handoff
      ? { reason_code: handoff.reason_code, reason_text: handoff.reason_text, context_digest: handoff.context_digest }
      : null,
  })
  const cid = turn.persisted ? turn.conversation_id : conversation_id || null
  const persisted = !!turn.persisted
  const persist_reason = turn.persisted ? "" : turn.reason || "D1 未绑定"
  const realHandoffId = turn.handoff_id || null

  return {
    conversation_id: cid,
    intent: det.intent,
    confidence: det.confidence,
    answer: { text: answer.text, citations: answer.citations },
    red_flag: det.intent === RED_FLAG_INTENT && det.flags.length > 0
      ? { name: det.flags[0].name, severity: det.flags[0].severity, advice: det.flags[0].advice }
      : null,
    handoff: handoff.need_handoff
      ? {
          reason_code: handoff.reason_code,
          reason_text: handoff.reason_text,
          // 真实工单 id（落库时生成）优先——后台 PATCH /api/admin/handoffs/{id} 直接可用；
          // D1 未绑定时退回本地可读票号（仅展示用，不可用于后台操作）。
          ticket_id: realHandoffId || `HO-${(cid || "local").slice(-6)}-${handoff.reason_code}`,
        }
      : null,
    abstain: faq ? faq.abstain : false,
    // 本面永不调用模型 ⇒ mode 恒为 deterministic。Agent 表达在面3，medchat.ts 会另行标注。
    mode: "deterministic",
    answer_source: "deterministic",
    persisted,
    persist_reason: persist_reason,
    version: APP_VERSION,
  }
}