// 公开仓自包含冒烟测试：无 LLM Key，验证规则降级与安全链路。
import { buildDiagnosis, buildWorkup, buildReport, extractState } from "../functions/lib/engine.js"
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
check("report 含患者名", report.soap.subjective.includes("张建国"))

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
