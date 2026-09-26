// 危险信号规则引擎（红旗拦截层）——独立于 LLM：可解释、可单测，评审安全叙事核心
// 设计原则：关键词须特异（避免"出冷汗"这类非特异词单独触发 ACS 造成误报）；
//          支持数值解析（血压）；命中即强制转诊提示，优先级高于模型输出。
import { SCOPE_META, SCOPE_RULES } from "./scope_rules.js"

const DANGER_RULES = [
  { name: "疑似急性冠脉综合征（ACS）红旗", keywords: ["压榨", "紧缩", "胸痛放射", "胸痛向左肩", "胸痛向后背", "向左肩臂放射", "心前区闷痛"],
    severity: "高", advice: "压榨/紧缩样胸痛伴放射痛属高危征象，按急性胸痛路径处理：即刻 12 导联心电图 + 肌钙蛋白，尽快联系胸痛中心转运。" },
  { name: "疑似主动脉夹层红旗", keywords: ["撕裂样", "前胸背痛", "双上肢血压差", "脉搏不对称", "刀割样痛"],
    severity: "高", advice: "剧烈撕裂样胸痛高度提示主动脉夹层，避免使用抗凝药物，尽快影像学确认并转诊。" },
  { name: "疑似肺栓塞红旗", keywords: ["突发呼吸困难", "突发气促", "D-二聚体", "单侧下肢肿", "下肢肿胀", "制动后气促"],
    severity: "高", advice: "突发呼吸困难伴下肢肿/D-二聚体线索应考虑肺栓塞，评估抗凝禁忌后进一步影像确认。" },
  { name: "意识障碍/循环不稳定红旗", keywords: ["晕厥", "晕倒", "意识不清", "意识障碍", "不省人事", "血压下降", "休克"],
    severity: "高", advice: "意识障碍或血流动力学不稳定属濒危等级，优先处置并尽快转运，不宜基层滞留。" },
  { name: "消化道出血红旗", keywords: ["呕血", "黑便", "柏油样便", "咖啡色呕吐物", "便血"],
    severity: "高", advice: "呕血/黑便提示消化道出血，评估循环状态，必要时急诊胃镜与补液输血。" },
  { name: "呼吸困难红旗", keywords: ["呼吸困难", "发绀", "憋喘", "静息气促", "喘不上气"],
    severity: "中", advice: "静息状态仍呼吸困难的危急重程度较高，需评估氧合（SpO2、血气）并决定转运。" },
  { name: "急腹症/腹膜炎红旗", keywords: ["腹膜刺激", "反跳痛", "压痛拒按", "腹部硬", "板状腹", "腹痛进行性加重", "腹痛加重", "一按更痛"],
    severity: "高", advice: "腹痛伴腹膜刺激征或进行性加重提示外科急症，应禁食补液、尽快转诊，不宜基层观察。" },
  { name: "高血压急症红旗", keywords: ["血压骤升", "血压很高", "视物模糊伴头痛", "高血压危象"],
    severity: "高", advice: "血压显著升高伴靶器官损害症状（剧烈头痛、视物模糊、胸痛）为高血压急症，需静脉降压并急诊处理，不宜口服药观察。" },
  { name: "霹雳样头痛/颅内急症红旗", keywords: ["霹雳样", "突发剧烈头痛", "一生中最痛", "颈项强直"],
    severity: "高", advice: "突发霹雳样剧烈头痛高度提示蛛网膜下腔出血，紧急影像学评估并转诊，勿按普通头痛处理。" },
  { name: "急性会厌炎/上气道梗阻红旗", keywords: ["流涎", "喉部紧缩", "端坐呼吸", "说话含糊"],
    severity: "高", advice: "剧烈咽痛伴流涎不能下咽、说话含糊或呼吸困难，警惕急性会厌炎致上气道梗阻窒息，禁止反复压舌检查，立即转诊并备气道。" },
  { name: "过敏性休克/血管性水肿红旗", keywords: ["口唇肿胀", "眼睑肿胀", "全身风团伴气促", "喉头水肿"],
    severity: "高", advice: "皮疹伴口唇/眼睑肿胀、喉部紧缩或呼吸困难提示血管性水肿/过敏性休克，立即肌注肾上腺素并急诊转运，勿口服药观察。" },
  { name: "马尾综合征红旗", keywords: ["鞍区麻木", "大小便失禁", "会阴麻木", "尿不出伴下肢无力"],
    severity: "高", advice: "腰痛伴鞍区麻木、大小便功能障碍或进行性下肢无力提示马尾综合征，属外科急症，24–48 小时内急诊手术减压，立即转诊。" },
  { name: "视力骤降/眼科急症红旗", keywords: ["视力骤降", "突然看不见", "视野幕帘遮挡", "眼痛伴虹圈"],
    severity: "高", advice: "突发视力显著下降或视野幕帘遮挡提示视网膜血管阻塞/视网膜脱离，救治以小时计，立即转诊眼科急诊，基层不得观察等待。" },
]

