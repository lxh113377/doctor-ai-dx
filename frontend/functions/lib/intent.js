// 对话面意图识别器。
//
// 契约（本项目红线 1 的落点）：**红旗闸门在入口最前面**。scanFlagDetails() 命中即返回 intent="red_flag"，
// 绝不进入 refund / order_query / tech_support 任一客服分支——「退款说了一半突然胸痛」这类输入
// 必须是急诊提示，而不是退费流程话术。这条顺序不可协商，intents_guard.mjs 有反例判据守着。
//
// 权重口径：关键词越长越具体 ⇒ 权重越高（sqrt 收敛，避免长词碾压一切）。刻意不用词频，
// 因为客服短语里「退费」出现两次不代表比「退挂号费窗口」一次更可能是退费意图。
import { scanFlagDetails } from "./rules.js"
import { INTENTS, INTENT_BY_ID } from "./intents.js"
import { SYNONYMS } from "./knowledge.js"

/** 红旗意图不是注册表里的一类：它由规则层裁定，优先级高于整张表。 */
export const RED_FLAG_INTENT = "red_flag"
/** 三类客服意图（用户拍板的口径：退款/查询订单/技术支持 → 医疗语义映射）。 */
export const SERVICE_INTENT_IDS = Object.freeze(["refund", "order_query", "tech_support"])
/** 显式要人工的触发词。命中即高优先转人工，但它**不越过红旗闸门**。 */
export const HUMAN_ASK_TERMS = Object.freeze([
  "人工", "转人工", "客服", "真人", "人工服务", "找客服", "叫客服", "人工客服",
])

const MAX_TEXT = 2000

/** 置信度映射：命中越多越高，但永远到不了 1——「像」不等于「是」，残余不确定性交给 handoff 兜。 */
function toConfidence(score) {
  if (score <= 0) return 0
  return Math.round(Math.min(0.95, score / (score + 3)) * 1000) / 1000
}

function weightOf(keyword) {
  return Math.sqrt(String(keyword).length)
}

/**
 * 同义扩展（复用 knowledge.js 的 SYNONYMS 单一源，与 rag.js expandQuery 同形，不新增第二张词表）：
 * 口语变体命中某组 ⇒ 把组内其余词追加进扩展文本，让「心脏不舒服」也能落到「心悸」这组关键词上。
 * 只追加不替换：红旗闸门与否定词匹配仍吃原始文本（扩展发生在闸门之后），命中行为面零回归风险。
 */
function expandSynonyms(text) {
  let out = text
  for (const [canon, syns] of Object.entries(SYNONYMS)) {
    const forms = [canon, ...(Array.isArray(syns) ? syns : [])].map((w) => String(w).toLowerCase())
    if (!forms.some((f) => text.includes(f))) continue
    for (const w of forms) {
      if (!out.includes(w)) out += " " + w
    }
  }
  return out
}

/**
 * 在文本中找关键词命中。
 * 命中判定用「子串包含」而非分词：客服口语大量省略主语（「我要退费」），子串口径更贴近真实输入。
 * 否定词（negative_terms）命中即整条意图否决，并记入 negations 供后台审计。
 */
function scoreIntents(text) {
  const scores = []
  const negations = []
  for (const it of INTENTS) {
    const matched = []
    let score = 0
    for (const kw of it.keywords) {
      if (text.includes(kw.toLowerCase())) {
        matched.push(kw)
        score += weightOf(kw)
      }
    }
    if (score === 0) continue
    const veto = it.negative_terms.filter((n) => text.includes(n.toLowerCase()))
    if (veto.length > 0) {
      negations.push(...veto)
      score = 0
    }
    scores.push({ id: it.id, score, matched, vetoed: veto.length > 0 })
  }
  scores.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
  return { scores, negations }
}
/**
 * 识别主入口。返回形状固定（守卫按字段断言，勿随意增删）：
 *   { intent, confidence, matched, negations, flags, need_human }
 * - intent：red_flag | general_medical | symptom_consult | report_interp | fee_flow | med_ref_referral
 *            | refund | order_query | tech_support | out_of_scope
 *            （前四项医学域意图为 r96 双档之一；refund/order_query/tech_support 为客服兼容档）
 * - confidence：0..0.95；0 表示「一个关键词都没命中」，此时不做任何医疗断言
 * - flags：红旗明细（仅 red_flag 时非空），形状同 rules.js 的 scanFlagDetails
 * - need_human：用户是否显式要人工（供 handoff.js 判定 reason_code）
 */
export function detectIntent(text) {
  const raw = String(text ?? "").toLowerCase().slice(0, MAX_TEXT)

  // ---- 第 1 步：红旗闸门。命中即返回，后面什么都不跑 ----
  const flags = scanFlagDetails(raw)
  if (flags.length > 0) {
    return {
      intent: RED_FLAG_INTENT,
      confidence: 1,
      matched: flags.map((f) => f.name),
      negations: [],
      flags,
      need_human: false,
    }
  }

  const needHuman = HUMAN_ASK_TERMS.some((t) => raw.includes(t))

  // ---- 第 2 步：客服/医疗意图打分（在同义扩展文本上跑；否定词表匹配的是扩展文本的超集， veto 只会更严不会更松） ----
  const { scores, negations } = scoreIntents(expandSynonyms(raw))
  const top = scores.find((s) => s.score > 0)

  if (!top) {
    // 一个词都没命中 ⇒ 证据不足。按失败安全处理：不猜成任何医疗结论，直接判超范围交人工。
    return {
      intent: "out_of_scope",
      confidence: 0,
      matched: [],
      negations,
      flags: [],
      need_human: needHuman,
    }
  }

  return {
    intent: top.id,
    confidence: toConfidence(top.score),
    matched: top.matched,
    negations,
    flags: [],
    need_human: needHuman,
  }
}

/** 该意图的注册表条目（用于取 reply_policy / confidence_floor / handoff_policy）。红旗不入表。 */
export function intentSpec(intent) {
  return INTENT_BY_ID.get(intent) || null
}

/** 该意图是否要求「证据不足即转人工」/「总是转人工」——handoff.js 的策略分支依据。 */
export function handoffPolicyOf(intent) {
  return intentSpec(intent)?.handoff_policy || null
}

export function confidenceFloorOf(intent) {
  const spec = intentSpec(intent)
  return spec && typeof spec.confidence_floor === "number" ? spec.confidence_floor : null
}

export function replyPolicyOf(intent) {
  return intentSpec(intent)?.reply_policy || null
}

/**
 * 该意图是否走 FAQ 检索。
 * 只有 reply_policy=route_dx（医疗问诊）才检索临床知识库：客服三类（退费/查报告/技术支持）
 * 检索临床知识库只会得到**驴唇不对马嘴的引用**，宁可给话术模板也不给假证据。
 * 红旗与超范围同样不检索——前者直出急诊提示，后者直出转人工话术。
 */
export function shouldRetrieveFaq(intent) {
  return replyPolicyOf(intent) === "route_dx"
}
