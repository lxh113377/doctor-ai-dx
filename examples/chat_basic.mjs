// 最小可运行示例（r91，S9）：三类意图 + 红旗旁路 + 槽位追问，零密钥零网络零 D1。
// 跑法（仓根执行）：node examples/chat_basic.mjs
import { handleChat } from "../frontend/functions/lib/chat.js"

const demos = [
  { label: "医疗问诊（走 FAQ 检索，带引用）", input: { text: "孩子高热惊厥怎么办" } },
  { label: "退费意图（缺槽位 ⇒ 追问一轮）", input: { text: "我要退费" } },
  {
    label: "追问后补了号 ⇒ 正常给话术（不转人工）",
    input: {
      text: "挂号号是12345678",
      history: [
        { role: "user", content: "我要退费" },
        {
          role: "assistant",
          content: "请提供您的挂号单号、订单号或报告编号（6 位以上数字），我帮您继续办理。\n\n本回复为 AI 辅助参考 · 医生终审，不能替代医生面诊。",
        },
      ],
    },
  },
  { label: "红旗旁路（规则层逐字直出，不经模型）", input: { text: "我要退挂号费，但是压榨样胸痛还冒冷汗" } },
]

for (const d of demos) {
  const { data } = { data: await handleChat({ ...d.input, conversation_id: null, env: {} }) }
  console.log("\n=== " + d.label + " ===")
  console.log("intent=" + data.intent, "confidence=" + data.confidence, "mode=" + data.mode,
    "persisted=" + data.persisted + "（本示例无 D1，如实降级）")
  console.log("answer:\n" + data.answer.text)
  if (data.answer.citations?.length) {
    console.log("citations: " + data.answer.citations.map((c) => c.title).join(" / "))
  }
  if (data.handoff) console.log("handoff: " + data.handoff.reason_code + " ticket=" + data.handoff.ticket_id)
  if (data.red_flag) console.log("red_flag: " + data.red_flag.name + "（" + data.red_flag.severity + "）")
}
