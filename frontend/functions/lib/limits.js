// API 滥用护栏（v1.17.0 第十九轮）——双端同源数值，权威清单 = tests/fixtures/request_limits.json
// 为什么必须存在（对标实测）：同类项目对请求体一律有显式上界（ragflow 的 docker/nginx/nginx.conf
// 设 `client_max_body_size 1024M`；OpenEMR 走 PHP/Apache 上传上限）。我方权威面是 Cloudflare Pages，
// 边缘没有 nginx，所以**上界只能在 Functions 应用层实现**；此前双端零上限，且 readBody 用
// `catch { return {} }` 把解析失败静默吞成空对象——坏请求不但被接受，还继续消耗引擎与 LLM 窗口。
// 上限取值不是随手整数：实测本仓合法峰值 body 510 B / history 5 条 ⇒ 取 128x 余量。
// 红线：本模块只做**入站边界**，不参与诊断/红旗/引用判定（三条产品红线零改动）。

export const MAX_BODY_BYTES = 65536 // 64 KiB：合法峰值 510 B 的 128 倍
export const MAX_HISTORY_ITEMS = 64 // 合法峰值 5 轮的 12.8 倍，同时挡住长数组放大
export const MAX_CONTENT_CHARS = 2000 // 单条问诊文本上界（临床主诉/追问转录远小于此）
export const MAX_DX_JSON_BYTES = 65536 // workup/report 会回传前端已生成的 dx，同样设界

export const STATUS_TOO_LARGE = 413
export const STATUS_BAD_JSON = 400

/** 超限：响应只出医生可理解文案，不外泄内部计算细节 */
export class RequestTooLarge extends Error {
  constructor(reason) {
    super("请求内容超出可处理范围，请精简问诊记录后重试")
    this.name = "RequestTooLarge"
    this.reason = reason // 仅进服务端日志，不进响应体
    this.status = STATUS_TOO_LARGE
  }
}

export class RequestBadJson extends Error {
  constructor(reason) {
    super("请求内容无法解析，请刷新页面后重试")
    this.name = "RequestBadJson"
    this.reason = reason
    this.status = STATUS_BAD_JSON
  }
}

// Content-Length 只是**第一道**（可伪造），所以正文读出来后再按实际字节复核
export function assertDeclaredSize(contentLengthHeader) {
  const declared = Number.parseInt(contentLengthHeader || "", 10)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RequestTooLarge(`content-length ${declared} > ${MAX_BODY_BYTES}`)
  }
}

export function byteLength(text) {
  return new TextEncoder().encode(text || "").length
}

function boundedText(value, where) {
  if (typeof value !== "string") return
  if (value.length > MAX_CONTENT_CHARS) throw new RequestTooLarge(`${where} 长度 ${value.length} > ${MAX_CONTENT_CHARS}`)
}

export function assertHistoryShape(history) {
  if (history === undefined || history === null) return
  if (!Array.isArray(history)) return // 非数组交给引擎既有分支（保持双端 500 语义不变）
  if (history.length > MAX_HISTORY_ITEMS) {
    throw new RequestTooLarge(`history 条数 ${history.length} > ${MAX_HISTORY_ITEMS}`)
  }
  history.forEach((m, i) => {
    if (m && typeof m === "object") boundedText(m.content, `history[${i}].content`)
  })
}

/** 解析并校验请求体。空体仍返回 {}（与既有契约一致，不在本轮改动行为）；坏 JSON 不再静默通过。 */
export function parseBoundedBody(text) {
  const raw = text || ""
  if (raw === "") return {}
  const actual = byteLength(raw)
  if (actual > MAX_BODY_BYTES) throw new RequestTooLarge(`body ${actual} > ${MAX_BODY_BYTES}`)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new RequestBadJson(`json 解析失败：${e?.name || "Error"}`)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequestBadJson("body 不是 JSON 对象")
  }
  assertHistoryShape(parsed.history)
  if (parsed.dx !== undefined && parsed.dx !== null) {
    const dxBytes = byteLength(JSON.stringify(parsed.dx))
    if (dxBytes > MAX_DX_JSON_BYTES) throw new RequestTooLarge(`dx ${dxBytes} > ${MAX_DX_JSON_BYTES}`)
    boundedText(parsed.dx?.conclusion, "dx.conclusion")
    ;(parsed.dx?.evidence || []).slice(0, MAX_HISTORY_ITEMS).forEach((ev, i) => {
      if (ev && typeof ev === "object") boundedText(ev.text, `dx.evidence[${i}].text`)
    })
  }
  return parsed
}
