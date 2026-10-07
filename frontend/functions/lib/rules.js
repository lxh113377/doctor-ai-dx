// 危险信号规则引擎（红旗拦截层）——独立于 LLM：可解释、可单测，评审安全叙事核心
// 设计原则：关键词须特异（避免"出冷汗"这类非特异词单独触发 ACS 造成误报）；
//          支持数值解析（血压）；命中即强制转诊提示，优先级高于模型输出。
import { BP_THRESHOLDS, COMBO_RULES, DANGER_RULES, NEGATION, POSITIVE_TERMS } from "./red_flag_rules.js"
import { SCOPE_META, SCOPE_RULES } from "./scope_rules.js"
import { CONSCIOUSNESS_TOKENS, DERIVED_VALUES, PLAUSIBLE_RANGES, SCORE_TABLES } from "./clinical_scores.js"

// 表本体外置到 data/red_flag_rules.json（第三十一轮 #89）：本文件只留**逻辑**，规则/关键词/建议/阈值一律来自生成物。
// 上一轮补的是"改了会不会炸"（载入即校验），这一轮补的是"改一处还是改两处"——
// 加一条红旗此前要同时改 rules.js 与 app/rules.py，双端各抄一份正是漂移的起点。
const BP_SYS = BP_THRESHOLDS.systolic_crisis
const BP_DIA = BP_THRESHOLDS.diastolic_crisis
const NEGATION_TOKENS = NEGATION.tokens
const NEG_LOOKBEHIND = NEGATION.lookbehind_chars
// 血压数值解析：收缩压/舒张压过界 → 高血压急症；建议文案取自表内那条规则本体。
// 刻意不给 `|| "…"` 兜底字面量：那份文案会变成权威表之外的第二份建议（表里改了它不跟着改），
// 且镜像端 `next(...)` 本就是严格取法——两端此处口径必须一致。
const HYPERTENSION_ADVICE = DANGER_RULES.find((r) => r.name.includes("高血压"))?.advice
if (!HYPERTENSION_ADVICE) throw new Error("红旗表里没有名字含「高血压急症」的规则，血压危象无处挂建议（改 data/red_flag_rules.json 而不是在此兜底）")
function bpCrisis(text) {
  const t = String(text ?? "")
  const m = t.match(/(\d{2,3})\s*[/／]\s*(\d{2,3})/)
  if (!m) return false
  const sys = parseInt(m[1], 10)
  const dia = parseInt(m[2], 10)
  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return false
  if (sys > BP_THRESHOLDS.plausible_max_systolic || dia > BP_THRESHOLDS.plausible_max_diastolic
    || sys < BP_THRESHOLDS.plausible_min_systolic || dia < BP_THRESHOLDS.plausible_min_diastolic) return false
  return sys >= BP_SYS || dia >= BP_DIA
}

// 否定修饰：中文临床文本用「无/没有/未/否认…」直接修饰症状词表达阴性。
// 既往按子串命中 ⇒ "无气促" 命中 "气促"，脓毒症红旗假阳性（第二十四轮由产品路径评测实测抓到）。
// 只收「明确阴性表述」：不收 "排除/不支持/不" —— "不能排除心前区闷痛" 若被抑制就是漏报，
// 而本层的失败代价不对称（漏报危险信号远重于多提示），故宁缺毋滥。
// 形似否定实为阳性体征的词，必须先于否定判定放行，否则把「尿闭」当阴性 ⇒ 制造漏报。
// follow 是该词之后不得紧跟的字：否则 "无尿痛" 会先命中 "无尿" 这条阳性例外。

// kw 在 t 中是否存在「未被否定」的一次出现（任一阳性出现即算命中，多出现取或）
function hasPositiveOccurrence(t, kw) {
  const k = String(kw).toLowerCase()
  if (!k) return false
  const positive = POSITIVE_TERMS.find((p) => p.term === k)
  let from = 0
  for (;;) {
    const at = t.indexOf(k, from)
    if (at < 0) return false
    const head = t.slice(Math.max(0, at - NEG_LOOKBEHIND), at)
    const tail = t.slice(at + k.length, at + k.length + 1)
    // 阳性例外词若被这些字紧跟，说明这次出现不是该体征（"无尿痛" 里的 "无尿"），该次出现作废继续找。
    const disqualified = positive !== undefined && positive.follow.includes(tail)
    const negated = disqualified || NEGATION_TOKENS.some((n) => head.endsWith(n))
    if (!negated) return true
    from = at + k.length
  }
}

