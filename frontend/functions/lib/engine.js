// ============================================================
// 诊断引擎：临床状态抽取 → 证据检索(BM25) → LLM 结构化生成
//          → 确定性校验 → 红旗规则兜底 → 失败安全降级
// 红线：红旗规则结果优先且不可被模型覆盖；非法 evidence_id 直接拒绝
// mode 取值：live（LLM 生成）/ rule-fallback（规则降级，明确标注）
// ============================================================
import { CASES, INTAKE_DONE_REPLY } from "./data.js"
import { scanFlags, scanFlagDetails } from "./rules.js"
import { hasEvidence, evidenceForSymptoms } from "./rag.js"
import { getRetriever } from "./retriever.js"
import { KB_BY_ID, SYMPTOM_TO_KB, kbTitleOf, kbConditionOf } from "./knowledge.js"
import { toFhirBundle } from "./fhir.js"

// 404 文案里的"未提供"占位：双端必须同值（tests/error_parity_guard.mjs 逐字比对 message，
// 之前 JS 打 `undefined`、Py 打空串，码相同但文案漂＝支持侧对不上话）
const MISSING_CASE = "(未提供)"
const retriever = getRetriever()
const kbTitle = (id) => kbTitleOf(id)
const kbCondition = (id) => kbConditionOf(id)

// 未知病例＝**客户端**错误：带 status 让路由走 4xx 分支（warn 级日志），而不是靠
// catch 里比 `message.startsWith("unknown case")` 事后翻译——那样日志级别先落错（error），
// 且镜像面 `engine.py.UnknownCase` 是带类型的，双端同一机制才对得上。
export class UnknownCase extends Error {
  constructor(id) {
    super(`unknown case: ${id || MISSING_CASE}`)
    this.name = "UnknownCase"
    this.status = 404
    this.reason = `case_id=${id || MISSING_CASE}`
  }
}

function caseOf(id) {
  const c = CASES.find((x) => x.id === id)
  if (!c) throw new UnknownCase(id)
  return c
}

export function getCases() {
  return CASES
}

// ---------- 临床状态抽取（确定性，不依赖 LLM） ----------
export function extractState(caseId, history = []) {
  const c = caseOf(caseId)
  const answers = (history || []).filter((m) => m && m.role === "user").map((m) => String(m.content ?? ""))
  const fullText = [c.chief, ...answers].join("；")
  const flags = scanFlags(fullText)
  const flagDetails = scanFlagDetails(fullText)
  const symptoms = detectSymptoms(fullText)
  const missing = missingSlots(c, answers)
  return {
    case_id: caseId,
    patient: { name: c.name, age: c.age, gender: c.gender, chief: c.chief },
    transcript: fullText,
    symptoms,
    red_flags: flags,
    red_flag_details: flagDetails,
    missing_slots: missing,
    rounds: answers.length,
    done: answers.length >= c.answers.length,
  }
}

const SLOT_LEXICON = {
  "疼痛性质": ["压榨", "针刺", "烧灼", "钝痛", "撕裂", "紧缩"],
  "放射部位": ["放射", "向左肩", "向后背", "向下颌", "牵涉"],
  "诱发缓解": ["劳累", "活动", "休息", "体位", "进食", "空腹", "夜间"],
  "伴随症状": ["冷汗", "出汗", "恶心", "呕吐", "气促", "呼吸困难", "心悸", "耳鸣", "咽痛", "咳嗽", "发热", "腹泻", "血尿"],
  "既往史": ["高血压", "糖尿病", "冠心病", "吸烟", "饮酒", "贫血", "手术", "过敏"],
  "起病时间": ["小时", "天", "周", "月", "年", "突发", "反复"],
}
function missingSlots(c, answers) {
  const text = [c.chief, ...answers].join("；")
  const missing = []
  for (const [slot, kws] of Object.entries(SLOT_LEXICON)) {
    if (!kws.some((k) => text.includes(k))) missing.push(slot)
  }
  return missing
}

// 线索探针单一源：探针清单即 SYMPTOM_TO_KB 的键，杜绝「命中线索却无证据映射」的词表漂移
function detectSymptoms(text) {
  const probes = Object.keys(SYMPTOM_TO_KB)
  const found = []
  for (const p of probes) if (text.includes(p)) found.push(p)
  return found
}

