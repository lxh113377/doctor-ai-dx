// 诊断引擎编排（规则层 → RAG → LLM 可插拔）——对应 backend/app/services/engine.py + llm.py
import { CASES, INTAKE_DONE_REPLY, DX, WORKUP, REPORT } from "./data.js"
import { scanFlags } from "./rules.js"
import { search } from "./rag.js"

class Http404 extends Error {}

function caseOf(id) {
  const c = CASES.find((x) => x.id === id)
  if (!c) throw new Http404(`unknown case: ${id}`)
  return c
}

export function getCases() {
  return CASES
}

// 问诊推进（stateless：history 随请求携带，计数 = 用户消息数）
export async function nextIntakeQuestion(caseId, history = [], env = {}) {
  const c = caseOf(caseId)
  const answered = (history || []).filter((m) => m.role === "user")
  const idx = answered.length
  if (idx < c.answers.length) {
    const item = c.answers[idx]
    return { reply: item.q, source: "intake-question", chips: item.chips, done: false }
  }

  // 内置序列耗尽 → 尝试 LLM 续问；失败/无 key 直接 done
  const live = await llmChat(history, c, env)
  if (live && live.question) {
    return { reply: live.question, source: "intake-question", chips: live.chips || [], done: false }
  }
  return { reply: INTAKE_DONE_REPLY, source: "intake-done", chips: [], done: true }
}

async function llmChat(history, c, env = {}) {
  if (!envKey(env)) return null
  const transcript = (history || []).slice(-8)
    .map((m) => (m.role === "user" ? `医生: ${m.content}` : `助手: ${m.content}`)).join("\n")
  const ctx = `患者：${c.name} ${c.age}岁 ${c.gender}，主诉：${c.chief}\n已有问诊记录：\n${transcript}`
  try {
    const raw = await callLLM([
      { role: "system", content: SYSTEM_BASE },
      { role: "user", content: `${ctx}\n\n若还需补充追问，请输出 JSON {"question": "...", "chips": [...], "done": false}；若信息已足够，输出 {"done": true}。回答使用中文。` },
    ], true, env)
    const data = JSON.parse(raw)
    if (data.done || !data.question) return null
    return data
  } catch {
    return null
  }
}

export async function buildDiagnosis(caseId, intakeText = "", env = {}) {
  const c = caseOf(caseId)
  const flags = scanFlags(intakeText + c.chief)
  const dx = structuredClone(DX[caseId])
  for (const f of dx.flags) if (!flags.includes(f)) flags.push(f)
  dx.flags = flags

  // RAG 引用溯源：主诉 + 首个疑似诊断检索，命中来源并入 refs
  const probe = c.chief + " " + dx.primary[0].name
  const hits = search(probe, 3)
  for (const item of dx.primary) {
    const refs = item.refs.slice()
    for (const h of hits) if (!refs.includes(h.source)) refs.push(h.source)
    item.refs = refs.slice(0, 4)
  }
  return dx
}

export function getWorkup(caseId) {
  caseOf(caseId)
  return structuredClone(WORKUP[caseId])
}

export function getReport(caseId) {
  caseOf(caseId)
  return structuredClone(REPORT[caseId])
}

const SYSTEM_BASE = "你是「医·AI」基层医生辅助诊断助手。严格约束：1) 你的输出仅为辅助参考，明确不替代执业医生的诊断决策；2) 发现高危信号（压榨样胸痛、意识障碍、呼吸衰竭、大出血等）必须优先提示急诊转诊；3) 引用知识库时给出来源；4) 不要编造检查数值或诊断结论。"

function envKey(env = {}) {
  return (env?.DEEPSEEK_API_KEY || (typeof DEEPSEEK_API_KEY !== "undefined" ? DEEPSEEK_API_KEY : "")) || ""
}

async function callLLM(messages, jsonMode = false, env = {}) {
  const key = envKey(env)
  if (!key) throw new Error("no key")
  const base = (env?.DEEPSEEK_BASE_URL || (typeof DEEPSEEK_BASE_URL !== "undefined" && DEEPSEEK_BASE_URL)) || "https://api.deepseek.com/v1"
  const model = (env?.DEEPSEEK_MODEL || (typeof DEEPSEEK_MODEL !== "undefined" && DEEPSEEK_MODEL)) || "deepseek-chat"
  const payload = { model, messages, temperature: 0.3 }
  if (jsonMode) payload.response_format = { type: "json_object" }
  const resp = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),   // LLM 硬超时：超出降级 mock，防拖垮函数执行
  })
  if (!resp.ok) throw new Error(`llm http ${resp.status}`)
  const data = await resp.json()
  return data.choices[0].message.content
}