// 结构化命中：按规则匹配并去重（按 name 去重，各规则 name 唯一，与原字符串去重等价）
// department 只在权威表声明时带上（改造二）：不带就整个键不出现，而不是留一个 `department: undefined`
// ——下游有按字段集读 flag_details 的界面与 FHIR 映射，空键与缺键不是一回事。
const withDept = (obj, dept) => (dept ? { ...obj, department: dept } : obj)

function matchFlagRules(t) {
  const hits = []
  const hit = (k) => hasPositiveOccurrence(t, k)
  for (const r of DANGER_RULES) {
    if (r.keywords.some(hit)) {
      hits.push(withDept({ name: r.name, severity: r.severity, advice: r.advice }, r.department))
    }
  }
  // 组合规则：每个线索组至少命中一词才触发（表达"症状组合"临床逻辑，降低单非特异词误报）
  for (const r of COMBO_RULES) {
    if (r.all.every((group) => group.some(hit))) {
      hits.push(withDept({ name: r.name, severity: r.severity, advice: r.advice }, r.department))
    }
  }
  if (bpCrisis(t) && !hits.some((h) => h.name.includes("高血压急症"))) {
    const hyp = DANGER_RULES.find((r) => r.name.includes("高血压"))
    hits.push(withDept({ name: "高血压急症红旗", severity: "高", advice: HYPERTENSION_ADVICE }, hyp?.department))
  }
  const seen = new Set(); const out = []
  for (const h of hits) { if (!seen.has(h.name)) { seen.add(h.name); out.push(h) } }
  return out
}

export const RULE_TABLES = { DANGER: DANGER_RULES, COMBO: COMBO_RULES, NEGATIONS: NEGATION_TOKENS, POSITIVES: POSITIVE_TERMS }

// ---------- 红旗表载入即校验（第三十轮 #83）----------
// 为什么现在做：红旗层是三条红线里唯一"数据即代码"的表，而"改了会不会炸"此前无人问津——
//   第二十九轮只给范围表建了载入期校验，红旗表反而零校验（实测 rules.py 里 validate 函数只有 1 个、
//   且不读 DANGER_RULES）。它比范围表更要命：表坏＝危险信号漏报，或多条同名被去重分支静默合并成一条。
// 规格抄 peer（本人 gh api 实测 kheireddinedev00/Medico `triage/rules.py` size=13599B sha=19fc7fcc）：
//   不变量写进注释、载入即 raise、错误信息点名违规项、**无降级模式**。
export const RED_FLAG_SEVERITIES = ["高", "中", "低"]

