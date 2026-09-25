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
// 422＝"JSON 合法但语义不合"（HTTP 语义上比 400 精确，且与镜像面 FastAPI 的校验失败同码）。
// 第二十一轮消掉台账#28：此前 `history:"boom"` 在权威面穿透到引擎→**500**，镜像面 422，
// 双端差异被测试钉了两个月而不是修掉。500 用在客户端错误上会污染服务端故障口径
// （滥用流量刷成 error 日志＝掩盖真故障，正是 r19 立 4xx 不记 error 的理由），故收敛到 422。
export const STATUS_BAD_SHAPE = 422

// 对外文案常量（镜像面 backend/app/limits.py 有同名同值件；由 tests/limits_guard.mjs 逐字对账，
// 理由同 r20 把 413 文案提成常量：**能逐字比对的东西才谈得上判据**，靠"两处各写一遍中文"必然漂）
export const TOO_LARGE_MESSAGE = "请求内容超出可处理范围，请精简问诊记录后重试"
export const BAD_JSON_MESSAGE = "请求内容无法解析，请刷新页面后重试"
export const BAD_SHAPE_MESSAGE = "请求参数不完整，请刷新后重试"

/** 超限：响应只出医生可理解文案，不外泄内部计算细节 */
export class RequestTooLarge extends Error {
  constructor(reason) {
    super(TOO_LARGE_MESSAGE)
    this.name = "RequestTooLarge"
    this.reason = reason // 仅进服务端日志，不进响应体
    this.status = STATUS_TOO_LARGE
  }
}

export class RequestBadJson extends Error {
  constructor(reason) {
    super(BAD_JSON_MESSAGE)
    this.name = "RequestBadJson"
    this.reason = reason
    this.status = STATUS_BAD_JSON
  }
}

/**
 * 结构不合规（类型对不上契约）。对外文案与镜像面 `main.invalid_request` 逐字同值，
 * 故障编号由路由追加（`请求参数不完整，请刷新后重试（故障编号 xxx）`）。
 */
export class RequestBadShape extends Error {
  constructor(reason) {
    super(BAD_SHAPE_MESSAGE)
    this.name = "RequestBadShape"
    this.reason = reason
    this.status = STATUS_BAD_SHAPE
    this.withFailureId = true // 路由据此追加故障编号（413/400 不带，保持既有对外口径）
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
  // 契约 `history: list[dict]`（镜像面 models.IntakeAskRequest 由 pydantic 强校验 ⇒ 不合即 422）。
  // 权威面此前"非数组直接放过、让引擎炸 500"＝台账#28 的真实成因，本轮改为入站即判。
  if (!Array.isArray(history)) throw new RequestBadShape(`history 类型 ${typeof history} ≠ array`)
  if (history.length > MAX_HISTORY_ITEMS) {
    throw new RequestTooLarge(`history 条数 ${history.length} > ${MAX_HISTORY_ITEMS}`)
  }
  history.forEach((m, i) => {
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new RequestBadShape(`history[${i}] 类型 ${Array.isArray(m) ? "array" : typeof m} ≠ object`)
    }
    // 类型也判掉：`content` 传成对象会在镜像面 `"".join()` 处抛 TypeError → 500（本机实测），
    // 权威面则是静默把对象拼进上下文继续跑。500 只留给真故障，客户端错误在入站就定码。
    if (m.content !== undefined && m.content !== null && typeof m.content !== "string") {
      throw new RequestBadShape(`history[${i}].content 类型 ${typeof m.content} ≠ string`)
    }
    if (m.role !== undefined && m.role !== null && typeof m.role !== "string") {
      throw new RequestBadShape(`history[${i}].role 类型 ${typeof m.role} ≠ string`)
    }
    boundedText(m.content, `history[${i}].content`)
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
    // 契约 `dx: dict | None`；只校到这一层（镜像面 dx 内部是自由 dict，不再往下强校验）
    if (typeof parsed.dx !== "object" || Array.isArray(parsed.dx)) {
      throw new RequestBadShape(`dx 类型 ${Array.isArray(parsed.dx) ? "array" : typeof parsed.dx} ≠ object`)
    }
    const dxBytes = byteLength(JSON.stringify(parsed.dx))
    if (dxBytes > MAX_DX_JSON_BYTES) throw new RequestTooLarge(`dx ${dxBytes} > ${MAX_DX_JSON_BYTES}`)
    boundedText(parsed.dx?.conclusion, "dx.conclusion")
    const evidence = Array.isArray(parsed.dx.evidence) ? parsed.dx.evidence.slice(0, MAX_HISTORY_ITEMS) : []
    evidence.forEach((ev, i) => {
      if (ev && typeof ev === "object") boundedText(ev.text, `dx.evidence[${i}].text`)
    })
  }
  return parsed
}
