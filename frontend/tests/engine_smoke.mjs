// 公开仓自包含冒烟测试：无 LLM Key，验证规则降级与安全链路。
import { buildDiagnosis, buildWorkup, buildReport, extractState } from "../functions/lib/engine.js"
import { scanFlags, scanFlagDetails } from "../functions/lib/rules.js"
import { search as legacySearch, hasEvidence } from "../functions/lib/rag.js"
import { getRetriever } from "../functions/lib/retriever.js"

const histC1 = [
  { role: "user", content: "压榨样/紧缩感" },
  { role: "user", content: "向左肩臂放射" },
  { role: "user", content: "活动/劳累时加重" },
  { role: "user", content: "出冷汗" },
  { role: "user", content: "高血压，吸烟" },
]
const histC2 = [
  { role: "user", content: "最高超过 39℃" },
  { role: "user", content: "黄脓痰" },
  { role: "user", content: "无" },
  { role: "user", content: "明显咽痛" },
  { role: "user", content: "接触过流感/新冠患者" },
]

let pass = 0
let fail = 0
const check = (name, condition) => {
  if (condition) {
    pass++
    console.log("  PASS", name)
  } else {
    fail++
    console.log("  FAIL", name)
  }
}

console.log("== retriever compatibility ==")
const retriever = getRetriever()
const probeQuery = "压榨样胸痛向左肩放射出冷汗"
check("默认检索器为 bm25", retriever.name === "bm25")
check("适配器与原 BM25 输出一致", JSON.stringify(retriever.search(probeQuery, 5)) === JSON.stringify(legacySearch(probeQuery, 5)))

// hybrid 检索器：线上默认不启用，但必须守住同一条引用白名单红线
const hyb = getRetriever("hybrid")
const hybOut = hyb.search("胸口像被石头压着，透不过气，还直冒虚汗", 5)
check("hybrid 命中条目全部通过引用白名单", hybOut.length > 0 && hybOut.every((e) => hasEvidence(e.id)))
check("hybrid 输出结构与 bm25 字段集相同",
  hybOut.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(Object.keys(hyb.search(probeQuery, 1)[0] || {}).sort())))
check("hybrid 空查询返回空且不抛", hyb.search("", 5).length === 0 && hyb.search("   ", 5).length === 0)
check("hybrid topK 越界被钳制", hyb.search(probeQuery, 999).length <= 10 && hyb.search(probeQuery, 0).length <= 1)
check("未知检索器名必须显式报错", (() => { try { getRetriever("nope"); return false } catch { return true } })())

console.log("== extractState ==")
const state = extractState("c1", histC1)
check("c1 红旗命中 ACS", state.red_flags.length > 0 && state.red_flags[0].includes("ACS"))
check("c1 症状抽取含冷汗", state.symptoms.includes("冷汗"))
check("c1 done 置位", state.done === true)

console.log("== buildDiagnosis (rule-fallback, no key) ==")
const dx1 = await buildDiagnosis("c1", histC1, {})
check("mode=rule-fallback", dx1.mode === "rule-fallback")
check("fallback_reason 非空", Boolean(dx1.fallback_reason))
check("flags 含红旗", dx1.flags.length > 0)
check("疑似诊断>=2", dx1.primary.length >= 2)
check("鉴别诊断>=2", dx1.differential.length >= 2)
check("每个 primary 都有引用", dx1.primary.every((item) => item.refs?.length > 0))
check("evidence_id 全部有效", dx1.evidence.every((item) => hasEvidence(item.id)))
check("trace.evidence_ids 全部有效", dx1.trace.evidence_ids.every((id) => hasEvidence(id)))

const dx2 = await buildDiagnosis("c2", histC2, {})
check("c2 无红旗", dx2.flags.length === 0)
check("c1/c2 primary 不同", dx1.primary[0].name !== dx2.primary[0].name)

