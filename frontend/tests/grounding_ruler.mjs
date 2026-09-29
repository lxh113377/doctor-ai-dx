// 引用落地性的那把尺（单一源）——grounding_probe 与 flag_provenance_probe 共用。
// 为什么单独成件：第二把尺就是第二真值，两把尺对同一对（结论, 证据）可以给出不同读数而各自绿。
// 语义抄 `vibrantlabsai/ragas` 的 QuotedSpansAlignment（零 LLM、零 gold、只看 response+contexts 的字面重合），
// 因中文无词间空格，把"quoted span"落到**字符二元组集合**上：支撑比 = 断言二元组里能在证据正文找到的比例。
export const MIN_SPAN = 4 // 短于 4 字的断言（"肺炎""头痛"）不参与比值：二元组只剩 1 个元素，噪声压倒信号
const PUNCT_RE = /[\s\p{P}\p{S}]/gu

export function bigrams(s) {
  const t = String(s ?? "").toLowerCase().replace(PUNCT_RE, "")
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

export function supportRatio(claim, sources) {
  const cb = bigrams(claim)
  if (cb.size === 0) return { ratio: null, spans: 0, hit: 0 }
  const sb = new Set()
  for (const s of sources) for (const g of bigrams(s)) sb.add(g)
  let hit = 0
  for (const g of cb) if (sb.has(g)) hit++
  return { ratio: hit / cb.size, spans: cb.size, hit }
}
