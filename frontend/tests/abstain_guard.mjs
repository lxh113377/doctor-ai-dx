// 弃权第三态守卫（第二十八轮新增，台账 #52；npm test 第 21 件套）。
// 为什么单独成件：#52 的产物是一个手写在源码里的阈值常量加一套对外文案，而它的正确性依据
// （域外/危急分数间隙）活在另一条测量里——正是第二十六轮"modelSha256 是手抄的、守卫只核形状"那一族形状。
// 本件把「常量 - 实算 - 双端」三方钉在一起。
// 红线：弃权永远不能吞掉红旗。peer 实测两家的同向取舍：`kheireddinedev00/Medico` 弃权时红旗照出并配具名测试
// test_out_of_scope_still_honours_red_flags；`dmustapha/triage-0` 用三条决定性体征"禁止弃权"。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { ABSTAIN_T, answerability } from "../functions/lib/rag.js"
import { ABSTAIN_PRIMARY, ABSTAIN_NOTE, buildDiagnosis } from "../functions/lib/engine.js"
import { RULE_TABLES } from "../functions/lib/rules.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name, detail ? ":: " + detail : "") }
}
const py = (code) => execFileSync(process.env.PYTHON_BIN || "python", ["-c", code],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim()

console.log("== 阈值与对外文案：双端同名同值 ==")
const pyT = Number(py("import sys;sys.path.insert(0,'backend');from app.rag import ABSTAIN_T;print(ABSTAIN_T)"))
check("ABSTAIN_T 双端同值 JS=" + ABSTAIN_T + " Py=" + pyT, Math.abs(pyT - ABSTAIN_T) < 1e-9)
const SEP = String.fromCharCode(1)
const pyOut = py("import sys;sys.path.insert(0,'backend');"
  + "from app.services.engine import ABSTAIN_PRIMARY as p, ABSTAIN_NOTE as n;print(p+chr(1)+n)")
const pyPrimary = pyOut.split(SEP)[0]
const pyNote = pyOut.split(SEP)[1] || ""
check("ABSTAIN_PRIMARY 双端逐字同值", pyPrimary === ABSTAIN_PRIMARY, "JS=" + ABSTAIN_PRIMARY + " Py=" + pyPrimary)
check("ABSTAIN_NOTE 双端逐字同值", pyNote === ABSTAIN_NOTE, "长度 JS=" + ABSTAIN_NOTE.length + " Py=" + pyNote.length)

console.log("== 红旗优先于弃权（红线：弃权不得吞掉危险信号）==")
// 真阳性文本直接从规则表派生（分母由枚举器给，不手挑）：每条 DANGER 规则取其第一个关键词组拼成主诉。
const flagTexts = []
for (const [, rule] of Object.entries(RULE_TABLES.DANGER || {})) {
  const groups = rule.keywords || rule.groups || []
  const text = groups.map((g) => (Array.isArray(g) ? g[0] : g)).join("，")
  if (text) flagTexts.push(text)
}
check("红旗探针分母非空（从规则表派生 " + flagTexts.length + " 条，为 0 即判据失效）", flagTexts.length >= 5)
let flagMiss = 0
let flagProbes = 0
for (const t of flagTexts) {
  // 走真实链路而不是手搓入参：只有这样才证明"红旗优先于阈值"发生在产品路径上，
  // 而不是只证明 answerability 这个纯函数自己说得通（第二十四轮判据测错对象的教训）。
  const dx = await buildDiagnosis("c1", [{ role: "user", content: t }], {})
  if (!Array.isArray(dx.flags) || dx.flags.length === 0) continue // 该文本没真触发红旗，跳过但不计入分母
  flagProbes++
  if (dx.abstain !== false || dx.scope_status !== "in-scope") {
    flagMiss++
    console.log("  证据：红旗", dx.flags[0].slice(0, 18), "但 abstain=", dx.abstain, "top=", dx.top_evidence_score)
  }
}
check("红旗探针确实触发了红旗（≥3 条，否则本判据没有分母）", flagProbes >= 3, "实测 " + flagProbes)
check("真实链路上红旗命中即不弃权（" + flagProbes + " 条探针）", flagMiss === 0, "有 " + flagMiss + " 条被弃权")
// 纯函数边界另测一遍：链路测试只能证明"当前这批文本没被弃权"，边界形状要单独钉住
check("零证据判为 out-of-scope 而非 insufficient-information",
  answerability([], []).scope_status === "out-of-scope", JSON.stringify(answerability([], [])))
check("红旗在场时即使分数极低也不弃权（分数不是弃权的充分条件）",
  answerability([{ id: "kb-001", score: 0.001 }], ["脓毒症"]).abstain === false)
check("分数达标且无红旗时不弃权（弃权不是常态）",
  answerability([{ id: "kb-001", score: ABSTAIN_T + 1 }], []).abstain === false)

console.log("== 弃权时的字段形状（引用与红旗必须仍在场；输入用已入库的域外测量集）==")
// 不用临时编的输入：`fixtures/ood_cases.json` 就是阈值derive 的那 10 条域外用例，
// 拿它当断言输入才能保证"阈值怎么来的"与"功能对不对"共用同一批数据（不留第二真值）。
const ood = JSON.parse(readFileSync(new URL("./fixtures/ood_cases.json", import.meta.url), "utf8")).cases
check("域外测量集非空（为 0 即分母失效）", ood.length >= 10, "实测 " + ood.length)
const jsAb = []
for (const c of ood) {
  const dx = await buildDiagnosis(c.case_id || "c1", (c.answers || []).map((a) => ({ role: "user", content: a })), {})
  jsAb.push({ id: c.id, abstain: dx.abstain, scope: dx.scope_status, top: dx.top_evidence_score,
    n0: dx.primary?.[0]?.name, diff: (dx.differential || []).length,
    reason: dx.abstain_reason || "", ev: (dx.evidence || []).length, flags: Array.isArray(dx.flags) })
}
const notAbs = jsAb.filter((r) => !r.abstain)
check("10 条域外输入全部弃权（JS）", notAbs.length === 0, notAbs.map((r) => `${r.id} top=${r.top}`).join(","))
check("弃权卡只出一次且 differential 为空", jsAb.every((r) => r.n0 === ABSTAIN_PRIMARY && r.diff === 0),
  jsAb.filter((r) => r.n0 !== ABSTAIN_PRIMARY || r.diff !== 0).map((r) => r.id).join(","))
check("弃权理由含「医生」主导口径（第三条红线）",
  jsAb.every((r) => r.reason.includes("医生")),
  jsAb.filter((r) => !r.reason.includes("医生")).map((r) => r.id + ":" + r.reason).join(","))
// 红线文案是**裸子串**判据（e2e 全站扫 `not.toContain("替代医生")`），所以新增的每一句对外文案
// 都必须自己过这条扫描——本轮我自己写的"不替代医生判断"就撞上了（含否定语义但子串命中），
// 与第二十四轮 `无气促` 命中 `气促` 同族。修法：改文案，不改判据。
const RED_LINE_FORBIDDEN = JSON.parse(
  readFileSync(new URL("./fixtures/red_line_phrases.json", import.meta.url), "utf8")).forbidden_phrases
const abstainTexts = [ABSTAIN_PRIMARY, ABSTAIN_NOTE, ...jsAb.map((r) => r.reason)]
const rlBad = []
for (const t of abstainTexts) {
  for (const bad of RED_LINE_FORBIDDEN) if (t && t.includes(bad)) rlBad.push(`「${t.slice(0, 24)}…」含禁用串 ${bad}`)
}
// "必须体现医生主导"只施加在**成句文案**上（卡片标题是给列表用的短语，不该被要求写整句）；
// 禁用串扫描仍覆盖全部文本——收窄的是第二条，不是第一条。
for (const t of [ABSTAIN_NOTE, ...jsAb.map((r) => r.reason)]) {
  if (t && !t.includes("医生") && !t.includes("鉴别")) rlBad.push(`弃权文案未体现医生主导：${t.slice(0, 24)}`)
}
check("弃权对外文案过全站红线裸子串扫描（" + abstainTexts.length + " 条文本）", rlBad.length === 0, rlBad.slice(0, 3).join(" ;; "))
check("弃权时红旗字段照常给出且 evidence 结构完整", jsAb.every((r) => r.flags && r.ev >= 0))

console.log("== 双端同输入同结论 ==")
const pyAb = JSON.parse(py("import sys,json;sys.path.insert(0,'backend');"
  + "from app.services.engine import build_diagnosis as b;"
  + "import io;"
  + "ood=json.load(io.open('frontend/tests/fixtures/ood_cases.json',encoding='utf-8'))['cases'];"
  + "out=[];"
  + " [out.append({'id':c['id'],'abstain':d['abstain'],'scope':d['scope_status'],'top':d['top_evidence_score'],"
  + "'n0':d['primary'][0]['name'],'diff':len(d['differential'])}) for c in ood "
  + "for d in [b(c.get('case_id','c1'),[{'role':'user','content':a} for a in c['answers']])]];"
  + "print(json.dumps(out,ensure_ascii=False))"))
check("Py 侧 10 条域外同样全部弃权", pyAb.every((r) => r.abstain === true),
  pyAb.filter((r) => !r.abstain).map((r) => r.id).join(","))
check("双端 abstain/scope/弃权卡文案逐条一致",
  jsAb.every((r, i) => pyAb[i] && pyAb[i].id === r.id && pyAb[i].abstain === r.abstain
    && pyAb[i].scope === r.scope && pyAb[i].n0 === r.n0),
  jsAb.map((r, i) => (pyAb[i]?.scope === r.scope ? "" : r.id + " " + r.scope + "≠" + pyAb[i]?.scope)).join(","))
check("双端 top_evidence_score 同值（同一 BM25 打分，容差 1e-6）",
  jsAb.every((r, i) => Math.abs(pyAb[i].top - r.top) < 1e-6),
  jsAb.map((r, i) => (Math.abs(pyAb[i].top - r.top) < 1e-6 ? "" : r.id + ":" + r.top + "/" + pyAb[i].top)).filter(Boolean).join(","))

console.log("== 阈值 - 实算 互相对账（复用 ood_probe，不留第二真值）==")
let probeOut = ""
try {
  probeOut = execFileSync(process.execPath, ["tests/ood_probe.mjs"], { cwd: ROOT + "frontend", encoding: "utf8" })
} catch (e) {
  probeOut = String(e.stdout || "") + String(e.stderr || "")
  check("ood_probe 复算未判红", false, probeOut.split("\n").slice(0, 3).join(" / "))
}
if (probeOut) {
  check("probe 给出 [GATE:ood-probe-pass]（间隙仍可复算）", probeOut.includes("[GATE:ood-probe-pass]"))
  check("probe 给出 [GATE:ood-threshold-locked]（ABSTAIN_T 落在实测间隙且等于中点）",
    probeOut.includes("[GATE:ood-threshold-locked]"))
}

console.log("\nRESULT: " + pass + " pass / " + fail + " fail")
process.exit(fail ? 1 : 0)
