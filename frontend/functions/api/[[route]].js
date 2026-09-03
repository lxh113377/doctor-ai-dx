// Cloudflare Pages Functions 统一路由（对齐超市web单一后端模式）
// 端点：GET/POST /api/cases · POST /api/intake/ask · POST /api/dx/:id · GET /api/workup/:id · GET /api/report/:id
import { getCases, nextIntakeQuestion, buildDiagnosis, getWorkup, getReport } from "../lib/engine.js"

function json(data, status = 200) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })
}

function fail(status, msg) {
  return new Response(JSON.stringify({ code: status, message: msg }), { status, headers: { "Content-Type": "application/json; charset=utf-8" } })
}

export async function onRequest(context) {
  const url = new URL(context.request.url)
  const path = url.pathname                                   // /api/...
  const seg = path.split("/").filter(Boolean)                 // ["api", "cases"] | ["api","dx","c1"] ...
  const method = context.request.method

  try {
    // GET 列表
    if (seg.length === 2 && seg[0] === "api" && seg[1] === "cases" && method === "GET") {
      return json(getCases())
    }
    // POST 问诊
    if (seg[0] === "api" && seg[1] === "intake" && seg[2] === "ask" && method === "POST") {
      const body = await context.request.json()
      const data = await nextIntakeQuestion(body.case_id, body.history || [], context.env)
      return json(data)
    }
    // POST 诊断（带问诊文本）
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "dx" && method === "POST") {
      const body = await context.request.json()
      const data = await buildDiagnosis(seg[2], body.answer || "", context.env)
      return json(data)
    }
    // GET 诊断（兼容、无文本时用 mock 结论）
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "dx" && method === "GET") {
      return json(await buildDiagnosis(seg[2], "", context.env))
    }
    // GET 检查建议
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "workup" && method === "GET") {
      return json(getWorkup(seg[2]))
    }
    // GET 病历报告
    if (seg.length === 3 && seg[0] === "api" && seg[1] === "report" && method === "GET") {
      return json(getReport(seg[2]))
    }
    // 健康检查（/health 与 /api/health 均可）
    if ((seg.length === 1 && seg[0] === "health") || (seg.length === 2 && seg[0] === "api" && seg[1] === "health")) {
      return json({ status: "ok", llm_mode: keyPresent(context.env) ? "live" : "mock-fallback" })
    }
    return fail(404, `not found: ${path}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown case")) return fail(404, e.message)
    return fail(500, e.message || "internal error")
  }
}

function keyPresent(env = {}) {
  return !!(env?.DEEPSEEK_API_KEY || (typeof DEEPSEEK_API_KEY !== "undefined" && DEEPSEEK_API_KEY))
}