export function validateRedFlagTables(danger = DANGER_RULES, combo = COMBO_RULES) {
  const errs = []
  const owner = new Map()
  const tag = (kind, i, name) => `${kind}#${i}(${name || "?"})`
  const nameOf = (r) => (r && typeof r.name === "string" && r.name.trim() ? r.name.trim() : "")
  const terms = (list, at, where) => {
    if (!Array.isArray(list) || list.length === 0) { errs.push(`${at}: ${where} 须为非空数组`); return }
    for (const k of list) {
      if (typeof k !== "string" || !k.trim()) { errs.push(`${at}: ${where} 含空值或非字符串项 ${JSON.stringify(k)}`); continue }
      if (k.trim().length < 2) errs.push(`${at}: ${where}「${k}」是裸单字（子串会横扫全文，第二十四轮假阳性同族）`)
      else if (/^[\p{P}\p{S}\s]+$/u.test(k)) errs.push(`${at}: ${where}「${k}」是纯标点/空白（分词层已剔除标点 ⇒ 永不命中＝死规则）`)
    }
  }
  const one = (r, i, kind) => {
    if (!r || typeof r !== "object") { errs.push(`${kind}#${i}: 规则须为对象`); return }
    const nm = nameOf(r)
    const at = tag(kind, i, nm)
    if (!nm) errs.push(`${at}: name 缺失或为空`)
    else if (owner.has(nm)) errs.push(`${at}: name 与 ${owner.get(nm)} 重复（同名会被去重分支静默合并＝少报一条危险信号）`)
    else owner.set(nm, at)
    if (!RED_FLAG_SEVERITIES.includes(r.severity)) errs.push(`${at}: severity 只能是 ${RED_FLAG_SEVERITIES.join("/")}，实测 ${JSON.stringify(r.severity)}`)
    if (typeof r.advice !== "string" || r.advice.trim().length < 10) errs.push(`${at}: advice 缺失或短于 10 字（医生看不到处置＝等于没提示）`)
    if (kind === "DANGER") terms(r.keywords, at, "keywords")
    else {
      if (!Array.isArray(r.all) || r.all.length < 2) errs.push(`${at}: 组合规则须 ≥2 组线索（单组等价于关键词规则，放这里只会掩盖分母）`)
      else r.all.forEach((g, gi) => terms(g, `${at}/组${gi + 1}`, "线索"))
    }
  }
  ;(danger || []).forEach((r, i) => one(r, i, "DANGER"))
  ;(combo || []).forEach((r, i) => one(r, i, "COMBO"))
  if ((danger?.length || 0) + (combo?.length || 0) === 0) errs.push("红旗表整体为空（读空＝判据失效，不许当通过）")
  return errs
}

export function assertRedFlagTables(danger = DANGER_RULES, combo = COMBO_RULES) {
  const errs = validateRedFlagTables(danger, combo)
  if (errs.length) throw new Error(`红旗规则表非法，拒绝载入（无降级模式）：\n  - ${errs.join("\n  - ")}`)
}

assertRedFlagTables()

// ---------- 能力级适用范围（第二十九轮 #76）----------
// 与红旗层共用同一份否定词表（NEGATION_TOKENS），但窗口宽度取自数据（scope_rules.json）：
// 范围触发词常隔一个动词，如「没做过CT」里 CT 前是「没做过」，4 字窗口挡不住 ⇒ 会误判成"要求解读影像"。
function occursUnnegated(t, kw, window) {
  const k = String(kw).toLowerCase()
  if (!k) return false
  const extra = SCOPE_META.negation_tokens_extra.map((x) => String(x).toLowerCase())
  let from = 0
  for (;;) {
    const at = t.indexOf(k, from)
    if (at < 0) return false
    const head = t.slice(Math.max(0, at - window), at)
    // 基础词表沿用红旗层的紧邻判定（endsWith），只收"明确阴性表述"；
    // 范围层追加线索用窗口内任意位置命中，因为中文动词会隔开否定词与关键词（「没做过CT」）。
    const negated = NEGATION_TOKENS.some((n) => head.endsWith(String(n).toLowerCase()))
      || extra.some((n) => head.includes(n))
    if (!negated) return true
    from = at + k.length
  }
}

