// 引用链健康门禁：对知识库全部 url 做在线可达性核验，防「引用可溯源」口径静默失效（链接腐烂）。
// 口径：本脚本是**唯一联网门禁**，不进 npm test（离线确定性套件禁网络依赖），由每周 CI 作业与手工触发执行。
// 分级：OK=2xx/3xx 可达；BLOCKED=401/403/429（存在但拒绝自动化访问，不算腐烂，按基线只报不红）；
//       DEAD=4xx(除上)/5xx/超时/DNS 失败 = 判失败（fail-closed，须人工处置：换链或降级为未链并同步棘轮）。
// 用法：node tests/link_health.mjs [--json] [--timeout=15000]
import { readFileSync } from "node:fs"
import { KNOWLEDGE_BASE } from "../functions/lib/knowledge.js"

const TIMEOUT = parseInt((process.argv.find((a) => a.startsWith("--timeout=")) || "").split("=")[1] || "15000", 10)
const AS_JSON = process.argv.includes("--json")
const BLOCKED = new Set([401, 403, 412, 429, 451])  // 412 实测为 nhc.gov.cn WAF 反爬前置校验（站点存活，非腐烂）
const RETRIES = 2   // 网络抖动重试：DEAD 判定须连续 RETRIES+1 次失败，避免偶发超时误红
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

// BLOCKED 基线：2026-09-25 首跑实测值。允许「只增不减」观察，超过基线才提示复核（防把反爬误判成腐烂）
const BLOCKED_BASELINE = Number(process.env.BLOCKED_BASELINE || 0)

async function probe(url) {
  const hit = async (method) => {
    const r = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { "User-Agent": UA, Accept: "*/*" },
    })
    return { status: r.status, finalUrl: r.url }
  }
  try {
    let r = await hit("HEAD")
    // 部分站点不支持 HEAD（405/501）→ 回退 GET 再判，避免假 DEAD
    if (r.status === 405 || r.status === 501) r = await hit("GET")
    return r
  } catch (e) {
    try {
      return await hit("GET")
    } catch (e2) {
      return { status: 0, error: String(e2 && e2.name ? e2.name + ":" + e2.message : e2).slice(0, 90) }
    }
  }
}

const targets = [...new Set(KNOWLEDGE_BASE.map((k) => (k.url || "").trim()).filter(Boolean))]
const rows = []
for (const url of targets) {
  const ids = KNOWLEDGE_BASE.filter((k) => (k.url || "").trim() === url).map((k) => k.id)
  let r = await probe(url)
  for (let i = 0; i < RETRIES && !(r.status >= 200 && r.status < 400) && !BLOCKED.has(r.status); i++) {
    r = await probe(url)   // 非存活且非拒绝类 → 重试，仍失败才判 DEAD
  }
  const cls = r.status >= 200 && r.status < 400 ? "OK" : BLOCKED.has(r.status) ? "BLOCKED" : "DEAD"
  rows.push({ url, ids, class: cls, status: r.status, note: r.error || (r.finalUrl && r.finalUrl !== url ? "→ " + new URL(r.finalUrl).host : "") })
}

const dead = rows.filter((x) => x.class === "DEAD")
const blocked = rows.filter((x) => x.class === "BLOCKED")
const ok = rows.filter((x) => x.class === "OK")

if (AS_JSON) {
  console.log(JSON.stringify({ total: rows.length, ok: ok.length, blocked: blocked.length, dead: dead.length, rows }, null, 2))
} else {
  for (const x of rows) console.log(`${x.class.padEnd(7)} ${String(x.status).padEnd(4)} ${x.url}  [${x.ids.join(",")}]${x.note ? " " + x.note : ""}`)
  console.log(`\n链健康：URL ${rows.length} 个（覆盖 ${KNOWLEDGE_BASE.length} 条中的 ${rows.reduce((n, x) => n + x.ids.length, 0)} 条）OK=${ok.length} BLOCKED=${blocked.length} DEAD=${dead.length}`)
  console.log("未回链条目（由 kb_guard 棘轮守门）：" + KNOWLEDGE_BASE.filter((k) => !(k.url || "").trim()).length + " 条")
}
if (blocked.length > BLOCKED_BASELINE) {
  console.log(`⚠️ BLOCKED ${blocked.length} > 基线 ${BLOCKED_BASELINE}：新增拒绝访问的源，须人工确认站点是否变更（不计腐烂，但不得长期悬空）`)
  console.log("   清单：" + blocked.map((x) => `${x.url}(${x.status})`).join(" "))
}
if (dead.length) {
  console.log(`FAIL 发现 ${dead.length} 个死链 → 必须换链或按 kb_guard 棘轮把该条目改回未链（禁止留假链接）`)
  process.exitCode = 1
} else {
  console.log("[GATE:citation-links-pass] 零死链")
}
