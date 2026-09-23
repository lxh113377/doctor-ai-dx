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
  const res = await fetch(BASE + path, { ...opts, signal: withTimeout(opts?.signal, timeoutMs) })
  if (!res.ok) throw new Error(`服务暂时不可用，请稍后重试（${res.status}）`)
  let body = null
  try {
    body = await res.json()
  } catch {
    throw new Error("服务返回异常，请稍后重试")
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