// 载入即校验（形状抄 kheireddinedev00/Medico：数据不合法就拒绝装载，不留"半条规则"可用状态）。
// 由 tests/scope_guard.mjs 调用并对**变异后的数据**验证每条拒绝路径真的会抛（防"校验器自己恒真"）。
export function validateScopeRules(list = SCOPE_RULES, meta = SCOPE_META) {
  const errs = []
  if (!Array.isArray(list) || !list.length) return ["规则表为空（零输入不得当作通过）"]
  if (typeof meta.negation_window_chars !== "number" || meta.negation_window_chars < 1) {
    errs.push(`negation_window_chars 非法：${JSON.stringify(meta.negation_window_chars)}`)
  }
  if (!Array.isArray(meta.negation_tokens_extra)) errs.push("negation_tokens_extra 必须是数组")
  const seen = new Set()
  list.forEach((r, i) => {
    const at = `#${i}${typeof r.id === "string" && r.id ? `(${r.id})` : ""}`
    if (typeof r.id !== "string" || !/^[a-z][a-z0-9_]{2,}$/.test(r.id)) errs.push(`${at}: id 须为 snake_case 且非空`)
    if (seen.has(r.id)) errs.push(`${at}: id 重复`)
    seen.add(r.id)
    if (!Array.isArray(r.keywords) || r.keywords.length < 2) errs.push(`${at}: keywords 须为 ≥2 项的数组`)
    else for (const k of r.keywords) {
      if (typeof k !== "string" || k.trim().length < 2) errs.push(`${at}: 关键词「${String(k)}」空或为裸单字（会子串横扫全文）`)
    }
    if (typeof r.title !== "string" || !r.title.trim()) errs.push(`${at}: title 为空`)
    if (typeof r.rationale !== "string" || r.rationale.length < 20) errs.push(`${at}: rationale 缺失或过短（临床取舍必须写清为什么不做）`)
    if (r.action !== "out-of-scope") errs.push(`${at}: action 只能是 out-of-scope，实测 ${JSON.stringify(r.action)}`)
    if (typeof r.doctor_note !== "string" || !r.doctor_note.trim()) errs.push(`${at}: doctor_note 为空（医生看不到该找谁）`)
  })
  return errs
}

/** 命中即返回该规则（含 rationale/doctor_note），未命中返回 null。规则顺序即优先级。 */
export function matchScopeRule(text) {
  const t = String(text || "").toLowerCase()
  const window = Number(SCOPE_META.negation_window_chars) || 4
  for (const r of SCOPE_RULES) {
    const matched = r.keywords.filter((k) => occursUnnegated(t, k, window))
    if (matched.length) {
      return { id: r.id, title: r.title, matched: matched, rationale: r.rationale, doctor_note: r.doctor_note }
    }
  }
  return null
}

// 结构化红旗明细（新增，供 dx.flag_details 使用；供界面按严重度分级展示）
export function scanFlagDetails(text) {
  const t = String(text ?? "").toLowerCase().slice(0, 2000)
  if (!t.trim()) return []
  return matchFlagRules(t)
}

// 红旗字符串（既有契约，格式不变：`严重危险信号：{name}。{advice}`）
export function scanFlags(text) {
  return scanFlagDetails(text).map((d) => `严重危险信号：${d.name}。${d.advice}`)
}

// ---------- 结构化体征 → 临床评分（第一百零四轮）----------
// 一手根因：本文件此前只解析血压（bpCrisis），而 qSOFA 在整个仓里只以散文形式存在于
// data/knowledge.json kb-054 的正文中——**没有任何可计算对象**；与此同时结构化体征
// （BP/HR/RR/SpO2/T）一直挂在病例对象上（functions/lib/data.js CASES[].vitals），
// 却只被 SOAP 报告拼成一行文本读过一次。也就是说缺口不是「没数据」，是「数据没进判读层」。
// 量表表是生成物（权威 data/clinical_scores.json），此处只住逻辑，与红旗表 #89 的分工一致。

const NUM = /-?\d+(?:\.\d+)?/
const VITAL_KEYS = { BP: "bp", HR: "hr", RR: "rr", SPO2: "spo2", T: "temperature_c" }

function firstNumber(raw) {
  const m = NUM.exec(String(raw ?? ""))
  return m ? Number(m[0]) : null
}