// ---------- 问诊推进 ----------
export async function nextIntakeQuestion(caseId, history = [], env = {}) {
  const c = caseOf(caseId)
  const answered = (history || []).filter((m) => m.role === "user")
  const idx = answered.length
  const state = extractState(caseId, history)
  if (idx < c.answers.length) {
    const item = c.answers[idx]
    return { reply: item.q, question: item.q, source: "intake-question", chips: item.chips, done: false, state, mode: "rule" }
  }
  // LLM 续问硬上限 3 轮，防不收敛。**上限必须在调用前判**：
  // 实测原实现是"先外呼、后判上限、再丢弃"，超限那一轮仍产生一次完整请求（白花 8s 超时窗口与 token）。
  if (idx >= c.answers.length + 3) {
    return { reply: INTAKE_DONE_REPLY, source: "intake-done", chips: [], done: true, state, mode: "rule" }
  }
  const live = await llmFollowup(history, c, env)
  if (live && live.question) {
    return { reply: live.question, question: live.question, source: "intake-question-llm", chips: live.chips || [], done: false, state, mode: "live" }
  }
  return { reply: INTAKE_DONE_REPLY, source: "intake-done", chips: [], done: true, state, mode: "rule" }
}

async function llmFollowup(history, c, env) {
  if (!envKey(env)) return null
  const transcript = (history || []).slice(-8).map((m) => (m && m.role === "user" ? `医生: ${String(m.content ?? "")}` : `助手: ${String(m?.content ?? "")}`)).join("\n")
  const ctx = `患者：${c.name} ${c.age}岁 ${c.gender}，主诉：${c.chief}\n已有问诊记录：\n${transcript}`
  try {
    const raw = await callLLM([
      { role: "system", content: SYSTEM_BASE },
      { role: "user", content: `${ctx}\n\n若还需补充追问，输出 JSON {"question":"...","chips":["..."],"done":false}；信息已足够则输出 {"done":true}。中文。` },
    ], true, env)
    const data = JSON.parse(raw)
    if (data.done || !data.question) return null
    return data
  } catch { return null }
}

// ---------- 辅助诊断：检索先行 → LLM 生成 → 校验 → 红旗兜底 ----------
export async function buildDiagnosis(caseId, history = [], env = {}) {
  const state = extractState(caseId, history)
  const evidence = retriever.search(state.transcript, 5)
  const evidenceIds = evidence.map((e) => e.id)

  let out = null
  let mode = "rule-fallback"
  let fallbackReason = ""
  const live = await llmDiagnosis(state, evidence, env)
  if (live) { out = live; mode = "live" }
  else { out = ruleDiagnosis(state, evidence); fallbackReason = envKey(env) ? "LLM 超时/输出非法，已切换规则引擎" : "未配置 LLM Key，使用规则引擎" }

  // 确定性校验：非法 evidence_id 拒绝
  out = validateDiagnosis(out, evidenceIds)
  // 红旗兜底：规则结果优先，不可被模型覆盖
  out.flags = state.red_flags
  out.flag_details = state.red_flag_details
  out.mode = mode
  out.fallback_reason = fallbackReason
  out.trace = { evidence_ids: evidenceIds, rounds: state.rounds, symptoms: state.symptoms }
  out.state = state
  out.fhir = toFhirBundle(out)
  return out
}

