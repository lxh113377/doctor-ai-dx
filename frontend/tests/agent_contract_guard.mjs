// 面2 ↔ 面3 契约守卫（r91，S6）：agent-service 手写 TS 类型 ↔ 面2 权威实现逐字段对账。
//
// 背景（r90 报告 §1 维2 / §2.8）：`agent-service/server/medchat.ts` 的 `ClinicalChatData`
// 是**手写的第二真值**——面2 返回面一改（增删字段），TS 侧静默漂移，编译期抓不住（TS 只对
// 面3 内部生效，不对面2 响应做校验）。本守卫把「手写类型 ⊆ 权威返回」做成会红的判据：
// 任何一侧改而另一侧未同步，`npm test` 即红。
// 真值方向：`frontend/functions/lib/chat.js` 的 handleChat 返回块是**权威**；TS 块只许声明
// 它真正读取的子集（r90 口径），因此判据是「TS 字段 ⊆ 返回键」而非双向全等。
import { readFileSync } from "node:fs"

const medchatSrc = readFileSync(new URL("../../agent-service/server/medchat.ts", import.meta.url), "utf8")
const chatSrc = readFileSync(new URL("../functions/lib/chat.js", import.meta.url), "utf8")
const faqSrc = readFileSync(new URL("../functions/lib/faq.js", import.meta.url), "utf8")
const openapi = JSON.parse(readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8"))

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

console.log("== 面2 ↔ 面3 契约对账 ==")
const typeBlock = medchatSrc.match(/type ClinicalChatData = \{[\s\S]*?\n\};/)?.[0] || ""
check("C1 medchat.ts 存在 ClinicalChatData 契约块", typeBlock.length > 0)
const tsFields = [...typeBlock.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
check("C2 契约块可解析且非空（≥6 字段）", tsFields.length >= 6, tsFields.join(","))

// 权威返回面：chat.js handleChat 的 return 块（4 空格缩进的键名行）。
const retMatch = chatSrc.match(/return \{\n([\s\S]*?)\n {2}\}\n\}/)
check("C3 chat.js handleChat 返回块可解析", !!retMatch)
const retBlock = retMatch ? retMatch[1] : ""
const retKeys = [...retBlock.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1])
check("C4 返回键非空（≥9 键）", retKeys.length >= 9, retKeys.join(","))

const missing = tsFields.filter((f) => !retKeys.includes(f))
check("C5 TS 契约字段全部在面2 返回面内（漂移即红）", missing.length === 0, `缺失: ${missing.join(",")}`)
check("C6 契约声明面确实引用 openapi（注释口径不落空）",
  /openapi\.json/.test(medchatSrc) && !!openapi.paths?.["/api/chat"]?.post)

// 嵌套对象逐键对账：TS 侧 answer/handoff/red_flag 的内层字段必须能在面2 实现面找到。
// answer.citations 的数组元素字段（title/source/year 等）由 faq.js 构建自 rag.js 的 EvidenceItem，
// 所以这层对账的"实现面"是 faq.js（citation 构建处），不是 chat.js 的返回块。
const citationSrc = chatSrc + "\n" + faqSrc
const nestedOk = ["answer", "handoff", "red_flag"].map((key) => {
  const m = typeBlock.match(new RegExp(`${key}\\??:\\s*\\{([^}]*)\\}`))
  if (!m) return { key, ok: false, missing: ["<块缺失>"] }
  const inner = [...m[1].matchAll(/(\w+)\??:/g)].map((x) => x[1])
  const pool = key === "answer" ? citationSrc : retBlock
  const miss = inner.filter((f) => !pool.includes(f))
  return { key, ok: miss.length === 0, missing: miss }
})
for (const n of nestedOk) {
  check(`C7 TS ${n.key} 内层字段 ⊆ 面2 实现面`, n.ok, `缺失: ${n.missing.join(",")}`)
}

// 反例自证：把契约块抽掉一个字段后，提取器必须产出不同的字段集——否则 C5 可能恒真。
// 注意仓内 TS 为 CRLF：`.` 不吃 `\r`，变异正则必须显式容忍 `\r?\n`。
const mutated = typeBlock.replace(/^\s{2}mode\??:.*\r?\n/m, "")
check("C8 反例自证：删字段后提取集变小（提取器非恒真）",
  [...mutated.matchAll(/^\s{2}(\w+)\??:/gm)].length === tsFields.length - 1)

console.log(`\nAGENT CONTRACT GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
