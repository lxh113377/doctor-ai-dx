
// 自动转人工判定。
//
// 设计取向：**宁可多转，不可硬答**。本项目的红线是「不硬答、不拿未回链结论吓人」，
// 因此每一类转人工触发都对应一个「继续自动答下去会更糟」的具体场景，而不是为了凑指标。
// 每次判定都产出稳定的 reason_code（供后台队列筛选与守卫断言），而不是一段自由文本——
// 后台要按原因聚合统计，文本不可聚合。
import { intentSpec } from "./intent.js"
import { RED_FLAG_INTENT } from "./intent.js"

export const REASON_CODES = Object.freeze({
  RED_FLAG: "RED_FLAG",
  USER_REQUESTED: "USER_REQUESTED",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  MISSING_SLOT: "MISSING_SLOT",
  REPEATED_FAILURE: "REPEATED_FAILURE",
  ABSTAIN: "ABSTAIN",
})

const REASON_TEXT = Object.freeze({
  RED_FLAG: "已识别到危险信号，优先按急诊与转诊提示处理",
  USER_REQUESTED: "您要求人工服务，已为您转接",
  OUT_OF_SCOPE: "该问题超出本系统可处理范围，已转人工客服",
  LOW_CONFIDENCE: "连续多轮未能确认您的意图，已转人工客服",
  MISSING_SLOT: "缺少查询所需的关键信息且未能补齐，已转人工客服",
  REPEATED_FAILURE: "技术支持问题重复出现仍未解决，已转人工客服",
  ABSTAIN: "现有知识库证据不足，未作判断，已转人工客服",
})

/** 连续低置信多少轮才转人工：1 轮就转会显得草率，5 轮才转会显得迟钝，取 3。 */
export const LOW_CONFIDENCE_TURNS = 3
/** 技术支持重复失败上限。 */
export const REPEATED_FAILURE_TURNS = 2

/**
 * 判定是否需要转人工。纯函数、无 IO ⇒ 可单测、可在守卫里穷举。
 * @param {object} input
 * @param {string} input.intent
 * @param {number} input.confidence
 * @param {Array}  input.flags 红旗明细（intent=red_flag 时非空）
 * @param {boolean} input.need_human 用户显式要人工
 * @param {number} input.unresolved_turns 连续未解决的轮数
 * @param {boolean} input.missing_slot 是否缺关键信息且用户未补
 * @param {boolean} input.abstain 上游是否弃权（证据不足）
 */
export function decideHandoff(input) {
  const {
    intent,
    confidence = 0,
    flags = [],
    need_human = false,
    unresolved_turns = 0,
    missing_slot = false,
    abstain = false,
  } = input || {}

  const hit = (code) => ({
    need_handoff: true,
    reason_code: code,
    reason_text: REASON_TEXT[code],
    context_digest: "",
  })
  const no = {
    need_handoff: false,
    reason_code: "",
    reason_text: "",
    context_digest: "",
  }

  // 1) 红旗永远第一位：哪怕用户同时在说「我要退费」，也先按急诊处理，不排队。
  if (intent === RED_FLAG_INTENT || (Array.isArray(flags) && flags.length > 0)) {
    const top = flags[0]
    return {
      ...hit(REASON_CODES.RED_FLAG),
      context_digest: top ? String(top.name || "").slice(0, 80) : "",
    }
  }

  // 2) 用户显式要人工。
  if (need_human) return hit(REASON_CODES.USER_REQUESTED)

  const spec = intentSpec(intent)

  // 3) 注册表策略：总是转人工（超范围）。
  if (spec?.handoff_policy === "always_handoff") return hit(REASON_CODES.OUT_OF_SCOPE)

  // 4) 缺关键信息且用户不补（查询/退费类槽位未命中）。
  if (spec?.handoff_policy === "escalate_if_missing_slot" && missing_slot) {
    return hit(REASON_CODES.MISSING_SLOT)
  }

  // 5) 连续重复失败（技术支持类）。
  if (spec?.handoff_policy === "escalate_if_repeated" && unresolved_turns >= REPEATED_FAILURE_TURNS) {
    return hit(REASON_CODES.REPEATED_FAILURE)
  }

  // 6) 证据不足弃权：医疗类不许硬答。
  if (spec?.handoff_policy === "abstain_or_low_confidence" && abstain) {
    return hit(REASON_CODES.ABSTAIN)
  }

  // 7) 连续低置信。
  if (unresolved_turns >= LOW_CONFIDENCE_TURNS) {
    const floor = spec?.confidence_floor ?? 0.3
    if (confidence < floor) return hit(REASON_CODES.LOW_CONFIDENCE)
  }

  return no
}