function validateDiagnosis(dx, allowedIds) {
  const ok = (id) => typeof id === "string" && hasEvidence(id)
  const fixRefs = (arr) => (Array.isArray(arr) ? arr : []).filter(ok)
  const asStrArray = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map((r) => String(r ?? "").slice(0, len)).filter(Boolean)
  dx.primary = (Array.isArray(dx.primary) ? dx.primary : []).slice(0, 4).map((p) => {
    const pp = (p && typeof p === "object") ? p : {}
    let evIds = fixRefs(pp.evidence_ids)
    if (evIds.length === 0) evIds = (allowedIds || []).slice(0, 2).filter(ok) // LLM 未挂引用时，回填全局检索证据
    return {
      name: String(pp.name || "未命名诊断").slice(0, 60),
      prob: ["高优先级", "需鉴别", "低可能"].includes(pp.prob) ? pp.prob : "需鉴别",
      strength: ["high", "mid", "low"].includes(pp.strength) ? pp.strength : "mid",
      reasons: asStrArray(pp.reasons, 4, 80),
      evidence_ids: evIds,
      refs: evIds.map((id) => kbTitle(id)),
    }
  })
  if (dx.primary.length === 0) { dx.primary = [{ name: "信息不足，建议补充问诊", prob: "需鉴别", strength: "low", reasons: ["现有线索不足以形成鉴别诊断"], evidence_ids: [], refs: [] }] }
  dx.differential = (Array.isArray(dx.differential) ? dx.differential : []).slice(0, 6).map((d) => {
    const dd = (d && typeof d === "object") ? d : {}
    return {
      name: String(dd.name || "").slice(0, 60), note: String(dd.note || "").slice(0, 120),
      evidence_ids: fixRefs(dd.evidence_ids),
    }
  })
  // AC-OBS-04：鉴别诊断≥2 项，不足时用检索证据回填
  if (dx.differential.length < 2 && (allowedIds || []).length >= 2) {
    const used = new Set(dx.differential.flatMap((d) => d.evidence_ids))
    for (const id of allowedIds) {
      if (dx.differential.length >= 2) break
      if (used.has(id) || !hasEvidence(id)) continue
      const kb = KB_BY_ID.get(id)
      if (!kb) continue
      dx.differential.push({ name: kb.condition || kb.title, note: String(kb.text || "").slice(0, 60), evidence_ids: [id] })
    }
  }
  // AC-OBS-04：疑似诊断≥2 项。回填优先复用鉴别诊断首项（临床语义一致），避免盲取证据引入噪声诊断
  if (dx.primary.length < 2) {
    const first = dx.primary[0]
    const d0 = dx.differential.find((d) => d.name && d.name !== first.name)
    if (d0) {
      dx.primary.push({ name: `${d0.name}（需鉴别）`, prob: "需鉴别", strength: "mid",
        reasons: [d0.note || "与首要诊断共存线索，需进一步检查区分"], evidence_ids: d0.evidence_ids, refs: d0.evidence_ids.map((id) => kbTitle(id)) })
    } else if ((allowedIds || []).length >= 2) {
      const used = new Set(dx.primary.flatMap((p) => p.evidence_ids))
      const extra = allowedIds.find((id) => !used.has(id) && hasEvidence(id))
      if (extra) {
        const kb = KB_BY_ID.get(extra)
        if (kb) {
          dx.primary.push({ name: `${kb.condition}（需鉴别）`, prob: "需鉴别", strength: "mid",
            reasons: ["与首要诊断共存线索，需进一步检查区分"], evidence_ids: [extra], refs: [kb.title] })
        }
      }
    }
  }
  dx.evidence = (Array.isArray(dx.evidence) ? dx.evidence : []).filter((e) => e && ok(e.id))
  return dx
}

function ruleDiagnosis(state, evidence) {
  // 确定性降级：按红旗与症状线索映射知识库条目生成结构化结论
  const condIds = new Set()
  for (const e of evidence || []) if (e && hasEvidence(e.id)) condIds.add(e.id)
  const primary = [...condIds].slice(0, 3).map((id, i) => ({
    name: kbCondition(id), prob: i === 0 ? "高优先级" : "需鉴别", strength: i === 0 ? "high" : "mid",
    reasons: [state.transcript.slice(0, 40) + "…"], evidence_ids: [id], refs: [id],
  }))
  const symptomEv = evidenceForSymptoms(state.symptoms).filter((e) => !condIds.has(e.id)).slice(0, 3)
  const differential = symptomEv.map((e) => ({ name: e.title, note: e.text.slice(0, 60), evidence_ids: [e.id] }))
  return {
    flags: state.red_flags,
    flag_details: state.red_flag_details,
    primary: primary.length ? primary : [{ name: "待医生结合查体进一步鉴别", prob: "需鉴别", strength: "mid", reasons: [state.transcript.slice(0, 60)], evidence_ids: [], refs: [] }],
    differential,
    faq: [{ q: "为什么是规则降级模式？", a: "本次未使用大模型生成（无 Key 或模型超时/输出非法），结论由红旗规则与知识库映射产生，已明确标注，请医生复核。" }],
    evidence: [...evidence, ...symptomEv],
  }
}

