// API 层：对接后端 FastAPI（契约 shape 与原型 api.js 存根一致）
const BASE = ''          // 开发期经 vite proxy；构建后同上

async function req(path, opts) {
  const res = await fetch(BASE + path, opts)
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`)
  return (await res.json()).data
}

export function getCases() {
  return req('/api/cases')
}

export function askIntake(caseId, content, history) {
  return req('/api/intake/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, answer: content, history }),
  })
}

export function getDiagnosis(caseId, intakeText) {
  return req('/api/dx/' + caseId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, answer: intakeText, history: [] }),
  })
}

export function getWorkup(caseId) {
  return req('/api/workup/' + caseId)
}

export function getReport(caseId) {
  return req('/api/report/' + caseId)
}