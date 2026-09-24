// Cloudflare Pages Functions 统一路由
// 端点：GET /api/cases · POST /api/intake/ask · POST /api/dx/:id · POST /api/workup/:id · POST /api/report/:id · GET /api/health
// 契约升级：dx/workup/report 均接收完整 history（多轮问诊状态），返回 mode/evidence/fallback_reason
import { getCases, nextIntakeQuestion, buildDiagnosis, buildWorkup, buildReport } from "../lib/engine.js"
import { newRequestId, redact, logEvent, withRequestId, SLOW_MS } from "../lib/observe.js"
import { APP_VERSION } from "../lib/version.js"

function json(data, status = 200, requestId) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status, headers: withRequestId({ "Content-Type": "application/json; charset=utf-8" }, requestId),
  })
}
function fail(status, msg, requestId) {
  return new Response(JSON.stringify({ code: status, message: msg }), {
    status, headers: withRequestId({ "Content-Type": "application/json; charset=utf-8" }, requestId),
  })
}

async function readBody(context) {
  try { return await context.request.json() } catch { return {} }
}

export async function onRequest(context) {
  const url = new URL(context.request.url)
  const path = url.pathname
  const seg = path.split("/").filter(Boolean)
  const method = context.request.method
  const env = context.env
  const requestId = newRequestId()
  const startedAt = Date.now()

  try {
    let response
    if (seg.length === 2 && seg[0] === "api" && seg[1] === "cases" && method === "GET") {
      response = json(getCases(), 200, requestId)
    } else if (seg[0] === "api" && seg[1] === "intake" && seg[2] === "ask" && method === "POST") {
      const body = await readBody(context)
      response = json(await nextIntakeQuestion(body.case_id, body.history || [], env), 200, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "dx" && method === "POST") {
      const body = await readBody(context)
      response = json(await buildDiagnosis(seg[2], body.history || [], env), 200, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "workup" && method === "POST") {
      const body = await readBody(context)
      response = json(await buildWorkup(seg[2], body.history || [], env, body.dx || null), 200, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "report" && method === "POST") {
      const body = await readBody(context)
      response = json(await buildReport(seg[2], body.history || [], env, body.dx || null), 200, requestId)
    } else if ((seg.length === 1 && seg[0] === "health") || (seg.length === 2 && seg[0] === "api" && seg[1] === "health")) {
      response = json({ status: "ok", llm_mode: keyPresent(env) ? "live" : "mock-fallback", version: APP_VERSION }, 200, requestId)
    } else {
      response = fail(404, `not found: ${path}`, requestId)
    }
    // 慢请求留痕：不改响应，只补一条可归因日志（性能回归的第一手证据）
    const ms = Date.now() - startedAt
    if (ms > SLOW_MS) logEvent("warn", { req: requestId, path, method, ms, mode: keyPresent(env) ? "live" : "mock" })
    return response
  } catch (e) {
    const ms = Date.now() - startedAt
    // 只落归因最小集：不写 stack、不写请求体（可能含病例文本）
    logEvent("error", {
      req: requestId, path, method, ms,
      kind: e?.name || "Error",
      msg: redact(e?.message, env),
    })
    if (e?.message && e.message.startsWith("unknown case")) return fail(404, e.message, requestId)
    return fail(500, `服务暂时不可用，请稍后重试（故障编号 ${requestId}）`, requestId)
  }
}

function keyPresent(env = {}) {
  return !!(env?.DEEPSEEK_API_KEY || "")
}
