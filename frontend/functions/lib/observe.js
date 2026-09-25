// ============================================================
// 可观测性：请求标识 + 结构化日志 + 出站前脱敏
// 约束：响应体仍只含医生可理解文案（不出现堆栈/内部路径/密钥）；
//      日志只落可归因的最小字段，供 Cloudflare Tail Workers / 本地控制台检索。
// ============================================================

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
]
// 患者可识别信息形态：错误消息可能回显医生粘贴的内容（含手机号/身份证），日志与出站文案都要过这一关。
// 两侧负向断言是必要的：13 位毫秒时间戳内部含有满足 1[3-9]\d{9} 的 11 位子串，不加边界会误伤成假脱敏。
const PII_PATTERNS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?<![\dXx])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{3}[\dXx](?![\dXx])/g,
]
// 内部路径/堆栈帧特征：file://、Windows 盘符、node 栈 at ...
const INTERNAL_PATTERNS = [
  /file:\/\/\S+/g,
  /(?:[A-Za-z]:\\|\/(?:home|Users|var|app)\/)\S+/g,
  /\bat\s+\S+\s+\([^)]*\)/g,
]

export const OBSERVE_PATTERNS = Object.freeze({
  secret: SECRET_PATTERNS.map((re) => re.source),
  pii: PII_PATTERNS.map((re) => re.source),
  internal: INTERNAL_PATTERNS.map((re) => re.source),
})

export function newRequestId() {
  const raw = globalThis.crypto?.randomUUID?.()
  if (raw) return String(raw).slice(0, 8)
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-2)
}

// 脱敏：任何写日志或回显给前端的文本都必须先过这一关
export function redact(input, env = {}) {
  let text = String(input ?? "").slice(0, 300)
  const key = env?.DEEPSEEK_API_KEY
  if (typeof key === "string" && key.length >= 6) {
    text = text.split(key).join("[已脱敏]")
  }
  for (const re of SECRET_PATTERNS) text = text.replace(re, "[已脱敏]")
  for (const re of PII_PATTERNS) text = text.replace(re, "[已脱敏]")
  for (const re of INTERNAL_PATTERNS) text = text.replace(re, "[内部路径]")
  return text
}

// 结构化单行日志（JSON）：logs 里出现过的字段名即归因查询的索引面
export function logEvent(level, fields) {
  const line = JSON.stringify({ app: "doctor-ai-dx", lvl: level, ...fields })
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const SLOW_MS = 8000

// 统一出口：所有响应都带 X-Request-Id，前端故障编号与服务端日志可对账
export function withRequestId(headers, requestId) {
  const out = new Headers(headers || {})
  if (requestId) out.set("X-Request-Id", String(requestId))
  return out
}
