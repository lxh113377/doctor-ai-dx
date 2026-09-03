// 危险信号规则引擎（红旗拦截层）——对应 backend/app/rules.py
// 独立于 LLM：可解释、可单测，评审安全叙事核心

const DANGER_RULES = [
  { name: "疑似急性冠脉综合征（ACS）红旗", keywords: ["压榨", "出冷汗", "胸痛放射", "胸痛向左肩", "胸痛向后背"],
    severity: "高", advice: "压榨样胸痛伴冷汗/放射痛属高危征象，按急性胸痛路径处理：即刻 12 导联心电图 + 肌钙蛋白，尽快联系胸痛中心转运。" },
  { name: "疑似主动脉夹层红旗", keywords: ["撕裂样", "前胸背痛", "双上肢血压差", "脉搏不对称"],
    severity: "高", advice: "剧烈撕裂样胸痛高度提示主动脉夹层，避免使用抗凝药物，尽快影像学确认并转诊。" },
  { name: "疑似肺栓塞红旗", keywords: ["突发行呼吸困难", "突发气促", "D-二聚体", "单侧下肢肿"],
    severity: "高", advice: "突发呼吸困难伴 D-二聚体线索应考虑肺栓塞，评估抗凝禁忌后进一步影像确认。" },
  { name: "意识障碍/循环不稳定红旗", keywords: ["晕厥", "意识不清", "意识障碍", "血压下降"],
    severity: "高", advice: "意识障碍或血流动力学不稳定属濒危等级，优先处置并尽快转运，不宜基层滞留。" },
  { name: "消化道出血红旗", keywords: ["呕血", "黑便", "柏油样便"],
    severity: "高", advice: "呕血/黑便提示消化道出血，评估循环状态，必要时急诊胃镜与补液输血。" },
  { name: "呼吸困难红旗", keywords: ["呼吸困难", "发绀", "憋喘", "静息气促"],
    severity: "中", advice: "静息状态仍呼吸困难的危急重程度较高，需评估氧合（SpO2、血气）并决定转运。" },
]

export function scanFlags(text) {
  const hits = []
  for (const r of DANGER_RULES) {
    if (r.keywords.some((k) => text.includes(k))) {
      hits.push(`严重危险信号：${r.name}。${r.advice}`)
    }
  }
  const seen = new Set(); const out = []
  for (const h of hits) { if (!seen.has(h)) { seen.add(h); out.push(h) } }
  return out
}