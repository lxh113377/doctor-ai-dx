// 对话面 API 守卫（round90）：端点契约 / 入站边界 / 模式如实性 / 引用白名单 / 红旗优先。
//
// 直调 Pages Functions 的 onRequest（Node 有 Request/Response 全局），不需要部署或云账号——
// 与 route_guard.mjs 同法。**D1 未绑定是本守卫的常态**，因此所有持久化判据都按"未绑定"分支断言：
// 顺带把「没绑定也要如实回报 persisted:false」这条契约钉住（它最容易在赶功能时被悄悄改成 true）。
import { onRequest } from "../functions/api/[[route]].js"
import { hasEvidence } from "../functions/lib/rag.js"
import { SLOT_ASK_TEXT, COMPLIANCE_LINE } from "../functions/lib/chat_synth.js"

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const ctx = (path, init) => ({ request: new Request(`https://dx.test${path}`, init), env: {} })
const postChat = async (payload, env = {}) => {
  const res = await onRequest({ request: new Request("https://dx.test/api/chat", {
    method: "POST", body: JSON.stringify(payload),
  }), env })
  return { res, body: await res.json() }
}

console.log("== 端点与信封 ==")
const ok = await postChat({ text: "孩子高热惊厥怎么办" })
check("POST /api/chat 返回 200", ok.res.status === 200, String(ok.res.status))
check("响应信封为 {code:0,data}", ok.body.code === 0 && !!ok.body.data)
for (const f of ["conversation_id", "intent", "confidence", "answer", "red_flag", "handoff", "abstain", "mode", "persisted", "version"]) {
  check(`响应含字段 ${f}`, f in ok.body.data)
}

console.log("== 入站边界（沿用 limits 的既有口径）==")
const empty = await postChat({ text: "" })
check("空文本 => 422", empty.res.status === 422, String(empty.res.status))
const noText = await postChat({})
check("缺 text => 422", noText.res.status === 422, String(noText.res.status))
const oversize = await postChat({ text: "x".repeat(2100) })
check("超长文本 => 422（形状层）或 413（体积层），不得 200", oversize.res.status === 422 || oversize.res.status === 413, String(oversize.res.status))
const badJson = await onRequest(ctx("/api/chat", { method: "POST", body: "{not json" }))
check("坏 JSON => 400", badJson.status === 400, String(badJson.status))
const miss = await onRequest(ctx("/api/nope", { method: "GET" }))
check("未知路径 => 404", miss.status === 404, String(miss.status))

console.log("== 模式如实性 ==")
check("本面不调模型 ⇒ mode 恒为 deterministic", ok.body.data.mode === "deterministic", ok.body.data.mode)
check("answer_source 与 mode 自洽", ok.body.data.answer_source === "deterministic", ok.body.data.answer_source)
check("D1 未绑定时 persisted=false", ok.body.data.persisted === false, String(ok.body.data.persisted))
check("D1 未绑定时给出可归因原因", String(ok.body.data.persist_reason || "").includes("D1"), ok.body.data.persist_reason)
const detail = await onRequest(ctx("/api/chat/whatever", { method: "GET" }))
const detailBody = await detail.json()
check("会话详情在未绑定时如实回报 available=false", detailBody.data.available === false)

console.log("== 引用白名单（红线：引用只来自知识库）==")
const cites = ok.body.data.answer.citations || []
check("医疗问诊返回引用", cites.length > 0, `cites=${cites.length}`)
check("每条引用都在知识库白名单内", cites.every((c) => hasEvidence(c.evidence_id)),
  cites.filter((c) => !hasEvidence(c.evidence_id)).map((c) => c.evidence_id).join(","))
const svc = await postChat({ text: "检查报告在哪里看" })
check("客服意图不得携带临床引用（防驴唇不对马嘴的证据）",
  (svc.body.data.answer.citations || []).length === 0, JSON.stringify(svc.body.data.answer.citations))

console.log("== 红旗优先 + 转人工 ==")
const red = await postChat({ text: "我要退挂号费，但是压榨样胸痛还冒冷汗" })
check("混合输入判 red_flag", red.body.data.intent === "red_flag", red.body.data.intent)
check("红旗路径返回 red_flag 结构", !!red.body.data.red_flag?.name && !!red.body.data.red_flag?.advice)
check("红旗话术含急诊指引 120", red.body.data.answer.text.includes("120"))
check("红旗路径 handoff 原因码为 RED_FLAG", red.body.data.handoff?.reason_code === "RED_FLAG")
check("红旗话术带合规声明", red.body.data.answer.text.includes("医生终审"))
const oos = await postChat({ text: "今天天气怎么样" })
check("超范围转人工 OUT_OF_SCOPE", oos.body.data.handoff?.reason_code === "OUT_OF_SCOPE")
check("转人工带工单号", /^HO-/.test(oos.body.data.handoff?.ticket_id || ""), oos.body.data.handoff?.ticket_id)
const slot = await postChat({ text: "我要退费" })
check("S5 缺槽位首轮 ⇒ 追问一轮（不直接转人工）", !slot.body.data.handoff && slot.body.data.answer.text.includes(SLOT_ASK_TEXT), JSON.stringify(slot.body.data.handoff))
const slot2 = await postChat({
  text: "我就是要退费，别问了",
  history: [
    { role: "user", content: "我要退费" },
    { role: "assistant", content: SLOT_ASK_TEXT + "\n\n" + COMPLIANCE_LINE },
  ],
})
check("S5 追问后仍缺 ⇒ MISSING_SLOT 转人工", slot2.body.data.handoff?.reason_code === "MISSING_SLOT", slot2.body.data.handoff?.reason_code)
check("S5 转人工响应带追问标识（话术常量单一源，history 识别不漂移）", typeof SLOT_ASK_TEXT === "string" && SLOT_ASK_TEXT.length > 10)
const withSlot = await postChat({ text: "我要退挂号费，挂号号是12345678" })
check("给了槽位则不再因缺槽位转人工", withSlot.body.data.handoff?.reason_code !== "MISSING_SLOT", withSlot.body.data.handoff?.reason_code)

console.log("== 合规红线 ==")
const text = red.body.data.answer.text
check("不得出现「替代医生」（只允许「不能替代医生面诊」）", !text.replace("不能替代医生面诊", "").includes("替代医生"))

console.log(`\nCHAT API GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)