// 确定性话术合成：Agent SDK 不可用、或红旗旁路时，**仍然要给出一段合规回复**。
//
// 为什么必须存在：项目定位是「失败安全降级」——模型不可用不能让医生看到一个空白页或一句
// "服务不可用"。本模块产出的是**不含任何医学判断**的流程性话术：红旗路径只复述规则层已给出的
// 急诊提示，客服路径只讲流程，不谈诊断、不谈用药。这既是降级需求，也是红线要求。
import { RED_FLAG_INTENT } from "./intent.js"

/** 全站合规声明：任何路径的回复都不得省略它（红线 2）。 */
export const COMPLIANCE_LINE = "本回复为 AI 辅助参考 · 医生终审，不能替代医生面诊。"

/** 客服三类的话术模板：只讲「下一步去哪做」，不承诺结果、不给医学判断。 */
const SERVICE_TEMPLATES = {
  service_refund: [
    "挂号与缴费的退费、退号属于院内窗口业务，需要本人在场办理。",
    "请携带就诊凭证与缴费票据到挂号收费窗口办理退费；已就诊且无法退费的情形由窗口核实后判定。",
    "退款到账时间以支付渠道为准，本系统不代收也不代退费用。",
    "如窗口不在开放时间或你已被转人工客服，请在工单中留下联系方式。",
  ],
  service_order_query: [
    "检查报告、处方与挂号单属于个人医疗记录，需凭本人身份在院内自助机或医生工作站查询。",
    "本系统不存储、也不代为展示你的报告内容，避免隐私泄露。",
    "报告出具时间以检验科/影像科实际出报告时间为准，部分项目需等待 1 至 3 个工作日。",
    "如你已在院内但仍查不到，请携带缴费票据到对应科室登记查询。",
  ],
  service_tech_support: [
    "页面打不开、登录异常等问题，请先尝试刷新页面并确认网络连接正常。",
    "浏览器建议使用 Chrome、Edge 等主流浏览器的较新版本。",
    "如问题重复出现，请记下发生时间与页面提示，我们将通过人工客服跟进。",
    "本系统不会主动索取你的密码或验证码，任何索要验证码的请求都请拒绝。",
  ],
  abstain_and_handoff: [
    "这个问题超出了本系统可处理的范围，我不会给出可能不准确的回答。",
    "已为您转接人工客服进一步协助。",
  ],
}

/**
 * 合成确定性回复。
 * @param {object} input
 * @param {string} input.intent
 * @param {Array}  input.flags 红旗明细（intent=red_flag 时非空）
 * @param {string} input.handoff_reason_text 转人工原因文案（可空）
 * @param {Array}  input.faq 可选的 FAQ 答案包（医疗问诊类才有）
 * @returns {{text:string,citations:Array}}
 */
export function synthesize(input) {
  const { intent, flags = [], handoff_reason_text = "", faq = null } = input || {}

  // 1) 红旗：逐字复述规则层给的建议，一条都不改写、不追加医学内容。
  if (intent === RED_FLAG_INTENT && flags.length > 0) {
    const lines = flags
      .map((f) => `· ${f.name}：${f.advice}`)
      .concat([
        "请立即停止自行处理并前往急诊或联系 120；不要等待本系统进一步回复。",
      ])
    return { text: lines.join("\n") + "\n\n" + COMPLIANCE_LINE, citations: [] }
  }

  // 2) 医疗问诊：有 FAQ 就用 FAQ 证据包（弃权时由 FAQ 自带说明）。
  if (faq) {
    return {
      text: faq.text + "\n\n" + COMPLIANCE_LINE,
      citations: faq.citations || [],
    }
  }

  // 3) 客服三类：按 reply_policy 选模板。
  const spec = SERVICE_TEMPLATES[intent === RED_FLAG_INTENT ? "" : intent]
  const template = spec || null
  const policyTemplate = template || SERVICE_TEMPLATES.abstain_and_handoff

  const lines = policyTemplate.slice()
  if (handoff_reason_text) lines.push(handoff_reason_text + "。")

  // 4) 兜底：注册表里没有对应模板 ⇒ 不编内容，直接转人工。
  if (!template && intent !== "out_of_scope") {
    lines.length = 0
    lines.push("该问题我暂时无法给出可靠答复，已为您转接人工客服。")
  }

  return { text: lines.join("\n") + "\n\n" + COMPLIANCE_LINE, citations: [] }
}