// 取不到就返回 null 并由调用方记进 missing——绝不返回 0：0 既像「正常」又像「没测」，
// 而本层的失败代价不对称（漏报危险信号远重于多提示），把「没测」读成「正常」正是漏报的形状。
export function parseVitalValues(vitals) {
  const out = { hr: null, rr: null, spo2: null, temperature_c: null, sbp: null, dbp: null }
  const rejected = {}
  for (const v of (Array.isArray(vitals) ? vitals : [])) {
    const key = VITAL_KEYS[String(v?.key ?? "").trim().toUpperCase()]
    if (!key) continue
    if (key === "bp") {
      const t = String(v?.value ?? "")
      const m = /(\d{2,3})\s*[/／]\s*(\d{2,3})/.exec(t)
      if (!m) { rejected.sbp = `血压形状不可解析：${JSON.stringify(t)}`; continue }
      const sys = Number(m[1]); const dia = Number(m[2])
      const [lo, hi] = PLAUSIBLE_RANGES.sbp
      if (!Number.isFinite(sys) || sys < lo || sys > hi) rejected.sbp = `收缩压 ${sys} 越出 plausible_ranges.sbp [${lo},${hi}]`
      else out.sbp = sys
      const dlo = 20; const dhi = 200
      if (Number.isFinite(dia) && dia >= dlo && dia <= dhi) out.dbp = dia
      continue
    }
    const num = firstNumber(v?.value)
    const range = PLAUSIBLE_RANGES[key]
    if (num === null) { rejected[key] = `取不到数值：${JSON.stringify(String(v?.value ?? ""))}`; continue }
    if (!range) { rejected[key] = `${key} 没有值域护栏（plausible_ranges 缺档，不许直接进评分）`; continue }
    if (num < range[0] || num > range[1]) { rejected[key] = `${key}=${num} 越出 [${range[0]},${range[1]}]`; continue }
    out[key] = num
  }
  for (const d of DERIVED_VALUES) {
    if (d.kind !== "ratio") continue
    const n = out[d.numerator]; const den = out[d.denominator]
    if (n === null || den === null || den === 0) { out[d.id] = null; continue }
    const f = 10 ** d.round
    out[d.id] = Math.round((n / den) * f) / f
  }
  return { values: out, rejected }
}

export function scoreClinicalSigns(vitals, text) {
  const { values, rejected } = parseVitalValues(vitals)
  const t = String(text ?? "").toLowerCase()
  return SCORE_TABLES.map((s) => {
    let points = 0
    let maxPoints = 0
    const missing = []
    const items = s.items.map((it) => {
      maxPoints += it.points
      if (it.need === "consciousness") {
        const hit = t.trim() ? CONSCIOUSNESS_TOKENS.some((k) => hasPositiveOccurrence(t, k)) : false
        if (!t.trim()) missing.push({ need: it.need, reason: "问诊文本为空，意识项无法评估" })
        if (hit) points += it.points
        return { label: it.label, hit }
      }
      const val = values[it.need]
      if (val === null || val === undefined) {
        missing.push({ need: it.need, reason: rejected[it.need] || "该体征未采集" })
        return { label: it.label, hit: null }
      }
      const hit = it.op === ">=" ? val >= it.value : it.op === "<=" ? val <= it.value
        : it.op === ">" ? val > it.value : val < it.value
      if (hit) points += it.points
      return { label: it.label, hit, measured: val, threshold: it.value }
    })
    const band = s.bands.find((b) => points >= b.min && points <= b.max) || null
    return {
      id: s.id, title: s.title, source: s.source, hint: s.hint,
      score: points, max_points: maxPoints,
      items, missing,
      complete: missing.length === 0,
      band,
    }
  })
}

// 评分触发的条目走**既有红旗出口**（name/severity/advice 三字段），不新增响应字段：
// 加字段要动 openapi 与双端契约快照，而把「qSOFA 2 分」降级成一条界面读不到的新维度，
// 等于给医生少一个能看见的危险信号。名称带分值，保证同一次里不同量表不会互相吞并。
export function scoreFlagDetails(vitals, text) {
  return scoreClinicalSigns(vitals, text)
    .filter((r) => r.band)
    .map((r) => withDept({
      name: `${r.title}评分 ${r.score}/${r.max_points}${r.complete ? "" : "（部分评估）"}`,
      severity: r.band.level,
      advice: r.band.advice,
    }, r.band.department))
}

// 红旗＋评分的合并出口：按 name 去重的纪律沿用 matchFlagRules（同名会被静默合并＝少报一条）。
export function scanFlagDetailsWithSigns(text, vitals) {
  const hits = [...scanFlagDetails(text), ...scoreFlagDetails(vitals, text)]
  const seen = new Set(); const out = []
  for (const h of hits) { if (!seen.has(h.name)) { seen.add(h.name); out.push(h) } }
  return out
}

export function scanFlagsWithSigns(text, vitals) {
  return scanFlagDetailsWithSigns(text, vitals).map((d) => `严重危险信号：${d.name}。${d.advice}`)
}

