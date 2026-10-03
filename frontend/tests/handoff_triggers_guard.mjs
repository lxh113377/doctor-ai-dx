// 转人工四触发守卫（r96）：**四类逐条实测**，不是只测「用户说要人工」那一条。
//
// 为什么逐条：只测显式请求那一条，等于把三整类真实场景（答不上来还在硬答、重复失败、
// 用户在投诉）晾在外面。而转人工的代价结构是反的——多转一次只是多一个工单，
// 少转一次是让一个正在投诉的人继续听机器念流程话术。
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { decideHandoff, REASON_CODES, matchStrongTerm, HANDOFF_STRONG_TERMS, LOW_CONFIDENCE_TURNS, REPEATED_FAILURE_TURNS } from "../functions/lib/handoff.js"
import { detectIntent } from "../functions/lib/intent.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const OK = (d) => d.need_handoff === true
const NO = (d) => d.need_handoff === false

console.log("== 触发①：低置信（连续多轮确认不了意图）==")
const lowConf = decideHandoff({ text: "嗯……", intent: "general_medical", confidence: 0.1, unresolved_turns: LOW_CONFIDENCE_TURNS })
check(`连续 ${LOW_CONFIDENCE_TURNS} 轮 + 置信度 0.1 ⇒ 转人工 ${REASON_CODES.LOW_CONFIDENCE}`, OK(lowConf) && lowConf.reason_code === REASON_CODES.LOW_CONFIDENCE, JSON.stringify(lowConf))
const lowConfReverse = decideHandoff({ text: "嗯……", intent: "general_medical", confidence: 0.9, unresolved_turns: LOW_CONFIDENCE_TURNS })
check(`反向对照：高置信同轮数 ⇒ 不转（否则上面那条可能是因为"轮数到了"而恒真）`, NO(lowConfReverse), JSON.stringify(lowConfReverse))
const lowConfTurns = decideHandoff({ text: "嗯……", intent: "general_medical", confidence: 0.1, unresolved_turns: LOW_CONFIDENCE_TURNS - 1 })
check(`反向对照：低置信但轮数未到 ⇒ 不转（1 轮就转会显得草率）`, NO(lowConfTurns), JSON.stringify(lowConfTurns))

console.log("== 触发②：连续未解决（技术支持重复失败）==")
const repeated = decideHandoff({ text: "还是打不开", intent: "tech_support", confidence: 0.8, unresolved_turns: REPEATED_FAILURE_TURNS })
check(`技术支持重复 ${REPEATED_FAILURE_TURNS} 次 ⇒ 转人工 ${REASON_CODES.REPEATED_FAILURE}`, OK(repeated) && repeated.reason_code === REASON_CODES.REPEATED_FAILURE, JSON.stringify(repeated))
const repeatedReverse = decideHandoff({ text: "还是打不开", intent: "tech_support", confidence: 0.8, unresolved_turns: REPEATED_FAILURE_TURNS - 1 })
check("反向对照：首次失败先自动引导，不立刻转人工", NO(repeatedReverse), JSON.stringify(repeatedReverse))
const repeatedOtherIntent = decideHandoff({ text: "还是头晕", intent: "general_medical", confidence: 0.8, unresolved_turns: REPEATED_FAILURE_TURNS })
check("反向对照：同样的轮数换到医疗意图 ⇒ 不按 REPEATED_FAILURE 转（策略按意图分流）",
  repeatedOtherIntent.reason_code !== REASON_CODES.REPEATED_FAILURE, JSON.stringify(repeatedOtherIntent))

