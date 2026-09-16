// API 层：对接 Pages Functions / FastAPI（契约：dx/workup/report 接收完整 history）
const BASE = ''

async function req(path, opts) {
  const res = await fetch(BASE + path, opts)
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
  return (await res.json()).data
}

export function getCases() {
  return req('/api/cases')
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
