// CDS Hooks 路由族共用的 HTTP 外壳（第八十五轮）
// 为什么不复用 api/[[route]].js 里的 json()：那边的**成功响应**是自研信封 {code:0,data}，
// 而 CDS Hooks 规范规定的成功响应体是裸对象 {services:[...]} / {cards:[...]}——套信封就等于发一个
// 不合规的文档（集成方的客户端会解析不到 services 键）。**错误响应**仍沿用仓内 {code,message} 形，
// 因为规范没给错误体定义，而仓内已有三条判据（route_guard / error_parity / ERRORS.md⇄openapi 双向）钉着它。
import { newRequestId, withRequestId, logEvent, redact } from "./observe.js"

export function specJson(data, requestId) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: withRequestId({ "Content-Type": "application/json; charset=utf-8" }, requestId),
  })
}

export function cdsFail(status, msg, requestId) {
  return new Response(JSON.stringify({ code: status, message: msg }), {
    status, headers: withRequestId({ "Content-Type": "application/json; charset=utf-8" }, requestId),
  })
}

/**
 * 4xx/5xx 分流与 /api 面同源：客户端错误**不得**记成服务端 error（滥用流量刷 error 日志会掩盖真故障），
 * 422 带故障编号（沿用 limits.RequestBadShape.withFailureId 的既有对外口径），5xx 只出医生可读文案。
 */
export function cdsHandleError(e, { requestId, path, method, ms, env }) {
  // 404（未知服务）也是 4xx，与 422/413/400 同一条分流；NotFound 的 status=404 由 lib/cds_hooks.js 定。
  if (typeof e?.status === "number" && e.status >= 400 && e.status < 500) {
    logEvent("warn", { req: requestId, path, method, ms, kind: e?.name, msg: e?.reason })
    // 404 的对外句子由**请求路径**拼装（`not found: /cds-services/<id>`），与镜像面
    // main.http_error 对默认 "Not Found" 的改写逐字同形；其余 4xx 用异常自带的文案。
    if (e.status === 404) return cdsFail(404, `not found: ${path}`, requestId)
    const msg = e.withFailureId ? `${e.message}（故障编号 ${requestId}）` : e.message
    return cdsFail(e.status, msg, requestId)
  }
  logEvent("error", { req: requestId, path, method, ms, kind: e?.name || "Error", msg: redact(e?.message, env) })
  return cdsFail(500, `服务暂时不可用，请稍后重试（故障编号 ${requestId}）`, requestId)
}

export function cdsRequestId() {
  return newRequestId()
}
