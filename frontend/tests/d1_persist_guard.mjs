// 持久化守卫（round90）：schema 无漂移 + 代码 SQL 与 schema 交叉对账 + 写入必脱敏 + 反馈边界。
//
// 「代码 SQL 与 schema 交叉对账」是本守卫的核心：改查询不改 schema（或反之）在本地无 D1 时**完全测不出来**，
// 一上线才炸。把 SQL 里出现的表名/索引列与 schema 文件对账，能把这类漂移提前到 CI。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { redactPii } from "../functions/lib/pii.js"
import { isValidScore, d1Available } from "../functions/lib/chat_store.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

console.log("== schema 无漂移 ==")
try {
  const out = execFileSync(process.execPath, [REPO + "scripts/d1_migrate.mjs", "--check"], { encoding: "utf8", stdio: "pipe" })
  check("d1_migrate.mjs --check 绿", out.includes("[GATE:d1-schema-pass]"), out.slice(-120))
} catch (e) {
  check("d1_migrate.mjs --check 绿", false, String((e.stderr || e.stdout || e)).slice(-140))
}

const schema = readFileSync(REPO + "scripts/d1_schema.sql", "utf8")
const storeSrc = readFileSync(REPO + "frontend/functions/lib/chat_store.js", "utf8")

/** 从 schema 文本抽表名（纯函数，好让变异能驱动它）。 */
function tablesIn(sql) {
  return [...new Set([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]))]
}
/** 从代码里抽它实际读写的表名。 */
function tablesUsed(sql) {
  return [...new Set([...sql.matchAll(/(?:FROM|INTO|UPDATE)\s+(\w+)/g)].map((m) => m[1]))]
}

const declared = tablesIn(schema)
const used = tablesUsed(storeSrc)
check("schema 抽出 5 张表", declared.length === 5, declared.join(","))
check("代码用到的表全部在 schema 内（改查询不改 schema 会在此判红）",
  used.every((t) => declared.includes(t)), used.filter((t) => !declared.includes(t)).join(","))
check("schema 里的表全部被代码用到（防建了没人用的表）",
  declared.every((t) => used.includes(t)), declared.filter((t) => !used.includes(t)).join(","))
// 变异自证：往代码里塞一张不存在的表，同一判据必须点名（否则上面两条可能恒真）
check("M1 变异自证：引用不存在的表会被点名",
  !["ghost_table"].every((t) => declared.includes(t)) && tablesUsed("SELECT * FROM ghost_table").some((t) => !declared.includes(t)))

console.log("== 索引覆盖 ==")
for (const [idx, why] of [["idx_conversations_updated", "会话列表按 updated_at 倒序"], ["idx_messages_conv", "会话详情按会话取消息"], ["idx_handoffs_status", "转人工队列按状态+时间"], ["idx_intent_events_intent", "意图分布聚合"]]) {
  check(`索引 ${idx} 存在（${why}）`, schema.includes(idx))
}

console.log("== 写入必脱敏 ==")
check("appendMessage 源码确实调用了 redactPii", /redactPii\(content\)/.test(storeSrc))
const sample = redactPii("我叫张三，手机13812345678，身份证110101199003071234")
check("脱敏后手机号不可见", !sample.text.includes("13812345678"), sample.text)
check("脱敏后身份证不可见", !sample.text.includes("110101199003071234"))
check("脱敏后姓名不可见", !sample.text.includes("张三"))
check("脱敏记录了命中类型（供后台审计，不含原值）", sample.hits.length > 0 && !JSON.stringify(sample.hits).includes("13812345678"))
check("反向对照：不含 PII 的文本原样返回", redactPii("今天头晕").text === "今天头晕")

console.log("== 反馈边界 ==")
for (const v of [1, 3, 5, "4"]) check(`score=${JSON.stringify(v)} 合法`, isValidScore(v) === true)
for (const v of [0, 6, -1, 2.5, null, undefined, "abc"]) check(`score=${JSON.stringify(v)} 非法`, isValidScore(v) === false)

console.log("== D1 可用性判定 ==")
check("无绑定时 d1Available=false", d1Available({}) === false)
check("有 prepare 的对象视为可用", d1Available({ DB: { prepare: () => {} } }) === true)
check("有 DB 但不是 D1（无 prepare）=> false", d1Available({ DB: {} }) === false)

console.log(`\nD1 PERSIST GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)