async function llmDiagnosis(state, evidence, env) {
  if (!envKey(env)) return null
  const evBlock = evidence.map((e) => `- [${e.id}] ${e.title}（${e.source} ${e.year}）：${e.text}`).join("\n")
  const flagBlock = state.red_flags.length ? `已检出红旗：${state.red_flags.join("；")}` : "未检出红旗"
  const prompt = `患者信息：${state.patient.name} ${state.patient.age}岁 ${state.patient.gender}
临床状态：${state.transcript}
${flagBlock}
可引用证据（只能引用下列 id）：
${evBlock}

请输出严格 JSON（不要多余文字）：
{"primary":[{"name":"...","prob":"高优先级|需鉴别|低可能","strength":"high|mid|low","reasons":["..."],"evidence_ids":["kb-xxx"]}],"differential":[{"name":"...","note":"...","evidence_ids":["kb-xxx"]}],"faq":[{"q":"...","a":"..."}]}
约束：primary 至少 2 项（首项为最可能诊断，次项为需鉴别诊断）；differential 至少 2 项；每项 evidence_ids 只能从上述证据 id 中选取。`
  try {
    const raw = await callLLM([
      { role: "system", content: SYSTEM_BASE },
      { role: "user", content: prompt },
    ], true, env)
    const data = JSON.parse(raw)
    if (!Array.isArray(data.primary) || !data.primary.length) return null
    data.evidence = evidence
    data.faq = Array.isArray(data.faq) ? data.faq.slice(0, 3) : []
    return data
  } catch { return null }
}

// ---------- 检查建议 ----------
// 复用前端已生成的诊断结果（省一次 LLM 串行调用，降 P95 时延）；
// 但红旗一律以后端规则重算为准（不信任前端），证据非法 id 会过滤后回填，缺失则回退完整生成。
async function reuseOrBuild(state, history, env, providedDx) {
  if (providedDx && Array.isArray(providedDx.primary) && providedDx.primary.length >= 1) {
    const dx = structuredClone(providedDx)
    dx.flags = state.red_flags
    dx.flag_details = state.red_flag_details
    const validEv = (Array.isArray(dx.evidence) ? dx.evidence : []).filter((e) => e && typeof e.id === "string" && hasEvidence(e.id))
    dx.evidence = validEv.length ? validEv : retriever.search(state.transcript, 5)
    if (!dx.trace) dx.trace = { evidence_ids: dx.evidence.map((e) => e.id), rounds: state.rounds, symptoms: state.symptoms }
    return dx
  }
  return buildDiagnosis(state.case_id, history, env)
}

export async function buildWorkup(caseId, history = [], env = {}, providedDx = null) {
  const state = extractState(caseId, history)
  const dx = await reuseOrBuild(state, history, env, providedDx)
  const firstName = dx.primary?.[0]?.name || ""
  const evidence = retriever.search(state.transcript + " " + firstName, 5)
  let out = null, mode = "rule-fallback", fallbackReason = ""
  const live = await llmWorkup(state, dx, evidence, env)
  if (live) { out = live; mode = "live" }
  else { out = ruleWorkup(state, dx); fallbackReason = envKey(env) ? "LLM 超时/输出非法，已切换规则引擎" : "未配置 LLM Key，使用规则引擎" }
  out = validateWorkup(out)
  out.mode = mode
  out.fallback_reason = fallbackReason
  out.evidence_ids = evidence.map((e) => e.id)
  return out
}

function validateWorkup(w) {
  const src = (w && typeof w === "object") ? w : {}
  const out = {}
  const groups = ["essential", "suggested", "optional"]
  for (const key of groups) {
    const arr = Array.isArray(src[key]) ? src[key] : []
    out[key] = arr.slice(0, 6).map((it) => {
      const o = (it && typeof it === "object") ? it : {}
      return {
        item: String(o.item || "").slice(0, 80), why: String(o.why || "").slice(0, 100),
        evidence_ids: (Array.isArray(o.evidence_ids) ? o.evidence_ids : []).filter((id) => hasEvidence(id)),
      }
    })
    if (!out[key].length) out[key] = [{ item: "请医生结合完整临床资料决定", why: "当前信息不足以给出该组明确建议", evidence_ids: [] }]
  }
  return out
}

function ruleWorkup(state, dx) {
  const topEv = dx.evidence?.[0]
  const base = (item, why) => ({ item, why, evidence_ids: topEv ? [topEv.id] : [] })
  if (state.red_flags.length) {
    return { essential: [base("即刻心电图 + 心肌损伤标志物", "红旗提示急危重症，优先排除"), base("血氧/血压/意识监测", "评估血流动力学稳定性")],
      suggested: [base("血常规/肾功能/电解质", "基础状态评估")],
      optional: [base("上级医院影像（CTA/超声）", "由胸痛中心/上级完成")] }
  }
  return { essential: [base("血常规 + CRP", "感染/贫血初筛"), base("针对主诉的定向检查", `围绕：${state.symptoms.join("、") || state.patient.chief}`)],
    suggested: [base("病原学/生化按需", "结合体征选择")],
    optional: [base("专科评估或复查", "症状迁延时补充")] }
}

