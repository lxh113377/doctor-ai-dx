#!/usr/bin/env node
// 满意度 → 知识库待办 一键生成（r91，S11；r90 报告 §2.5 闭环缺口补票）。
//
// 闭环现状：/api/admin/stats 已产出 top_unresolved（原因 × 意图交叉清单），但「没有一键写入
// 知识库待办的路径」——本脚本补的就是这一跳。**刻意做成脚本而非管理写端点**：不在脱敏面上
// 再开一个写口（与 r90 §2.4 不做导出同一安全理由），知识条目的最终落库仍走
// docs/KNOWLEDGE_MAINTENANCE.md 的人工审核流程（source 核验 → kb:export → kb_guard）。
//
// 用法：
//   curl -s -H "x-admin-token: $TOKEN" https://<deployment>/api/admin/stats > /tmp/stats.json
//   node scripts/kb_todo_from_feedback.mjs /tmp/stats.json                 # 打印待办清单
//   node scripts/kb_todo_from_feedback.mjs /tmp/stats.json --out todo.md   # 同时写文件
//
// 退出码：0=有产出 / 1=输入非法（文件缺失、结构不对） / 2=输入合法但零未解决项（无需生成）。
import { readFileSync, writeFileSync } from "node:fs"

const [, , input, ...rest] = process.argv
const outIdx = rest.indexOf("--out")
const outFile = outIdx >= 0 ? rest[outIdx + 1] : null

if (!input) {
  console.error("KB-TODO FAIL: 用法 node scripts/kb_todo_from_feedback.mjs <stats.json> [--out todo.md]")
  process.exit(1)
}

let stats
try {
  stats = JSON.parse(readFileSync(input, "utf8"))
} catch (e) {
  console.error(`KB-TODO FAIL: 无法解析输入 ${input} :: ${String(e).slice(0, 120)}`)
  process.exit(1)
}
// 兼容信封（{code,data}）与裸 data 两种导出形态。
const data = stats?.data ?? stats
const items = data?.top_unresolved
if (!Array.isArray(items)) {
  console.error("KB-TODO FAIL: 输入缺 data.top_unresolved 数组（请确认导出来自 /api/admin/stats）")
  process.exit(1)
}
if (items.length === 0) {
  console.log("KB-TODO SKIP: top_unresolved 为空——当前没有需补知识的未解决交叉项。退出码 2（非失败）。")
  process.exit(2)
}

/** 原因 × 意图 → 建议动作（对齐 docs/KNOWLEDGE_MAINTENANCE.md 的补库路径）。 */
const ACTION = {
  OUT_OF_SCOPE: { where: "synonyms", what: "优先补同义词表组内口语变体（data/knowledge.json synonyms；注意会同步影响 RAG 检索，须复跑检索回归锁）" },
  ABSTAIN: { where: "entries", what: "知识库缺该域证据：按 §1 新增条目（source 必填，url 逐条人工核验后才写）" },
  MISSING_SLOT: { where: "话术", what: "非知识缺口：槽位追问已覆盖（S5），检查追问话术是否被用户看见" },
  LOW_CONFIDENCE: { where: "keywords", what: "意图词表未覆盖该说法：data/intents.json 对应意图补关键词（走 export_intents 生成守卫）" },
  REPEATED_FAILURE: { where: "话术", what: "技术支持类重复失败：核对 SERVICE_TEMPLATES 话术是否给出可执行步骤" },
  RED_FLAG: { where: "rules", what: "红旗命中属预期行为，不需要补知识；如误报请改 data/red_flag_rules.json 并跑红旗守卫" },
  USER_REQUESTED: { where: "无", what: "用户主动要人工，非知识缺口" },
}

const lines = [
  "# 知识库待办清单（由 kb_todo_from_feedback.mjs 生成，数据源 /api/admin/stats）",
  "",
  `> 生成时间：${new Date().toISOString()}｜统计面：会话 ${data.conversations ?? "?"} 个 / 已评分 ${data.rated ?? "?"} 条 / 平均分 ${data.avg_score ?? "?"}`,
  "> 处置流程见 docs/KNOWLEDGE_MAINTENANCE.md；本清单是**输入**，最终落库必须走人工审核 + kb:export + kb_guard。",
  "",
  "| # | 转人工原因 | 意图 | 样本量 | 建议动作（落点） |",
  "|---|---|---|---|---|",
]
items.forEach((it, i) => {
  const reason = String(it.reason_code || it.reason || "?")
  const intent = String(it.intent || "?")
  const n = it.n ?? it.count ?? "?"
  const act = ACTION[reason] || { where: "待判", what: "未知原因码，先人工归因" }
  lines.push(`| ${i + 1} | ${reason} | ${intent} | ${n} | ${act.what}（落点：${act.where}） |`)
})
lines.push("", `_共 ${items.length} 条交叉项。生成器：scripts/kb_todo_from_feedback.mjs（只读统计，不写任何库）。_`)

const md = lines.join("\n") + "\n"
if (outFile) {
  writeFileSync(outFile, md, "utf8")
  console.log(`KB-TODO: 已写出 ${outFile}（${items.length} 条交叉项）`)
} else {
  console.log(md)
}
console.log("[GATE:kb-todo-pass]")
process.exit(0)
