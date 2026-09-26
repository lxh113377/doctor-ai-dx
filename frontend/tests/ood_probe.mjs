// 域外输入可分性测量（第二十五轮新增，**看守件不进 npm test**：只报告、不阻断）。
// 为什么存在：#52「弃权/范围外第三态」是上一轮对标直接结论（peer 有 UNKNOWN 卡／OUT_OF_SCOPE／answerability，
// 我方只有"红旗/非红旗"二值）。上一轮我据此写了"信号不可分"，那是**只看 min/max 区间**得出的错判——
// 按类别分层重测后两侧其实可分。结论不该靠一句注释留住，所以把样本、算法与判据一起入库，随时可复算。
// 纪律：本件是观察量，不是闸门（新指标先量误报率再接线；红线模块不许被它拦停）。
// 唯一会判红的两件事：① 输入面为空（没数据不许记 PASS）② 上一行结论已不可复算（口径漂移）。
import { readFileSync } from "node:fs"
import { extractState } from "../functions/lib/engine.js"
import { search } from "../functions/lib/rag.js"

const cases = JSON.parse(readFileSync(new URL("./fixtures/eval_cases.json", import.meta.url), "utf8")).cases
const ood = JSON.parse(readFileSync(new URL("./fixtures/ood_cases.json", import.meta.url), "utf8")).cases

if (!cases.length || !ood.length) {
  console.log(`FAIL 输入面为空（域内 ${cases.length} 条 / 域外 ${ood.length} 条）——零输入不得记 PASS`)
  process.exit(1)
}

function top1Evidence(answers, caseId) {
  const st = extractState(caseId, answers.map((a) => ({ role: "user", content: a })))
  const ev = search(st.transcript, 5)
  return {
    top: ev.length ? ev[0].score : 0,
    second: ev.length > 1 ? ev[0].score - ev[1].score : 0,
    n_ev: ev.length,
    n_sym: st.symptoms.length,
    n_flags: st.red_flags.length,
  }
}

// 域内按"是否危急"分层——可分性只对危急类有意义（漏一个危急诊断的代价最高）。
const inRows = cases.map((c) => ({
  id: c.id,
  cls: c.expect_flag === true ? "crit" : (c.expect_flag === false ? "noncrit" : "edge"),
  ...top1Evidence(c.answers, c.case_id || "c1"),
}))
const oodRows = ood.map((c) => ({ id: c.id, cls: "ood", ...top1Evidence(c.answers, "c1") }))

function band(rows) {
  const s = rows.map((r) => r.top)
  return { min: Math.min(...s), max: Math.max(...s), n: s.length }
}
const by = {}
for (const r of [...inRows, ...oodRows]) (by[r.cls] ||= []).push(r)
const bands = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, band(v)]))

const oodMax = bands.ood.max
const critMin = bands.crit.min
const separable = critMin > oodMax
const T = separable ? Math.round(((oodMax + critMin) / 2) * 1000) / 1000 : null

console.log("=== 域外可分性测量（top1 BM25 得分，按类别分层）===")
for (const k of ["ood", "crit", "noncrit", "edge"]) {
  if (bands[k]) console.log(`  ${k.padEnd(9)} min=${bands[k].min.toFixed(3).padStart(9)} max=${bands[k].max.toFixed(3).padStart(9)} n=${bands[k].n}`)
}
if (!separable) {
  console.log(`⇒ max(域外)=${oodMax.toFixed(3)} ≥ min(危急域内)=${critMin.toFixed(3)} ⇒ 区间重叠，**不引入伪阈值**`)
  console.log("VERDICT=INSEPARABLE（按 r11 口径：把重叠数据写进 EVAL_CARD 并据此不做）")
  process.exit(0)
}

const gap = critMin - oodMax
const abstained = [...inRows, ...oodRows].filter((r) => r.top < T)
const oodCaught = abstained.filter((r) => r.cls === "ood").length
const critHits = abstained.filter((r) => r.cls === "crit")
const inHits = abstained.filter((r) => r.cls !== "ood")

console.log(`⇒ 可分：max(域外)=${oodMax.toFixed(3)} < min(危急域内)=${critMin.toFixed(3)}，间隔 ${gap.toFixed(3)}`)
console.log(`  候选阈值 T=${T}（两侧各留 ${(T - oodMax).toFixed(3)} / ${(critMin - T).toFixed(3)}）`)
console.log(`  域外判出 ${oodCaught}/${bands.ood.n} ｜ 危急类误伤 ${critHits.length}/${bands.crit.n} ｜ 连带弃权的域内用例 ${inHits.length} 条`)
for (const r of inHits) {
  console.log(`    ${r.id} (${r.cls}) top=${r.top.toFixed(3)} 红旗=${r.n_flags} 症状数=${r.n_sym}`
    + (r.cls === "noncrit" ? "  ← 非危急：过度弃权的代价落在这里" : ""))
}
// 反向自证：阈值再抬到刚好吞掉一条危急用例，需要多少间隔——间隔越窄，这条结论越不该被当作产品承诺。
console.log(`  安全边界：任何 T ∈ (${oodMax.toFixed(3)}, ${critMin.toFixed(3)}) 都满足"域外全判出且危急零误伤"，`
  + `窗口宽度 ${gap.toFixed(3)}（占危急类最低分的 ${((gap / critMin) * 100).toFixed(1)}%）`)
console.log(`  间隔 <1.0 即视为不可靠（不足以抵抗知识库增删带来的分数漂移）：${gap >= 1 ? "当前通过" : "当前不通过"}`)
if (gap < 1.0) {
  console.log("FAIL 间隔 <1.0 ⇒ 阈值不稳健，不许据此落机制")
  process.exit(1)
}
console.log("VERDICT=SEPARABLE（阈值为**候选**，未经第二意见复验；是否接受过度弃权属产品决策）")
console.log(`[GATE:ood-probe-pass] oodMax=${oodMax.toFixed(3)} critMin=${critMin.toFixed(3)} gap=${gap.toFixed(3)}`)
process.exit(0)
