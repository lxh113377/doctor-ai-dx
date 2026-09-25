// 路由可观测性契约：每请求一个可对账编号、错误响应零泄漏、日志可归因。
// 直接调用 Pages Functions 的 onRequest（Node 有 Request/Response 全局），无需部署或云账号。
import { onRequest } from "../functions/api/[[route]].js"
import { logEvent, newRequestId, redact, withRequestId } from "../functions/lib/observe.js"

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
const nfBody = await readJson(notFound)
check("未知路径 404", notFound.status === 404 && ID_RE.test(notFound.headers.get("x-request-id") || ""))
// 错误体形态是双端契约的一部分：后端镜像此前吐 {"detail":...}，与权威面不同形（第十四轮实测抓出）。
// 权威面这边把 {code,message} 钉住，两端同一判据，谁改坏谁判红。
check("未知路径 404 为 {code,message}（权威面契约基准）",
  nfBody.code === 404 && nfBody.message === "not found: /api/nope" && !("detail" in nfBody),
  JSON.stringify(nfBody).slice(0, 140))
const badCase = await onRequest(ctx("/api/dx/nope", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: "nope", history: [] }),
}))
const badCaseBody = await readJson(badCase)
check("未知病例 404 且 message 可读（不含堆栈/路径）",
  badCase.status === 404 && badCaseBody.code === 404 && !LEAK_RE.test(JSON.stringify(badCaseBody)),
  JSON.stringify(badCaseBody).slice(0, 140))

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

console.log("== 入站边界（v1.17.0 滥用护栏）==")
const big = JSON.stringify({ case_id: "c1", history: Array.from({ length: 70 }, () => ({ role: "user", content: "腹" })) })
const over = await onRequest(ctx("/api/dx/c1", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: big,
}))
const overBody = await readJson(over)
check("history 超条数 → 413（不再是 200）", over.status === 413, `实测 ${over.status}`)
check("413 仍带 X-Request-Id（可对账）", ID_RE.test(over.headers.get("x-request-id") || ""))
check("413 code 等于状态码且文案医生可读", overBody.code === 413 && /请精简问诊记录后重试/.test(overBody.message) && !overBody.message.includes(">"),
  JSON.stringify(overBody))

const broken = await onRequest(ctx("/api/dx/c1", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops",
}))
const brokenBody = await readJson(broken)
check("坏 JSON → 400（此前被 catch 静默吞成 {} 继续跑引擎）", broken.status === 400 && brokenBody.code === 400, `实测 ${broken.status}`)

const logs413 = []
const realErr2 = console.error
const realWarn2 = console.warn
console.error = (...a) => logs413.push(a.join(" "))
console.warn = (...a) => logs413.push(a.join(" "))
try {
  await onRequest(ctx("/api/dx/c1", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history: Array.from({ length: 70 }, () => ({ role: "user", content: "腹" })) }),
  }))
} finally { console.error = realErr2; console.warn = realWarn2 }
check("413 不得产生 error 级日志（滥用流量不得淹没真故障）",
  !logs413.some((l) => { try { return JSON.parse(l).lvl === "error" } catch { return false } }), logs413.slice(0, 1).join(" | "))
check("413 日志只含数值与字段名，不含请求体原文",
  logs413.every((l) => !l.includes("腹")), "日志里出现了病例文本即隐私外泄")

console.log("== 脱敏函数 ==")
check("sk- 形态密钥被脱敏", !/sk-[A-Za-z0-9]{8,}/.test(redact("header: sk-abcdefghijklmnopqrstuvwxyz")))
check("环境密钥原文被脱敏", redact("failed with abcdef123456", { DEEPSEEK_API_KEY: "abcdef123456" }).includes("[已脱敏]"))
check("内部路径被替换", redact("at run (C:\\Users\\secret\\app\\engine.js:1:1)").includes("[内部路径]"))
check("超长信息被截断", redact("x".repeat(900)).length <= 300)
check("编号形态稳定", ID_RE.test(newRequestId()) && new Set([newRequestId(), newRequestId(), newRequestId()]).size >= 2)

console.log("== 可观测性兜底分支（第十四轮补：无 crypto / 空入参 / 非 error 级别）==")
// 空入参：日志里出现 undefined 字面量会让归因检索直接失配，必须归一为空串
check("redact(undefined) 与 redact(null) 归一为空串", redact(undefined) === "" && redact(null) === "",
  `实测 ${JSON.stringify(redact(undefined))}/${JSON.stringify(redact(null))}`)
check("redact 不吞非字符串入参（数字/对象先字符串化）",
  redact(42) === "42" && redact({ a: 1 }) === "[object Object]", `实测 ${JSON.stringify(redact(42))}`)
// 无 randomUUID 环境（老运行时/被裁剪的 crypto）：走 Math+Date 回退，仍须可用作故障编号
{
  const realCrypto = globalThis.crypto
  try {
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true })
    const fb = newRequestId()
    check("无 crypto.randomUUID 时回退编号仍非空且小写", /^[0-9a-z]{6,12}$/.test(fb), `实测 ${JSON.stringify(fb)}`)
    check("回退编号两次不同（可作故障编号）", newRequestId() !== newRequestId())
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true })
  }
  check("crypto 回退测试后已复原（不污染后续用例）",
    typeof globalThis.crypto?.randomUUID === "function" && ID_RE.test(newRequestId()))
}
// 非 error 级别日志：warn/info 分支未跑过 = 上线后这两级日志格式从未被验证
{
  const captured = { warn: [], log: [] }
  const realWarn = console.warn
  const realLog = console.log
  try {
    console.warn = (...a) => captured.warn.push(a.join(" "))
    console.log = (...a) => captured.log.push(a.join(" "))
    logEvent("warn", { req: "w1", ms: 12 })
    logEvent("info", { req: "i1", kind: "dx" })
  } finally {
    console.warn = realWarn
    console.log = realLog
  }
  const w = (() => { try { return JSON.parse(captured.warn[0]) } catch { return null } })()
  const i = (() => { try { return JSON.parse(captured.log[0]) } catch { return null } })()
  check("warn 走 console.warn 且为单行 JSON", captured.warn.length === 1 && w?.lvl === "warn" && w?.req === "w1",
    captured.warn.join("|"))
  check("info 走 console.log（不占 error 通道）", captured.log.length === 1 && i?.lvl === "info" && i?.app === "doctor-ai-dx",
    captured.log.join("|"))
}
// 响应头工厂：无入参与无编号两条分支
{
  const bare = withRequestId()
  check("withRequestId 无入参可调用且不塞默认编号",
    bare instanceof Headers && bare.get("x-request-id") === null)
  const withId = withRequestId({ "Content-Type": "application/json" }, "abc123")
  check("withRequestId 保留原头并写入编号",
    withId.get("content-type") === "application/json" && withId.get("x-request-id") === "abc123")
}

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
