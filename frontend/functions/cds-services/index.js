// GET /cds-services —— CDS Hooks 服务发现端点（规范 2.0：Discovery，固定路径，无信封）
// 路由归属：Cloudflare Pages 按文件路径映射（functions/cds-services/index.js → /cds-services）。
// 方法处理与 /api 面同口径：只认 GET，其余落到 404 not found（本仓不引入 405——它会成为
// docs/ERRORS.md ⇄ openapi 双向对账里的第四个新码，而"方法不对"在既有契约里本来就是 404）。
import { discoveryDocument } from "../lib/cds_hooks.js"
import { specJson, cdsFail, cdsHandleError, cdsRequestId } from "../lib/cds_http.js"
import { assertDeclaredSize } from "../lib/limits.js"

export async function onRequest(context) {
  const url = new URL(context.request.url)
  const path = url.pathname
  const method = context.request.method
  const requestId = cdsRequestId()
  const startedAt = Date.now()
  try {
    if (method !== "GET") return cdsFail(404, `not found: ${path}`, requestId)
    assertDeclaredSize(context.request.headers.get("content-length"))
    return specJson(discoveryDocument(), requestId)
  } catch (e) {
    return cdsHandleError(e, { requestId, path, method, ms: Date.now() - startedAt, env: context.env })
  }
}
