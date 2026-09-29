// 红旗回链候选册探针（第七十六轮，看守件：不进 npm test、只报不拦、不写权威表）
// 轴＝对标 `cqframework/clinical_quality_language` 的 valueset 绑定：CQL 每条规则把术语绑到带 OID 的
//   valueset（`valueset "Acute Pharyngitis": '2.16.840.1...'`），规则与语料之间是**声明式回链**。
//   我方 17 条红旗（danger 13＋combo 4）每条只有 name/keywords/severity/advice，**逐条无出处**；
//   60 条语料每条都带 source/year/url。医生看到红旗提示时，处置用语能否追到某条指南要点，此前无人量过。
// 为什么本轮只测量不落地字段：给 17 条编出处正是红线「未回链的量化事实不得进入」要拦的动作——
//   **造出来的出处比没有出处更坏**。本件产「每条规则的处置用语在语料里最相近的是谁、相近到什么程度」的候选册，
//   带可复算支撑比，交下一轮逐条临床核对后再进 data/red_flag_rules.json（台账 #203 的前提）。
// 尺＝`grounding_ruler.mjs` 单一源（与 probe:grounding 同一把，不另立第二真值）；
//   两侧边界由第七十五轮实测：自证引用 1.000／刻意错配 0.059。
// 口径两次改判的实录（为什么最终不拿 keywords 当索引键）：
//   ① 第一版拿 keywords 子串在语料里找"载体"，量出「高血压急症／马尾综合征」两条**零载体**，差点写成
//      "高危红旗而无语料可依"。盘面复核实测：kb-008/018/060 正文含「高血压」、kb-053 含「危象」、
//      kb-060 含「视物模糊」、kb-049 同含「马尾」「鞍区」⇒ 语料讲的是同一件事，**词形不同**。
//   ② 第二版加 SYNONYMS 桥后仍 2 条零载体：因为红旗 keywords 是**口语侧复合短语**（"血压骤升"），
//      桥表里根本没有这一项——它的服务对象是匹配医生输入，与语料侧毫无关系（#94 那条"词必须在正文真出现"
//      只管 `red_flag_terms` 检索加权词，管不到这里）。⇒ 结论：**keywords 不是出处的索引键**，
//      拿它找载体问的是错的问题；本轮改为直接对全部语料取处置用语的字面重合，并把关键词载体数**降级为旁注**、
//      不参与任何判定。零输入守卫第一版还踩过 `!a.length + !b.length` 的优先级错（非空面被恒判空），已修。
// 复算：node frontend/tests/flag_provenance_probe.mjs
import { KNOWLEDGE_BASE } from "../functions/lib/knowledge.js"
import { RULE_TABLES } from "../functions/lib/rules.js"
import { supportRatio } from "./grounding_ruler.mjs"

const ROT = 7
const DANGER = RULE_TABLES.DANGER
const COMBO = RULE_TABLES.COMBO
const kbText = (k) => `${k.title || ""} ${k.condition || ""} ${k.text || ""}`

if (!(KNOWLEDGE_BASE.length > 0) || !(DANGER.length > 0 || COMBO.length > 0)) {
  console.log(`FAIL :: 取数面为空（语料 ${KNOWLEDGE_BASE.length} 条、规则 ${DANGER.length + COMBO.length} 条）⇒ 零输入不记绿`)
  console.log("[GATE:provenance-empty]")
  process.exit(2)
}

// 旁注用：关键词原词形在语料正文里的出现条目数。明确不参与判定，理由见文件头②。
const termsOf = (r, kind) => (kind === "DANGER" ? r.keywords : (r.all || []).flat())

const rows = []
for (const [kind, list] of [["DANGER", DANGER], ["COMBO", COMBO]]) {
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const scored = KNOWLEDGE_BASE.map((k) => ({ k, ...supportRatio(r.advice, [kbText(k)]) }))
      .filter((x) => x.ratio !== null)
      .sort((a, b) => b.ratio - a.ratio || String(a.k.id).localeCompare(String(b.k.id)))
    if (!scored.length) continue
    const best = scored[0]
    const ties = scored.filter((x) => x.ratio === best.ratio).length
    const ctrl = supportRatio(r.advice, [kbText(KNOWLEDGE_BASE[(i * ROT) % KNOWLEDGE_BASE.length])])
    const kw = termsOf(r, kind).map((t) => String(t).toLowerCase()).filter((t) => t.length > 1)
    const kwCarriers = KNOWLEDGE_BASE.filter((k) => {
      const t = kbText(k).toLowerCase()
      return kw.some((term) => t.includes(term))
    }).length
    rows.push({
      kind, i, name: r.name, severity: r.severity, best: best.k, self: best.ratio,
      ctrl: ctrl.ratio, ties, kwCarriers,
    })
  }
}

if (!rows.length) {
  console.log("FAIL :: 没有任何规则拿到可计分读数 ⇒ 对照无从建立，这不是通过")
  console.log("[GATE:provenance-empty]")
  process.exit(2)
}

const fmt = (v) => (v === null || v === undefined ? "n/a" : v.toFixed(3))
const mean = (arr) => (arr.length ? arr.reduce((a, x) => a + x, 0) / arr.length : null)
const mSelf = mean(rows.map((x) => x.self))
const mCtrl = mean(rows.filter((x) => x.ctrl !== null).map((x) => x.ctrl))
const amb = rows.filter((x) => x.ties > 1).length
const kw0 = rows.filter((x) => x.kwCarriers === 0).length

console.log("== 红旗回链候选册（17 条规则的处置用语 ⇄ 60 条语料；字面重合口径，读数=候选非结论）==")
console.log(`取数面：计分规则 ${rows.length}/${DANGER.length + COMBO.length}｜语料 ${KNOWLEDGE_BASE.length} 条`)
console.log(`最佳候选支撑比 mean=${fmt(mSelf)}｜对照（按序偏移取的另一条）mean=${fmt(mCtrl)}｜差=${fmt(mSelf - mCtrl)}`)
console.log(`并列第一（多条语料同分＝出处指认有歧义，须人工裁）：${amb}/${rows.length}`)
console.log(`旁注（不参与判定）：关键词原词形在语料正文里零出现的规则 ${kw0} 条——这是**词形不同源**，不是无据（见文件头②）`)
for (const x of [...rows].sort((a, b) => a.self - b.self)) {
  console.log(`  [${x.kind}#${x.i}] ${x.severity}｜支撑=${fmt(x.self)}／对照=${fmt(x.ctrl)}｜并列=${x.ties}→ ${x.best.id}(${x.best.source || "无source"} ${x.best.year || "?"})「${String(x.name).slice(0, 20)}」`)
}

const discriminating = mSelf > mCtrl
console.log(discriminating
  ? `[GATE:provenance-discriminating] 最佳候选高于对照（差 ${fmt(mSelf - mCtrl)}）⇒ 候选册可用于 #203 逐条核对；支撑比最低的那几条是真待核面`
  : `[GATE:provenance-blind] 最佳候选 ${fmt(mSelf)} 不高于对照 ${fmt(mCtrl)} ⇒ 尺无判别力，本册读数不得用于核对`)
process.exit(discriminating ? 0 : 1)
