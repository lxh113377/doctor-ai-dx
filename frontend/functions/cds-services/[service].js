// POST /cds-services/{service} —— CDS Hooks 调用端点（规范 2.0：Calling a CDS Service）
// 请求体按规范带 hook / hookInstance / context（可选 prefetch / fhirServer / fhirAuthorization）；
// 本服务不访问任何 FHIR 服务器，也不消费 prefetch，因此 discovery 里每个服务都不声明 prefetch 字段，
// 并在 usageRequirements 里把"文字要放哪儿"写清（规范原文：usageRequirements 是前置条件的人类可读位）。
import { invokeService } from "../lib/cds_hooks.js"
import { specJson, cdsFail, cdsHandleError, cdsRequestId } from "../lib/cds_http.js"
import { assertDeclaredSize, parseBoundedBody } from "../lib/limits.js"

export async function onRequest(context) {
  const url = new URL(context.request.url)
  const path = url.pathname
  const seg = path.split("/").filter(Boolean)
  const method = context.request.method
  const requestId = cdsRequestId()
  const startedAt = Date.now()
  try {
    if (method !== "POST" || seg.length !== 2 || seg[0] !== "cds-services") {
      return cdsFail(404, `not found: ${path}`, requestId)
    }
    assertDeclaredSize(context.request.headers.get("content-length"))
    const body = await parseBoundedBody(await context.request.text())
    return specJson(invokeService(seg[1], body), requestId)
  } catch (e) {
    return cdsHandleError(e, { requestId, path, method, ms: Date.now() - startedAt, env: context.env })
  }
}
