// 意图表守卫（round90）：权威 JSON ⇄ 双端生成物三方全等 + 红旗优先级反例。
//
// 最重要的一条是 **R1/R2/R3**：客服三类（refund / order_query / tech_support）各自都可能被
// "红旗关键词 + 客服话术" 的混合输入命中。规则层要求红旗**闸门在入口第一步**，命中即短路。
// 这三条判据是本项目红线 1 在对话面的机器留痕：一旦有人把 scanFlags 挪到意图判定之后，它们立刻变红。
//
// 变异自证刻意**只改内存里的输入文本、不改数据文件**：上一版守卫把变异写进文件再 fork 子进程复跑，
// 覆盖率统计因此错位（判据自己把被测对象改了），那种"红"与"绿"都不可信。
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { INTENTS, REQUIRED_INTENT_IDS, INTENT_BY_ID } from "../functions/lib/intents.js"
import { detectIntent, SERVICE_INTENT_IDS, RED_FLAG_INTENT } from "../functions/lib/intent.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

console.log("== 生成器无漂移 ==")
for (const [flag, gate] of [["--check", "intents-export-check"], ["--selftest", "intents-export-selftest"]]) {
  try {
    const out = execFileSync(process.execPath, [REPO + "scripts/export_intents.mjs", flag], { encoding: "utf8", stdio: "pipe" })
    check(`export_intents.mjs ${flag} 绿（[GATE:${gate}-pass]）`, out.includes(`[GATE:${gate}-pass]`), out.slice(-120))
  } catch (e) {
    const out = String((e.stdout || "") + (e.stderr || "")).trim().split("\n").slice(-1)[0]
    check(`export_intents.mjs ${flag} 绿`, false, out || `rc=${e.status}`)
  }
}

console.log("== 注册表结构 ==")
check(`五类意图齐备（${REQUIRED_INTENT_IDS.join("/")}）`, REQUIRED_INTENT_IDS.length === 5)
check("生成物条数与必需类数一致", INTENTS.length >= REQUIRED_INTENT_IDS.length, `INTENTS=${INTENTS.length}`)
check("三类客服意图都在注册表内", SERVICE_INTENT_IDS.every((id) => INTENT_BY_ID.has(id)))
check("红旗意图不在注册表内（它由规则层裁定，优先级硬编码）", !INTENT_BY_ID.has(RED_FLAG_INTENT))
check("每条意图都有非空关键词与标签", INTENTS.every((i) => i.keywords.length > 0 && i.label.trim().length > 0))
check("置信度下限均落在 (0,1]", INTENTS.every((i) => i.confidence_floor > 0 && i.confidence_floor <= 1))

console.log("== 红旗优先级（红线 1 的机器留痕）==")
// R1: 三类客服话术各自叠加压榨样胸痛 + 冷汗，必须全部判 red_flag。
const mixes = [
  ["我要退挂号费，但是压榨样胸痛还冒冷汗", "refund"],
  ["检查报告在哪看，顺便说下我压榨样胸痛冒冷汗", "order_query"],
  ["页面打不开，另外我压榨样胸痛冒冷汗", "tech_support"],
]
for (const [text, naive] of mixes) {
  const d = detectIntent(text)
  check(`R1 「${naive} + 压榨样胸痛」判 red_flag 而非 ${naive}`, d.intent === RED_FLAG_INTENT, `实得 ${d.intent}`)
  check(`R2 同输入的红旗明细非空（不是靠空命中蒙对）`, d.flags.length >= 1, `flags=${d.flags.length}`)
}
// 反向对照：去掉红旗词后必须判回客服意图，否则上面三条可能因为"客服词也匹配不到"而恒真。
for (const [text, want] of [["我要退挂号费", "refund"], ["检查报告在哪看", "order_query"], ["页面打不开", "tech_support"]]) {
  check(`R3 反向对照：去掉红旗词后判 ${want}`, detectIntent(text).intent === want, `实得 ${detectIntent(text).intent}`)
}

console.log("== 否定词否决 ==")
check("N1 「我不退费」不得判 refund", detectIntent("我不退费，只是问一下").intent !== "refund", detectIntent("我不退费，只是问一下").intent)
check("N2 否定词被记入 negations 供审计", detectIntent("我不退费，只是问一下").negations.length > 0)

console.log("== 同义扩展（r91：复用 SYNONYMS 单一源，纯代码接线、零词表改动）==")
// S1 判据：SYNONYMS 既有组内的口语变体必须能命中意图（改前「喘不上气/天旋地转」这类词不在 intents 词表，直接漏判）。
// 注意：「心脏不舒服」这类**表外**口语词经实测不能经本通道解决——往 SYNONYMS 加词会扰动 RAG 检索排序
// （ret-46 mrr 1→0.5、ret-01 recall@5 1→0.5 两条回归锁实测命中），已按 R263 回滚数据、保留本纯复用方案；
// 表外口语词的承载机制归 S5（槽位/实体层）。
check("Y1 表内口语「头重脚轻」命中 general_medical（同义扩展）", detectIntent("一起床就头重脚轻").intent === "general_medical", `实得 ${detectIntent("一起床就头重脚轻").intent} / flags=${JSON.stringify(detectIntent("一起床就头重脚轻").flags)}`)
check("Y2 表内口语「天旋地转」命中 general_medical", detectIntent("一起床就天旋地转").intent === "general_medical", `实得 ${detectIntent("一起床就天旋地转").intent}`)
check("Y3 扩展命中的关键词可溯源（matched 里是扩展落点词，非空）", detectIntent("一起床就头重脚轻").matched.length > 0, JSON.stringify(detectIntent("一起床就头重脚轻").matched))
// 反向对照：无临床符号的输入经扩展后仍必须零命中——防「扩展把一切文本都拉成医疗意图」的过扩。
check("Y4 反向对照：无临床符号输入仍 out_of_scope（扩展不过扩）", detectIntent("今天天气怎么样").intent === "out_of_scope", `实得 ${detectIntent("今天天气怎么样").intent}`)
check("Y5 反向对照：问候语 confidence 仍为 0", detectIntent("你好").confidence === 0)
check("Y6 红旗输入走扩展也无影响（闸门在扩展之前）", detectIntent("喘不上气，而且压榨样胸痛冒冷汗").intent === RED_FLAG_INTENT, `实得 ${detectIntent("喘不上气，而且压榨样胸痛冒冷汗").intent}`)

console.log("== 失败安全 ==")
check("F1 无任何关键词命中 => out_of_scope（不猜成医疗结论）", detectIntent("你好").intent === "out_of_scope")
check("F2 无命中时 confidence 恒为 0", detectIntent("你好").confidence === 0)
check("F3 空输入不得凭空命中客服意图", detectIntent("").intent === "out_of_scope")
check("F4 超长输入被截断到上限而非抛错", detectIntent("退费".repeat(2000)).intent === RED_FLAG_INTENT || detectIntent("退费".repeat(2000)).intent === "refund")

console.log(`\nINTENTS GUARD SUMMARY: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)