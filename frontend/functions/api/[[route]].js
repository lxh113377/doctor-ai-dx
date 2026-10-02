// Cloudflare Pages Functions 统一路由
// 端点：GET /api/cases · POST /api/intake/ask · POST /api/dx/:id · POST /api/workup/:id · POST /api/report/:id · GET /api/health
// 契约升级：dx/workup/report 均接收完整 history（多轮问诊状态），返回 mode/evidence/fallback_reason
import { getCases, nextIntakeQuestion, buildDiagnosis, buildWorkup, buildReport } from "../lib/engine.js"
import { newRequestId, redact, logEvent, withRequestId, SLOW_MS } from "../lib/observe.js"
import { APP_VERSION } from "../lib/version.js"
import { assertDeclaredSize, parseBoundedBody } from "../lib/limits.js"
import { handleChat } from "../lib/chat.js"
import { authorizeAdmin } from "../lib/admin_auth.js"
import {
  listConversations,
  getConversationDetail,
  listHandoffs,
  satisfactionStats,
  topUnresolved,
  setFeedback,
} from "../lib/chat_store.js"

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

// 滥用护栏：先看 Content-Length（第一道，可伪造），读出正文后按实际字节与条数复核。
// 此前这里是 `catch { return {} }`——坏 JSON 被静默接受并继续消耗引擎与 LLM 窗口，现在显式 400/413。
async function readBody(context) {
  assertDeclaredSize(context.request.headers.get("content-length"))
  return parseBoundedBody(await context.request.text())
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
    } else if (seg.length === 2 && seg[0] === "api" && seg[1] === "health") {
      // 第八十五轮删掉了这里原有的 `seg.length === 1 && seg[0] === "health"` 分支：本文件在 Pages 里
      // 只挂 /api/*（functions/api/[[route]].js ⇒ 路由 /api/*），裸 /health **永远到不了这里**。
      // 一手取证（2026-10-01 现跑）：curl https://doctor-ai-dx.pages.dev/health 回 text/html 的 SPA
      // 首页，/api/health 才回 JSON；而 route_guard 直调 onRequest 传 "/health" 是**构造出来的 URL**，
      // 测得到那条走不到的分支＝守卫给假绿。镜像面 backend/app/main.py 的裸 /health 是真路由
      // （容器 healthcheck 用），两端此处**刻意不对称**，口径写进 docs/ARCHITECTURE.md 的对账矩阵。
      response = json({ status: "ok", llm_mode: keyPresent(env) ? "live" : "mock-fallback", version: APP_VERSION }, 200, requestId)
    } else if (seg.length === 2 && seg[0] === "api" && seg[1] === "chat" && method === "POST") {
      const body = await readBody(context)
      response = json(await handleChat({
        text: body.text,
        history: body.history || [],
        conversation_id: body.conversation_id || null,
        env,
      }), 200, requestId)
    } else if (seg.length === 4 && seg[0] === "api" && seg[1] === "chat" && seg[3] === "feedback" && method === "POST") {
      // 满意度打分：越界由 store 层拒绝并回 422，不静默截断（静默截断会让统计失真而无人察觉）
      const body = await readBody(context)
      const r = await setFeedback(env, {
        conversation_id: seg[2],
        score: body.score,
        tag: body.tag || "",
        comment: body.comment || "",
      })
      response = r.persisted ? json({ conversation_id: seg[2], satisfaction: Number(body.score) }, 200, requestId) : fail(422, "评分无效或存储不可用，请稍后重试", requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "chat" && method === "GET") {
      const detail = await getConversationDetail(env, seg[2])
      if (!detail.available) response = json({ available: false, reason: detail.reason }, 200, requestId)
      else if (!detail.found) response = fail(404, `not found: ${path}`, requestId)
      else response = json(detail, 200, requestId)
    } else if (seg.length === 4 && seg[0] === "api" && seg[1] === "admin" && seg[2] === "conversations" && method === "GET") {
      const auth = authorizeAdmin(context.request, env)
      response = auth.ok ? json(await getConversationDetail(env, seg[3]), 200, requestId) : fail(auth.status, auth.message, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "admin" && seg[2] === "conversations" && method === "GET") {
      const auth = authorizeAdmin(context.request, env)
      response = auth.ok
        ? json(await listConversations(env, { limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }), 200, requestId)
        : fail(auth.status, auth.message, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "admin" && seg[2] === "handoffs" && method === "GET") {
      const auth = authorizeAdmin(context.request, env)
      response = auth.ok ? json(await listHandoffs(env, { limit: url.searchParams.get("limit") }), 200, requestId) : fail(auth.status, auth.message, requestId)
    } else if (seg.length === 3 && seg[0] === "api" && seg[1] === "admin" && seg[2] === "stats" && method === "GET") {
      const auth = authorizeAdmin(context.request, env)
      response = auth.ok
        ? json({ ...(await satisfactionStats(env)), top_unresolved: (await topUnresolved(env)).items || [] }, 200, requestId)
        : fail(auth.status, auth.message, requestId)
    } else {
      response = fail(404, `not found: ${path}`, requestId)
    }
    // 慢请求留痕：不改响应，只补一条可归因日志（性能回归的第一手证据）
    const ms = Date.now() - startedAt
    if (ms > SLOW_MS) logEvent("warn", { req: requestId, path, method, ms, mode: keyPresent(env) ? "live" : "mock" })
    return response
  } catch (e) {
    const ms = Date.now() - startedAt
    // 入站边界拒绝：客户端错误**不得**记成服务端 error（否则滥用流量会把错误日志刷成噪声，掩盖真故障）。
    // 对外只出医生可理解文案；reason 只进日志，且只含数值与字段名，不含病例文本。
    if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
      logEvent("warn", { req: requestId, path, method, ms, kind: e.name, msg: e.reason })
      // 422 与镜像面 `RequestValidationError` 逐字同文案（含故障编号）；413/400 维持既有对外口径不带编号
      const msg = e.withFailureId ? `${e.message}（故障编号 ${requestId}）` : e.message
      return fail(e.status, msg, requestId)
    }
    // 到这里才是"真故障"档：日志级别与响应码同源（4xx 已在上面分流，不会走到这条 error）
    logEvent("error", {
      req: requestId, path, method, ms,
      kind: e?.name || "Error",
      msg: redact(e?.message, env),
    })
    return fail(500, `服务暂时不可用，请稍后重试（故障编号 ${requestId}）`, requestId)
  }
}

function keyPresent(env = {}) {
  return !!(env?.DEEPSEEK_API_KEY || "")
}