async function llmWorkup(state, dx, evidence, env) {
  if (!envKey(env)) return null
  const evBlock = evidence.map((e) => `- [${e.id}] ${e.title}`).join("\n")
  const prompt = `临床状态：${state.transcript}\n疑似诊断：${dx.primary.map((p) => p.name).join("；")}\n证据：\n${evBlock}\n\n输出严格 JSON：{"essential":[{"item":"...","why":"...","evidence_ids":["kb-xxx"]}],"suggested":[...],"optional":[...]}`
  try {
    const raw = await callLLM([{ role: "system", content: SYSTEM_BASE }, { role: "user", content: prompt }], true, env)
    const d = JSON.parse(raw)
    const hasAny = (a) => Array.isArray(a) && a.length > 0
    if (!hasAny(d.essential) && !hasAny(d.suggested) && !hasAny(d.optional)) return null
    return d
  } catch { return null }
}

// ---------- SOAP 病历报告 ----------
export async function buildReport(caseId, history = [], env = {}, providedDx = null) {
  const state = extractState(caseId, history)
  const dx = await reuseOrBuild(state, history, env, providedDx)
  const c = caseOf(caseId)
  const vitals = c.vitals.map((v) => `${v.key} ${v.value}`).join("，")
  let out = null, mode = "rule-fallback", fallbackReason = ""
  const live = await llmReport(state, dx, vitals, env)
  if (live) { out = live; mode = "live" }
  else {
    out = {
      soap: {
        subjective: `${state.patient.name}，${state.patient.age}岁 ${state.patient.gender}。${state.transcript}`,
        objective: `${vitals}；余查体待完善。`,
        assessment: dx.primary.map((p) => p.name).join("；") + (dx.flags.length ? "。红旗：" + dx.flags.join("；") : ""),
        plan: dx.flags.length ? "按急危重症路径处置并尽快转诊；完善心电图/标志物等必查项。" : "按鉴别诊断方向完善检查；对症处理并告知复诊指征。",
      },
      conclusion: dx.primary[0]?.name || "待医生终审",
      disclaimer: "本报告由 AI 辅助生成，仅作接诊参考。诊断与处置决策必须由具有执业资质的医生结合全部检查结果最终确定。",
    }
    fallbackReason = envKey(env) ? "LLM 超时/输出非法，已切换规则模板" : "未配置 LLM Key，使用规则模板"
  }
  out.mode = mode
  out.fallback_reason = fallbackReason
  out.evidence_ids = dx.trace?.evidence_ids || []
  return out
}

async function llmReport(state, dx, vitals, env) {
  if (!envKey(env)) return null
  const prompt = `临床状态：${state.transcript}\n生命体征：${vitals}\n疑似诊断：${dx.primary.map((p) => p.name).join("；")}\n红旗：${dx.flags.join("；") || "无"}\n\n输出严格 JSON：{"soap":{"subjective":"...","objective":"...","assessment":"...","plan":"..."},"conclusion":"...","disclaimer":"..."}`
  try {
    const raw = await callLLM([{ role: "system", content: SYSTEM_BASE }, { role: "user", content: prompt }], true, env)
    const d = JSON.parse(raw)
    if (!d.soap || !d.soap.subjective) return null
    if (!d.disclaimer) d.disclaimer = "本报告由 AI 辅助生成，仅作接诊参考，最终诊断由执业医生确定。"
    return d
  } catch { return null }
}

// ---------- LLM 通道 ----------
const SYSTEM_BASE = "你是「医·基层AI辅助诊断系统」的基层医生辅助诊断助手。严格约束：1) 输出仅为辅助参考，不替代执业医生决策；2) 发现高危信号必须优先提示急诊转诊，且不得推翻已检出的红旗；3) 只能引用给定证据列表中的 evidence_id，禁止编造；4) 不编造检查数值；5) 只输出 JSON，中文。"

function envKey(env = {}) {
  return (env?.DEEPSEEK_API_KEY || "") || ""
}

async function callLLM(messages, jsonMode = false, env = {}) {
  const key = envKey(env)
  if (!key) throw new Error("no key")
  const base = (env?.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1")
  const model = (env?.DEEPSEEK_MODEL || "deepseek-chat")
  const payload = { model, messages, temperature: 0.3 }
  if (jsonMode) payload.response_format = { type: "json_object" }
  const resp = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000), // 单次模型硬超时 8s
  })
  if (!resp.ok) throw new Error(`llm http ${resp.status}`)
  const data = await resp.json()
  return data.choices[0].message.content
}
