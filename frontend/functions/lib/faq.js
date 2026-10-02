// FAQ 检索封装：把既有 BM25 检索器包装成「可引用的答案包」。
//
// 三条纪律（与既有检索面一脉相承，不在这里另立一套）：
// 1. **引用只来自白名单**：citations 全部由 rag.search() 返回，引擎不生成任何 evidence_id。
// 2. **证据不足就弃权**：沿用 rag.answerability() 的三态（in-scope / out-of-scope /
//    insufficient-information），不在这里另设阈值——另设阈值就会出现两个真值。
// 3. **只有医疗问诊类意图才检索**：见 intent.js 的 shouldRetrieveFaq()。
import { search, answerability } from "./rag.js"

/** FAQ 取几条证据：与既有检索默认 topK=4 同口径。 */
export const FAQ_TOP_K = 4

/**
 * 构建答案包。
 * @param {string} query 用户本轮输入（已小写化的原文或原文本）
 * @param {Array} flags 红旗明细；非空时 answerability 直接判 in-scope（红旗优先，不做弃权）
 * @returns {{text:string,citations:Array,abstain:boolean,scope_status:string,top_score:number,evidence_ids:Array<string>}}
 */
export function buildFaqAnswer(query, flags = []) {
  const evidence = search(String(query ?? ""), FAQ_TOP_K)
  const verdict = answerability(evidence, flags)

  const citations = evidence.map((e) => ({
    evidence_id: e.id,
    title: e.title,
    source: e.source,
    year: e.year,
    section: e.section,
  }))
  const evidenceIds = evidence.map((e) => e.id)

  if (verdict.abstain) {
    return {
      text:
        verdict.scope_status === "out-of-scope"
          ? "这个问题超出了本系统可处理的范围，已为您转接人工客服进一步协助。"
          : "现有知识库证据不足，我不对此作出判断。建议线下由执业医生面诊评估。",
      citations: [],
      abstain: true,
      scope_status: verdict.scope_status,
      top_score: verdict.top_score,
      evidence_ids: [],
    }
  }

  const lines = evidence.slice(0, 3).map((e) => `· ${e.title}（${e.source}${e.year ? ` ${e.year}` : ""}）`)
  return {
    text: [
      "以下为可追溯到指南/共识的参考信息，仅供辅助参考，不能替代医生面诊：",
      ...lines,
      "如症状加重或出现新的不适，请立即线下就诊。",
    ].join("\n"),
    citations,
    abstain: false,
    scope_status: verdict.scope_status,
    top_score: verdict.top_score,
    evidence_ids: evidenceIds,
  }
}