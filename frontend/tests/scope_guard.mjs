// 适用范围规则守卫（第二十九轮新增，台账 #76；npm test 第 22 件套）。
// 为什么必须单独成件：本轮把「哪些事本系统不做」从代码里搬到 data/scope_rules.json，
// 数据一旦可编辑，就必须有三件事同时成立才敢信它：
//   ① 数据自身合法（载入即校验，且每条拒绝路径都用变异数据证明它真的会拒）；
//   ② 双端生成物与权威逐字段全等（防"改一处忘另一处"，同 knowledge.js→knowledge.py 那条链的病）；
//   ③ 每条规则有正/反双向探针（只测正例＝规则写坏了也绿；只测反例＝永不触发也绿）。
// 形状借鉴 kheireddinedev00/Medico（数据 + 载入即拒 + 具名安全测试），不抄它的阈值。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildDiagnosis } from "../functions/lib/engine.js"
import { matchScopeRule, validateScopeRules } from "../functions/lib/rules.js"
import { SCOPE_META, SCOPE_RULES, SCOPE_RULE_IDS } from "../functions/lib/scope_rules.js"
import { CASES } from "../functions/lib/data.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name, detail ? ":: " + detail : "") }
}
const py = (code) => execFileSync(process.env.PYTHON_BIN || "python", ["-c", code],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim()
const FIELDS = ["id", "title", "keywords", "rationale", "action", "doctor_note"]

console.log("== ① 权威数据合法 + 生成物三方全等 ==")
const authority = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/scope_rules.json", import.meta.url)), "utf8"))
const authRules = authority.rules.map((r) => Object.fromEntries(FIELDS.map((f) => [f, r[f]])))
check("权威 JSON 的规则数 ≥ 3（少于 3 即射程可疑）", authority.rules.length >= 3, `实测 ${authority.rules.length}`)
const AUTH_META = { negation_window_chars: authority.negation_window_chars, negation_tokens_extra: authority.negation_tokens_extra }
const authErrs = validateScopeRules(authority.rules, AUTH_META)
check("权威数据通过载入即校验", authErrs.length === 0, authErrs.join(" ;; "))
const jsEqual = JSON.stringify(SCOPE_RULES) === JSON.stringify(authRules)
check("JS 生成物 == 权威（逐字段全等，含顺序）", jsEqual,
  SCOPE_RULES.map((r, i) => (JSON.stringify(r) === JSON.stringify(authRules[i]) ? "" : r.id)).filter(Boolean).join(","))
check("JS 生成物的元数据 == 权威", SCOPE_META.negation_window_chars === authority.negation_window_chars
  && JSON.stringify(SCOPE_META.negation_tokens_extra) === JSON.stringify(authority.negation_tokens_extra),
  JSON.stringify(SCOPE_META))
const pyDump = py("import sys,json;sys.path.insert(0,'backend');from app.scope_rules import SCOPE_RULES, SCOPE_META;"
  + "print(json.dumps({'rules':SCOPE_RULES,'meta':SCOPE_META},ensure_ascii=False))")
const pySide = JSON.parse(pyDump)
check("Py 生成物 == 权威（双端同源同值）", JSON.stringify(pySide.rules) === JSON.stringify(authRules)
  && pySide.meta.negation_window_chars === authority.negation_window_chars,
  `Py ${pySide.rules.length} 条 / JS ${SCOPE_RULES.length} 条`)

console.log("== ② 校验器的每条拒绝路径都要真的会拒（变异数据自证）==")
const mutate = [
  ["空规则表", [], SCOPE_META],
  ["裸单字关键词", [{ id: "x_rule_one", title: "t", keywords: ["猫", "宠物"], rationale: "这是一条足够长的理由说明为什么本系统不做这件事", action: "out-of-scope", doctor_note: "n" }], SCOPE_META],
  ["缺 rationale", [{ ...SCOPE_RULES[0], rationale: "" }], SCOPE_META],
  ["id 重复", [SCOPE_RULES[0], SCOPE_RULES[0]], SCOPE_META],
  ["非法 action", [{ ...SCOPE_RULES[0], action: "abstain" }], SCOPE_META],
  ["窗口为 0", SCOPE_RULES, { ...SCOPE_META, negation_window_chars: 0 }],
  ["doctor_note 为空", [{ ...SCOPE_RULES[0], doctor_note: "" }], SCOPE_META],
  ["keywords 不是数组", [{ ...SCOPE_RULES[0], keywords: "CT" }], SCOPE_META],
  ["keywords 含非字符串", [{ ...SCOPE_RULES[0], keywords: ["CT片子", 42] }], SCOPE_META],
  ["rationale 非字符串", [{ ...SCOPE_RULES[0], rationale: 7 }], SCOPE_META],
  ["缺 tokens_extra", SCOPE_RULES, { negation_window_chars: SCOPE_META.negation_window_chars }],
]
for (const [name, list, meta] of mutate) {
  const errs = validateScopeRules(list, meta)
  check(`变异「${name}」被拒绝`, errs.length > 0, errs.length ? "" : "校验器恒真＝这条拒绝路径不存在")
}
check("未变异的原样数据必须通过（防校验器恒假）", validateScopeRules(SCOPE_RULES, SCOPE_META).length === 0,
  validateScopeRules(SCOPE_RULES, SCOPE_META).join(" ;; "))

console.log("== ③ 每条规则正/反双向探针 ==")
const probes = JSON.parse(readFileSync(new URL("./fixtures/scope_probes.json", import.meta.url), "utf8"))
check(`探针覆盖：正向 ${probes.positive.length} 条、反向 ${probes.negative.length} 条，均 ≥ 规则数`,
  probes.positive.length >= SCOPE_RULES.length && probes.negative.length >= SCOPE_RULES.length)
const covered = new Set()
for (const p of probes.positive) {
  const hit = matchScopeRule(p.text)
  if (hit) covered.add(hit.id)
  check(`正探针命中 ${p.rule}：${p.text.slice(0, 16)}`, hit?.id === p.rule, `实测 ${hit?.id || "no-hit"}`)
}
for (const p of probes.negative) {
  const hit = matchScopeRule(p.text)
  check(`反探针不命中 ${p.rule}：${p.text.slice(0, 16)}`, !hit || hit.id !== p.rule, `误命中 ${hit?.id}`)
}
for (const id of SCOPE_RULE_IDS) check(`规则 ${id} 有正向探针覆盖`, covered.has(id), "没有任何探针触发过它")

console.log("== ④ 真实链路：红旗不被范围命中吞掉 + 不伤既有评测用例 ==")
const both = await buildDiagnosis("c1", [
  { role: "user", content: "压榨样胸痛" }, { role: "user", content: "出冷汗" },
  { role: "user", content: "顺便问下这个CT报告怎么看" }, { role: "user", content: "向左肩放射" },
  { role: "user", content: "高血压病史" }, { role: "user", content: "吸烟" }], {})
check("红旗 + 范围外同时在场：abstain=true 且 flags 非空（红线）",
  both.abstain === true && both.flags.length > 0 && both.scope_rule === "imaging_or_report_reading",
  `abstain=${both.abstain} flags=${JSON.stringify(both.flags.slice(0, 1))} rule=${both.scope_rule}`)
check("范围命中仍保留 evidence 结构（引用可溯源不因范围消失）", Array.isArray(both.evidence))
check("范围外理由来自数据文件的 doctor_note（不是代码里硬编码）",
  both.abstain_reason === SCOPE_RULES.find((r) => r.id === "imaging_or_report_reading").doctor_note,
  both.abstain_reason)

// 误伤的定义要划清：**gold 已声明"弃权即正确答案"的用例被范围规则命中，是更准而不是退化**
// （ev-25「问猫」此前只因分数低于阈值偶然弃权，现在因"非人类患者"这条正确的理由弃权）。
// 其余任何一例被命中都是真误伤 ⇒ 回退关键词，不许放宽本断言（同 #71 的"重新划界 + 对偶断言"规矩）。
const goldForScope = JSON.parse(readFileSync(new URL("./fixtures/dx_gold.json", import.meta.url), "utf8")).cases
const goldById = new Map(goldForScope.map((g) => [g.id, g]))
const evalCases = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8")).cases
const hurt = []
const better = []
for (const c of evalCases) {
  const t = [(CASES[c.case_id]?.chief || ""), ...(c.answers || [])].join("；")
  const hit = matchScopeRule(t)
  if (!hit) continue
  const g = goldById.get(c.id)
  const wantsAbstain = !!g && g.abstain_ok === true
    && (g.expect_top1 || []).includes("信息不足，建议补充问诊")
  if (wantsAbstain) better.push(`${c.id}→${hit.id}`)
  else hurt.push(`${c.id}→${hit.id}`)
}
check(`31 例既有用例零真误伤（命中即回退关键词，不许放宽本断言）：误伤 ${hurt.length} 条`,
  hurt.length === 0, hurt.join(","))
console.log(`  INFO 因正确理由改判弃权：${better.join(",") || "无"}`)

console.log("== ④b 范围命中不得出现在真实病例上（对照） ==")
const realHits = []
for (const cid of Object.keys(CASES)) {
  const hit = matchScopeRule([CASES[cid].chief, ...(CASES[cid].prompts || [])].join("；"))
  if (hit) realHits.push(`${cid}→${hit.id}`)
}
check("3 张演示病例卡文本不触发任何范围规则", realHits.length === 0, realHits.join(","))
check("对照：真实病例文本确实不该命中范围规则（探针分母非虚）", Object.keys(CASES).length >= 3)

console.log("== ⑤ 双端同输入同结论 ==")
const pyHits = py("import sys,json;sys.path.insert(0,'backend');from app.rules import match_scope_rule as m;"
  + "import io;ps=json.load(io.open('frontend/tests/fixtures/scope_probes.json',encoding='utf-8'));"
  + "print(json.dumps([[p['text'], (m(p['text']) or {}).get('id')] for p in ps['positive']+ps['negative']], ensure_ascii=False))")
const rows = JSON.parse(pyHits)
let mismatch = 0
for (const [text, pyId] of rows) {
  const jsId = matchScopeRule(text)?.id || null
  if (jsId !== pyId) { mismatch++; console.log(`  双端不一致: ${text.slice(0, 20)} JS=${jsId} Py=${pyId}`) }
}
check(`逐探针双端结论一致（${rows.length} 条）`, mismatch === 0, `${mismatch} 条不一致`)

console.log("== ⑥ 对外文案过红线裸子串扫描 ==")
const bad = ["替代医生", "自动诊断", "确诊为"]
const texts = SCOPE_RULES.flatMap((r) => [r.title, r.rationale, r.doctor_note])
const hits = []
for (const t of texts) for (const b of bad) if (t && t.includes(b)) hits.push(`${t.slice(0, 18)} 含 ${b}`)
check(`范围文案过裸子串红线扫描（${texts.length} 段）`, hits.length === 0, hits.slice(0, 3).join(" ;; "))
// 逐条覆盖，不按"跑到的用例"算：本轮实测——engine_eval 的"弃权理由必须含医生"只在**被用例触发的规则**上生效，
// 剂量这条没被 31 例触达，它的 doctor_note 若缺医生主导口径就会静默出厂（同 #75 那类"覆盖来自巧合"）。
const noDoctor = SCOPE_RULES.filter((r) => !/医生|医师/.test(`${r.doctor_note}${r.rationale}`)).map((r) => r.id)
check(`每条规则的对外文案都含医生主导口径（${SCOPE_RULES.length} 条逐条核，不等用例覆盖）`,
  noDoctor.length === 0, noDoctor.join(","))
check("扫描确有输入（文案段数 ≥ 9，为 0 即判据失效）", texts.length >= SCOPE_RULES.length * 3)

console.log("\nRESULT: " + pass + " pass / " + fail + " fail")
process.exit(fail ? 1 : 0)
