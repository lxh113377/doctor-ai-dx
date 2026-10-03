// 确定性话术合成：Agent SDK 不可用、或红旗旁路时，**仍然要给出一段合规回复**。
//
// 为什么必须存在：项目定位是「失败安全降级」——模型不可用不能让医生看到一个空白页或一句
// "服务不可用"。本模块产出的是**不含任何医学判断**的流程性话术：红旗路径只复述规则层已给出的
// 急诊提示，客服路径只讲流程，不谈诊断、不谈用药。这既是降级需求，也是红线要求。
import { RED_FLAG_INTENT } from "./intent.js"

/** 全站合规声明：任何路径的回复都不得省略它（红线 2）。 */
export const COMPLIANCE_LINE = "本回复为 AI 辅助参考 · 医生终审，不能替代医生面诊。"

/**
 * 槽位追问引导语（r91，S5；单一源）：
 * chat.js 的追问分支用它生成回复，也用它在 history 里识别「上一轮已经追问过」——
 * 两处共用同一个常量，措辞改了识别逻辑不会静默漂移。
 */
export const SLOT_ASK_TEXT = "请提供您的挂号单号、订单号或报告编号（6 位以上数字），我帮您继续办理。"

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
  // r96 新增四类医学域意图的话术。前三类的 reply_policy=route_dx，有 FAQ 证据包时走 faq 分支，
  // 这里的模板是「知识库没命中但需要流程性答复」时的兜底；fee_flow 是纯流程类，唯一走本分支的新类。
  fee_flow: [
    "门诊挂号与缴费可在本院自助机或收费窗口办理，也可通过院内公众号预约挂号后到院取号。",
    "医保报销范围与比例以参保地政策为准，住院需在入院时办理医保登记，出院时在结算窗口直接结算。",
    "改约、改期请在原预约渠道操作；已取号未就诊的按窗口退号流程办理。",
    "本系统不代收任何费用，也不会要求您向个人账户转账或提供验证码。",
  ],
  report_interp: [
    "检验指标的参考范围以报告单标注为准，单一指标轻度异常常受饮食、运动与检测批次影响。",
    "指标异常需要结合症状、用药史与复查趋势判断，本系统不据此下诊断结论。",
    "建议携带报告原件到开单科室或全科门诊由医生结合临床情况解读。",
  ],
  med_ref_referral: [
    "处方药的用法用量、漏服补服与合并用药请遵医嘱或咨询药师，不要自行调整剂量或停药。",
    "是否转诊转院由接诊医师根据检查结果与本院救治能力判断，必要时由本院开具转诊单。",
    "用药后出现皮疹、呼吸困难、明显水肿等情况请立即停药并就近急诊。",
  ],
  symptom_consult: [
    "按主诉常见情况，初次就诊可先选择全科或对应症状的系统科室；症状集中在胸痛、呼吸困难、意识改变等情况请直接到急诊。",
    "本系统只做就医流向提示，不做诊断；是否急诊请以现场分诊护士与医师判断为准。",
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
  const { intent, flags = [], handoff_reason_text = "", faq = null, slot_followup = false } = input || {}

  // 1) 红旗：逐字复述规则层给的建议，一条都不改写、不追加医学内容。
  if (intent === RED_FLAG_INTENT && flags.length > 0) {
    const lines = flags
      .map((f) => `· ${f.name}：${f.advice}`)
      .concat([
        "请立即停止自行处理并前往急诊或联系 120；不要等待本系统进一步回复。",
      ])
    return { text: lines.join("\n") + "\n\n" + COMPLIANCE_LINE, citations: [] }
  }

  // 1.5) 槽位追问（S5）：缺标识符的首轮，先追问一轮再谈转人工——追问里不含任何流程承诺，
  // 只请对方补号；下一轮仍缺才交 MISSING_SLOT 转人工（chat.js 决定，这里只负责话术）。
  if (slot_followup) {
    return { text: SLOT_ASK_TEXT + "\n\n" + COMPLIANCE_LINE, citations: [] }
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