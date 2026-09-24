// 路由可观测性契约：每请求一个可对账编号、错误响应零泄漏、日志可归因。
// 直接调用 Pages Functions 的 onRequest（Node 有 Request/Response 全局），无需部署或云账号。
import { onRequest } from "../functions/api/[[route]].js"
import { redact, newRequestId } from "../functions/lib/observe.js"

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const ID_RE = /^[0-9a-f]{4,12}$/
const LEAK_RE = /(at\s+\S+\s+\(|file:\/\/|[A-Za-z]:\\|Traceback|DEEPSEEK_API_KEY|sk-[A-Za-z0-9]{8,})/

const ctx = (path, init) => ({ request: new Request(`https://dx.test${path}`, init), env: {} })
const readJson = async (res) => JSON.parse(await res.text())

console.log("== 正常链路 ==")
const ok = await onRequest(ctx("/api/cases"))
const okBody = await readJson(ok)
const okId = ok.headers.get("x-request-id") || ""
check("GET /api/cases 200 且 code=0", ok.status === 200 && okBody.code === 0)
check("响应头带 X-Request-Id", ID_RE.test(okId), `实测 ${JSON.stringify(okId)}`)

const health = await onRequest(ctx("/api/health"))
const healthId = health.headers.get("x-request-id") || ""
check("health 亦带编号且与相邻请求不重复", ID_RE.test(healthId) && healthId !== okId)

console.log("== 404 与错误归因 ==")
const notFound = await onRequest(ctx("/api/nope"))
check("未知路径 404", notFound.status === 404 && ID_RE.test(notFound.headers.get("x-request-id") || ""))

const logs = []
const realError = console.error
console.error = (...args) => { logs.push(args.join(" ")) }
let internalErr = null
try {
  // history 传字符串 → 引擎内部抛非业务异常，走 500 兜底分支
  internalErr = await onRequest(ctx("/api/dx/c1", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: "boom" }),
  }))
} finally {
  console.error = realError
}
const errId = internalErr?.headers.get("x-request-id") || ""
const errBody = internalErr ? await readJson(internalErr) : {}
check("未预期异常返回 500", internalErr?.status === 500, `实测 ${internalErr?.status}`)
check("500 文案含可对账故障编号", typeof errBody.message === "string" && errBody.message.includes(errId) && errId.length >= 4,
  `msg=${JSON.stringify(errBody.message)} id=${errId}`)
check("500 响应体零泄漏（无堆栈/路径/密钥）", !LEAK_RE.test(JSON.stringify(errBody)), JSON.stringify(errBody).slice(0, 160))
check("服务端日志落了一条 error 且 req 与故障编号一致",
  logs.some((line) => { try { const j = JSON.parse(line); return j.lvl === "error" && j.req === errId } catch { return false } }),
  logs.slice(0, 2).join(" | "))
check("日志不含请求体原文（防病例文本入日志）",
  logs.every((line) => !line.includes("boom")))

console.log("== 脱敏函数 ==")
check("sk- 形态密钥被脱敏", !/sk-[A-Za-z0-9]{8,}/.test(redact("header: sk-abcdefghijklmnopqrstuvwxyz")))
check("环境密钥原文被脱敏", redact("failed with abcdef123456", { DEEPSEEK_API_KEY: "abcdef123456" }).includes("[已脱敏]"))
check("内部路径被替换", redact("at run (C:\\Users\\secret\\app\\engine.js:1:1)").includes("[内部路径]"))
check("超长信息被截断", redact("x".repeat(900)).length <= 300)
check("编号形态稳定", ID_RE.test(newRequestId()) && new Set([newRequestId(), newRequestId(), newRequestId()]).size >= 2)

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