console.log("== 触发③：强词命中（投诉/索赔/监管）==")
for (const [text, term] of [
  ["我要投诉给你们领导", "投诉"],
  ["这个误诊我要索赔", "索赔"],
  ["我要向卫健委举报", "举报"],
  ["12345热线已经受理我的诉求", "12345热线"],
]) {
  const d = decideHandoff({ text, intent: "general_medical", confidence: 0.9 })
  check(`「${text}」判 ${REASON_CODES.STRONG_TERM}（命中词=${term}）`, OK(d) && d.reason_code === REASON_CODES.STRONG_TERM, JSON.stringify(d))
}
// 这条是 r96 真正补上的缺口：混着症状词的投诉，改前会走 general_medical 而完全绕过升级。
// 用「我最近胸闷」而不是「胸口还闷」：后者不含关键词「胸闷」，会判成 out_of_scope（它自带 always_handoff），
// 那样就证明不了「强词抢在医疗意图之前」——本条要的是：**意图确实是普通医疗类但仍被强词升级**。
const mixed = decideHandoff({ text: "我要投诉，我最近胸闷", intent: "general_medical", confidence: 0.9 })
check("「投诉 + 症状」混合输入仍判 STRONG_TERM（不因混着症状词被意图吞掉）", OK(mixed) && mixed.reason_code === REASON_CODES.STRONG_TERM, JSON.stringify(mixed))
check("该输入意图确实是 general_medical（证明上面不是靠意图判的）", detectIntent("我要投诉，我最近胸闷").intent === "general_medical", detectIntent("我要投诉，我最近胸闷").intent)
const strongReverse = decideHandoff({ text: "胸口还闷，还有点头晕", intent: "general_medical", confidence: 0.9 })
check("反向对照：去掉强词后不转人工（不会过度触发）", NO(strongReverse), JSON.stringify(strongReverse))
// 回归腿：r96 初版把裸「12345」列进强词表 ⇒ 用户补挂号单号「12345678」那一轮被判成投诉，
// 被 chat_api_guard 的 S5b 抓到。强词必须带语境，纯数字串是标识符不是情绪。
for (const id of ["12345678", "12345", "00012345"]) {
  check(`反向对照：单号「${id}」不得命中强词（标识符不是情绪信号）`, matchStrongTerm(id) === null, String(matchStrongTerm(id)))
}
for (const benign of ["我今天测了血糖", "报告怎么看", "预约挂号怎么操作"]) {
  check(`反向对照：普通医疗输入「${benign}」不得命中强词`, matchStrongTerm(benign) === null, String(matchStrongTerm(benign)))
}

console.log("== 触发④：显式要求人工==")
const human = decideHandoff({ text: "转人工客服", intent: "refund", confidence: 0.9, need_human: true })
check("显式要人工 ⇒ USER_REQUESTED", OK(human) && human.reason_code === REASON_CODES.USER_REQUESTED, JSON.stringify(human))
const humanReverse = decideHandoff({ text: "我要退挂号费", intent: "refund", confidence: 0.9, need_human: false })
check("反向对照：没说要人工的退费输入 ⇒ 不转", NO(humanReverse), JSON.stringify(humanReverse))

console.log("== 优先级：红旗永远第一，且不被强词抢占 ==")
const redAndStrong = decideHandoff({ text: "我要投诉，压榨样胸痛还冒冷汗", intent: "general_medical", confidence: 0.9, flags: [{ name: "急性冠脉综合征", severity: "critical", advice: "立即急诊" }] })
check("红旗 + 强词同时出现 ⇒ 判 RED_FLAG（红旗不排队）", OK(redAndStrong) && redAndStrong.reason_code === REASON_CODES.RED_FLAG, JSON.stringify(redAndStrong))
check("红旗的 context_digest 带上命中的规则名（不是空命中蒙对）", String(redAndStrong.context_digest || "").length > 0, String(redAndStrong.context_digest))

console.log("== 四类齐全性（缺一即漏）==")
const TRIGGERS = [REASON_CODES.LOW_CONFIDENCE, REASON_CODES.REPEATED_FAILURE, REASON_CODES.STRONG_TERM, REASON_CODES.USER_REQUESTED]
check("四类触发的 reason_code 互不相同且都在枚举内", new Set(TRIGGERS).size === 4 && TRIGGERS.every((c) => Object.values(REASON_CODES).includes(c)))
check("强词表非空且无重复", HANDOFF_STRONG_TERMS.length > 0 && new Set(HANDOFF_STRONG_TERMS).size === HANDOFF_STRONG_TERMS.length)
const chatSrc = readFileSync(REPO + "frontend/functions/lib/chat.js", "utf8")
check("chat.js 把原始文本喂给 decideHandoff（否则强词判定吃不到输入）", /decideHandoff\(\{[^}]*text:\s*raw/s.test(chatSrc))

console.log("== 工单关闭强制回收满意度 ==")
const storeSrc = readFileSync(REPO + "frontend/functions/lib/chat_store.js", "utf8")
check("关闭工单缺 score 时返回 422 并标记 requires_score", /requires_score:\s*true/.test(storeSrc) && /!isValidScore\(score\)/.test(storeSrc))
check("关闭与评分在同一 batch 内（防「工单已关但评分丢了」的半完成态）", /await env\[DB_BINDING\]\.batch\(statements\)/.test(storeSrc))
check("非关闭（assigned）不需要评分（不该把接单也卡住）", /if \(!wantsClose\)/.test(storeSrc))

console.log(`\nHANDOFF TRIGGERS GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
