// 对话面判定链基准（r91，S4）——一条命令可复算的 P95 读数（r90 报告 §2.6「无读数」缺口的补票）。
//
// 口径：对 handleChat 直接进程内调用（不含网络/不含 D1/不含面3 Agent 表达），测的是
// 「红旗闸门 + 意图（含同义扩展）+ FAQ 检索 + 转人工判定 + 话术合成」这条确定性链。
// 阈值标定（R236 补注③：两侧边界先实测）：本机 300 次实测 p50=0.05ms / p95=0.34ms / max=2.28ms；
// 应通过侧上界 ≈2.3ms，预算取 p95 ≤ 5ms（≈15× p95 余量、≈2× max）——正常抖动碰不到，
// 判定链任何量级退化（如误加 O(n²) 匹配）都会立刻越线。改预算必须先重测两侧再动。
//
// 三态退出码（bench_r89_gate 同纪律）：0=通过 / 1=失败（含读数） / 2=环境不满足（非失败，CI 可 SKIP）。
import { fileURLToPath, pathToFileURL } from "node:url"
import { existsSync } from "node:fs"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const ENTRY = ROOT + "frontend/functions/lib/chat.js"
const P95_BUDGET_MS = 5
const ITERATIONS = 300

if (!existsSync(ENTRY)) {
  console.error("BENCH-CHAT SKIP: 找不到被测入口 frontend/functions/lib/chat.js（不在仓根运行？）")
  process.exit(2)
}

const { handleChat } = await import(pathToFileURL(ENTRY).href)

const CASES = [
  "我要退挂号费",
  "检查报告在哪里看",
  "页面打不开",
  "孩子高热惊厥怎么办",
  "压榨样胸痛冒冷汗",
  "你好",
  "今天天气怎么样",
  "一起床就头重脚轻",
]

// 预热：先跑满一轮用例，让 import/字节码缓存稳定后再计时。
for (const text of CASES) await handleChat({ text, history: [], conversation_id: null, env: {} })

const samples = []
for (let i = 0; i < ITERATIONS; i++) {
  const text = CASES[i % CASES.length]
  const started = performance.now()
  await handleChat({ text, history: [], conversation_id: null, env: {} })
  samples.push(performance.now() - started)
}
samples.sort((a, b) => a - b)
const pick = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]
const p50 = pick(0.5)
const p95 = pick(0.95)
const p99 = pick(0.99)
const max = samples[samples.length - 1]

console.log(`BENCH-CHAT: n=${samples.length} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms 预算 p95≤${P95_BUDGET_MS}ms`)
if (p95 > P95_BUDGET_MS) {
  console.log("[GATE:bench-chat-red] p95 超预算——判定链出现量级退化，先查最近改动再考虑重标定（重标定须附两侧实测）")
  process.exit(1)
}
console.log("[GATE:bench-chat-pass]")
process.exit(0)