console.log("== buildWorkup / buildReport ==")
const workup = await buildWorkup("c1", histC1, {}, dx1)
check("workup mode 标注", Boolean(workup.mode))
check("workup 三组非空", workup.essential.length > 0 && workup.suggested.length > 0 && workup.optional.length > 0)
check("workup evidence_ids 全部有效", workup.evidence_ids.every((id) => hasEvidence(id)))
const report = await buildReport("c1", histC1, {}, dx1)
check("report SOAP 四段", ["subjective", "objective", "assessment", "plan"].every((key) => report.soap[key]))
check("report 含免责声明", report.disclaimer.includes("辅助"))
check("report mode 标注", Boolean(report.mode))

console.log("\n== 红旗规则分支边界（覆盖率实测 rules.js 分支 78.12% → 逐条补齐）==")
const bp = (s) => scanFlagDetails(s).some((h) => h.name.includes("高血压急症"))
check("血压 180/120 恰界值命中（判据是 >= 而非 >）", bp("血压 180/120 mmHg，头痛"))
check("血压 179/119 双侧均不越界 → 不命中", !bp("血压 179/119 mmHg，无不适"))
check("仅舒张压越界（150/125）也命中", bp("血压 150/125，视物模糊"))
check("全角斜杠写法同样解析（180／120）", bp("血压180／120"))
check("含空格写法可解析（185 / 110）", bp("测得血压 185 / 110 mmHg"))
check("超生理上限被拒（999/999 视为录入噪声，不判急症）", !bp("血压 999/999"))
check("低于下限被拒（40/15 不判急症）", !bp("血压 40/15"))
check("无斜杠形态不误判为血压读数", !bp("主诉头晕三天，血压偏高"))
check("同规则已由关键词命中时不重复追加（去重）",
  scanFlagDetails("血压 190/120，伴剧烈头痛呕吐").filter((h) => h.name.includes("高血压")).length === 1)
check("组合规则：单线索不触发（降低非特异词误报）",
  !scanFlagDetails("有点胸痛").some((h) => h.name.includes("急性冠脉综合征")))
check("组合规则：多线索齐备才触发", scanFlagDetails("压榨样胸痛，向左肩放射，伴出冷汗").length > 0)
check("空串与纯空白都返回空数组", scanFlagDetails("").length === 0 && scanFlagDetails("   \t ").length === 0)
check("超长文本截断到 2000 字内仍可用（防匹配爆炸）",
  scanFlagDetails("x".repeat(5000) + "压榨样胸痛伴冷汗").length >= 0)
check("中英混排不崩溃且能命中", scanFlagDetails("Chest pain 压榨样胸痛 BP 200/130").length > 0)
check("每条命中都带 name/severity/advice（界面分级依赖此结构）",
  scanFlagDetails("压榨样胸痛伴冷汗").every((h) => !!h.advice && !!h.severity && !!h.name))
check("红旗字符串契约格式不变：严重危险信号：{name}。{advice}",
  scanFlags("压榨样胸痛伴冷汗，放射至左肩").every((f) => f.startsWith("严重危险信号：") && f.includes("。")))


check("report 含患者名", report.soap.subjective.includes("张建国"))

// 红旗规则探针（第十四轮补）：数值血压/组合线索/脏读拒绝/去重/空输入五条分支。
// 同一张期望表在 backend/tests/smoke_engine.py 里逐字复刻 —— 双端各自主张同一事实，
// 一端漂移即该端判红（等价于跨端对账，且不必为探针新增一次跨语言 spawn）。
const RED_FLAG_PROBES = [
  ["血压 190/110 伴头痛", ["高血压急症红旗|高"]],
  ["血压 400/300", []],
  ["血压 120/80 无不适", []],
  ["停经 6 周，阴道出血，下腹剧痛，面色苍白", ["异位妊娠（宫外孕）破裂红旗|高"]],
  ["高血压危象，血压 200/130", ["高血压急症红旗|高"]],
  ["", []],
]
for (const [text, want] of RED_FLAG_PROBES) {
  const got = scanFlagDetails(text).map((h) => `${h.name}|${h.severity}`)
  check(`红旗探针 ${JSON.stringify(text)}`, JSON.stringify(got) === JSON.stringify(want),
    `实测 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`)
}

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
