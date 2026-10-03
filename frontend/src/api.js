// API 层：对接 Pages Functions / FastAPI（契约：dx/workup/report 接收完整 history）
const BASE = ''
const DEFAULT_TIMEOUT = 20000

function withTimeout(signal, ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms)
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), ms)
  const clear = () => clearTimeout(t)
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason)
    else signal.addEventListener("abort", () => { clear(); ctrl.abort(signal.reason) }, { once: true })
  }
  ctrl.signal.addEventListener("abort", clear, { once: true })
  return ctrl.signal
}

async function req(path, opts, timeoutMs = DEFAULT_TIMEOUT) {
  let res
  try {
    res = await fetch(BASE + path, { ...opts, signal: withTimeout(opts?.signal, timeoutMs) })
  } catch (e) {
    // 网络层失败/超时不透传浏览器原文（如 "Failed to fetch"），统一医生可理解文案
    if (e && e.name === 'AbortError') throw new Error('请求超时或网络中断，请稍后重试')
    throw new Error('网络连接失败，请检查网络后重试')
  }
  // 先读体再判状态：服务端错误响应里的 message 已含可对账的故障编号，优先用它
  const reqId = res.headers.get("x-request-id") || ""
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    const serverMsg = body && typeof body.message === "string" ? body.message : ""
    throw new Error(serverMsg || `服务暂时不可用，请稍后重试（${res.status}${reqId ? ` · 故障编号 ${reqId}` : ""}）`)
  }
  if (!body || body.data === undefined) throw new Error("服务返回异常，请稍后重试")
  return body.data
}

export function getCases(signal) {
  return req('/api/cases', signal ? { signal } : undefined, 10000)
}

export function askIntake(caseId, history) {
  return req('/api/intake/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, history }),
  })
}

export function getDiagnosis(caseId, history) {
  return req('/api/dx/' + caseId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, history }),
  })
}

export function getWorkup(caseId, history, dx) {
  return req('/api/workup/' + caseId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, history, dx: dx || null }),
  })
}

export function getReport(caseId, history, dx) {
  return req('/api/report/' + caseId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, history, dx: dx || null }),
  })
}

// ---- 对话面与后台（round90）----
// 后台三态（401 未提供 / 403 不正确 / 503 未配置）由服务端返回，这里**原样把文案透出**：
// 后台最怕的是把"没配令牌"显示成"没有数据"，那会把配置问题误读成业务事实。
const jsonPost = (payload) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export function askChat(payload, signal) {
  // signal 透传给 req：req 会用自己的 withTimeout 包一层，这里只提供取消依据
  return req('/api/chat', { ...jsonPost(payload), signal }, 30000)
}

export function rateChat(conversationId, payload) {
  return req(`/api/chat/${encodeURIComponent(conversationId)}/feedback`, jsonPost(payload))
}

export function getConversation(conversationId, signal) {
  return req(`/api/chat/${encodeURIComponent(conversationId)}`, signal ? { signal } : undefined)
}

const adminGet = (path, token) => ({
  headers: { 'x-admin-token': token },
})

export function adminStats(token) {
  return req('/api/admin/stats', adminGet('', token))
}

export function adminConversations(token) {
  return req('/api/admin/conversations?limit=50', adminGet('', token))
}

/** 会话详情（回放用）：消息逐条带 intent/confidence/kb_hits/provider/latency_ms 归因字段。
 *  端点本身早已存在（[[route]].js 的 admin/conversations/{id} 分支），此处只是补上前端调用口。 */
export function adminConversationDetail(conversationId, token) {
  return req(`/api/admin/conversations/${encodeURIComponent(conversationId)}`, adminGet('', token))
}

export function adminHandoffs(token) {
  return req('/api/admin/handoffs?limit=50', adminGet('', token))
}

/** 快捷意图 chips：与 data/intents.json 的三类客服语义一一对应，口径不另立一套。 */
export const SERVICE_CHIPS = [
  { label: '退挂号费', q: '我要退挂号费，请问怎么办' },
  { label: '查报告', q: '检查报告在哪里看' },
  { label: '技术支持', q: '页面打不开，登录不上' },
]