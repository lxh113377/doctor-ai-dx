// 引用链健康门禁：对知识库全部 url 做在线可达性核验，防「引用可溯源」口径静默失效（链接腐烂）。
// 口径：本脚本是**唯一联网门禁**，不进 npm test（离线确定性套件禁网络依赖），由每周 CI 作业与手工触发执行。
// 分级：OK=2xx/3xx 可达；BLOCKED=401/403/412/429/451（存在但拒绝自动化访问，不算腐烂，但须逐个登记进 BLOCKED_REGISTRY，
//       **未登记的被拦源判红**）；DEAD=4xx(除上)/5xx/超时/DNS 失败 = 判失败（须人工处置：换链或降级为未链并同步棘轮）。
// 用法：node tests/link_health.mjs [--json] [--timeout=15000]
import { KNOWLEDGE_BASE } from "../functions/lib/knowledge.js"

const TIMEOUT = parseInt((process.argv.find((a) => a.startsWith("--timeout=")) || "").split("=")[1] || "15000", 10)
const AS_JSON = process.argv.includes("--json")
const BLOCKED = new Set([401, 403, 412, 429, 451])  // 412 实测为 nhc.gov.cn WAF 反爬前置校验（站点存活，非腐烂）
const RETRIES = 2   // 网络抖动重试：DEAD 判定须连续 RETRIES+1 次失败，避免偶发超时误红
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

// BLOCKED 登记册（**按内容登记，不按计数**）：host → 实测状态码与登记日期。
// 为什么改计数基线为白名单：原 `BLOCKED_BASELINE=0` 与实测值 1（nhc.gov.cn 返回 412 WAF）长期不一致，
// 于是每次运行都打印"不得长期悬空"却永远不红——警告失去意义（cry-wolf），且新增被拦源会被同一条噪声淹没。
// 现口径：未登记的被拦 host → 判红（fail-closed，须人工核实后登记或换链）；已登记但已恢复可达 → 提示清理登记。
const BLOCKED_REGISTRY = {
  "www.nhc.gov.cn": { status: 412, since: "2026-09-25", note: "国家卫健委 WAF 反爬前置校验，浏览器可达（站点存活，非腐烂）" },
}

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
  } catch {
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
const hostOf = (u) => { try { return new URL(u).host } catch { return u } }
// 未登记的被拦源：新出现的拒绝访问，必须人工核实（换链 or 确认后登记进 BLOCKED_REGISTRY）
const unregisteredBlocked = blocked.filter((x) => !BLOCKED_REGISTRY[hostOf(x.url)])
// 反向漂移：登记册里的 host 如今可达 = 反爬已解除，登记应清理，否则白名单只增不减会变成掩体
const recoveredEntries = Object.entries(BLOCKED_REGISTRY)
  .filter(([h]) => ok.some((x) => hostOf(x.url) === h))
  .map(([h]) => h)

if (AS_JSON) {
  console.log(JSON.stringify({
    total: rows.length, ok: ok.length, blocked: blocked.length, dead: dead.length,
    unregistered_blocked: unregisteredBlocked.map((x) => x.url), rows,
  }, null, 2))
} else {
  for (const x of rows) console.log(`${x.class.padEnd(7)} ${String(x.status).padEnd(4)} ${x.url}  [${x.ids.join(",")}]${x.note ? " " + x.note : ""}`)
  console.log(`\n链健康：URL ${rows.length} 个（覆盖 ${KNOWLEDGE_BASE.length} 条中的 ${rows.reduce((n, x) => n + x.ids.length, 0)} 条）OK=${ok.length} BLOCKED=${blocked.length} DEAD=${dead.length}`)
  console.log("未回链条目（由 kb_guard 棘轮守门）：" + KNOWLEDGE_BASE.filter((k) => !(k.url || "").trim()).length + " 条")
}
if (blocked.length) {
  console.log(`BLOCKED ${blocked.length} 个（存在但拒绝自动化访问，不计腐烂）：` +
    blocked.map((x) => `${x.url}(${x.status}${BLOCKED_REGISTRY[hostOf(x.url)] ? "·已登记" : "·未登记"})`).join(" "))
}
if (recoveredEntries.length) {
  console.log(`ℹ️ 登记册可清理：${recoveredEntries.join(", ")} 现已可达，请核实后从 BLOCKED_REGISTRY 删除（防白名单只增不减变掩体）`)
}
if (unregisteredBlocked.length) {
  console.log(`FAIL 发现 ${unregisteredBlocked.length} 个**未登记**的拒绝访问源 → 逐个核实站点是否变更：仍存活则连状态码登记进 BLOCKED_REGISTRY（附实测日期与理由），已变更则换链或按 kb_guard 棘轮改回未链`)
  console.log("   清单：" + unregisteredBlocked.map((x) => `${x.url}(${x.status})`).join(" "))
  process.exitCode = 1
}
if (dead.length) {
  console.log(`FAIL 发现 ${dead.length} 个死链 → 必须换链或按 kb_guard 棘轮把该条目改回未链（禁止留假链接）`)
  process.exitCode = 1
} else if (!unregisteredBlocked.length) {
  console.log("[GATE:citation-links-pass] 零死链 + 被拦源全部已登记")
}
