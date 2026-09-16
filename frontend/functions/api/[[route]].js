// Cloudflare Pages Functions 统一路由
// 端点：GET /api/cases · POST /api/intake/ask · POST /api/dx/:id · POST /api/workup/:id · POST /api/report/:id · GET /api/health
// 契约升级：dx/workup/report 均接收完整 history（多轮问诊状态），返回 mode/evidence/fallback_reason
import { getCases, nextIntakeQuestion, buildDiagnosis, buildWorkup, buildReport } from "../lib/engine.js"

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}
function fail(status, msg) {
  return new Response(JSON.stringify({ code: status, message: msg }), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
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

  try {
    if (seg.length === 2 && seg[0] === "api" && seg[1] === "cases" && method === "GET") {
      return json(getCases())
    }
    if (seg[0] === "api" && seg[1] === "intake" && seg[2] === "ask" && method === "POST") {
      const body = await readBody(context)
      return json(await nextIntakeQuestion(body.case_id, body.history || [], env))
    }
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "dx" && method === "POST") {
      const body = await readBody(context)
      return json(await buildDiagnosis(seg[2], body.history || [], env))
    }
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "workup" && method === "POST") {
      const body = await readBody(context)
      return json(await buildWorkup(seg[2], body.history || [], env, body.dx || null))
    }
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "report" && method === "POST") {
      const body = await readBody(context)
      return json(await buildReport(seg[2], body.history || [], env, body.dx || null))
    }
    if ((seg.length === 1 && seg[0] === "health") || (seg.length === 2 && seg[0] === "api" && seg[1] === "health")) {
      return json({ status: "ok", llm_mode: keyPresent(env) ? "live" : "mock-fallback" })
    }
    return fail(404, `not found: ${path}`)
  } catch (e) {
    if (e.message && e.message.startsWith("unknown case")) return fail(404, e.message)
    return fail(500, "服务暂时不可用，请稍后重试")
  }
}

function keyPresent(env = {}) {
  return !!(env?.DEEPSEEK_API_KEY || "")
}