// 组合规则：多线索同时命中才触发（表达临床组合逻辑，降低单一非特异词误报）
const COMBO_RULES = [
  { name: "异位妊娠（宫外孕）破裂红旗", all: [["停经", "闭经", "月经没来"], ["阴道出血", "下腹剧痛", "腹痛", "腹部疼痛"], ["晕厥", "头晕", "面色苍白", "血压下降", "肩部放射痛"]],
    severity: "高", advice: "育龄女性停经后阴道出血伴下腹剧痛及晕厥/面色苍白，高度警惕异位妊娠破裂内出血：立即尿妊娠试验与超声，禁食开放静脉并紧急转诊，不可按痛经或胃肠炎处理。" },
  { name: "肠套叠红旗（婴幼儿）", all: [["哭闹", "阵发", "婴幼儿", "小儿", "孩子"], ["果酱样便", "血便", "呕吐", "面色苍白"]],
    severity: "高", advice: "婴幼儿阵发性哭闹伴呕吐、面色苍白或果酱样血便高度提示肠套叠，属儿科急症：禁食并立即转诊空气灌肠复位，超 48 小时或精神萎靡提示肠坏死。" },
  { name: "急性尿潴留红旗", all: [["尿不出", "不能排尿", "无尿"], ["下腹胀痛", "腹痛", "老年男性"]],
    severity: "中", advice: "完全不能排尿伴下腹胀痛为急性尿潴留，需导尿减压并转诊泌尿外科，警惕梗阻性肾损害。" },
  { name: "脓毒症红旗", all: [["发热", "高热", "寒战", "感染", "尿痛", "咳嗽", "伤口"], ["意识改变", "意识不清", "意识模糊", "说胡话", "晕厥", "精神差", "嗜睡", "呼吸急促", "气促", "少尿", "尿量明显减少", "无尿", "血压下降", "血压偏低", "末梢湿冷"]],
    severity: "高", advice: "感染基础上出现意识改变、呼吸急促、少尿或血压下降提示脓毒症，死亡风险随延迟上升：留取培养、液体复苏、尽早抗菌并紧急转诊。" },
]

// 血压数值解析：收缩压≥180 或舒张压≥120 → 高血压急症
const BP_SYS = 180
const BP_DIA = 120
const HYPERTENSION_ADVICE = DANGER_RULES.find((r) => r.name.includes("高血压"))?.advice || "血压显著升高伴靶器官损害症状为高血压急症，需急诊处理。"
function bpCrisis(text) {
  const t = String(text ?? "")
  const m = t.match(/(\d{2,3})\s*[/／]\s*(\d{2,3})/)
  if (!m) return false
  const sys = parseInt(m[1], 10)
  const dia = parseInt(m[2], 10)
  if (!Number.isFinite(sys) || !Number.isFinite(dia)) return false
  if (sys > 350 || dia > 250 || sys < 50 || dia < 20) return false
  return sys >= BP_SYS || dia >= BP_DIA
}

// 否定修饰：中文临床文本用「无/没有/未/否认…」直接修饰症状词表达阴性。
// 既往按子串命中 ⇒ "无气促" 命中 "气促"，脓毒症红旗假阳性（第二十四轮由产品路径评测实测抓到）。
// 只收「明确阴性表述」：不收 "排除/不支持/不" —— "不能排除心前区闷痛" 若被抑制就是漏报，
// 而本层的失败代价不对称（漏报危险信号远重于多提示），故宁缺毋滥。
const NEGATION_TOKENS = ["没有", "未见", "未出现", "无明显", "无伴", "不伴", "否认", "阴性", "无", "未"]
const NEG_LOOKBEHIND = 4
// 形似否定实为阳性体征的词，必须先于否定判定放行，否则把「尿闭」当阴性 ⇒ 制造漏报。
// follow 是该词之后不得紧跟的字：否则 "无尿痛" 会先命中 "无尿" 这条阳性例外。
const POSITIVE_TERMS = [{ term: "无尿", follow: ["痛", "频", "急", "不尽"] }]

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
function matchFlagRules(t) {
  const hits = []
  const hit = (k) => hasPositiveOccurrence(t, k)
  for (const r of DANGER_RULES) {
    if (r.keywords.some(hit)) {
      hits.push({ name: r.name, severity: r.severity, advice: r.advice })
    }
  }
  // 组合规则：每个线索组至少命中一词才触发（表达"症状组合"临床逻辑，降低单非特异词误报）
  for (const r of COMBO_RULES) {
    if (r.all.every((group) => group.some(hit))) {
      hits.push({ name: r.name, severity: r.severity, advice: r.advice })
    }
  }
  if (bpCrisis(t) && !hits.some((h) => h.name.includes("高血压急症"))) {
    hits.push({ name: "高血压急症红旗", severity: "高", advice: HYPERTENSION_ADVICE })
  }
  const seen = new Set(); const out = []
  for (const h of hits) { if (!seen.has(h.name)) { seen.add(h.name); out.push(h) } }
  return out
}

export const RULE_TABLES = { DANGER: DANGER_RULES, COMBO: COMBO_RULES, NEGATIONS: NEGATION_TOKENS, POSITIVES: POSITIVE_TERMS }

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
