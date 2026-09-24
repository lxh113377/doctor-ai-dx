// 检索器边界：当前仅注册原 BM25 实现，后续可在不改诊断引擎的前提下增加混合检索。
import { search as bm25Search } from "./rag.js"

export const DEFAULT_RETRIEVER = "bm25"

export const bm25Retriever = Object.freeze({
  name: DEFAULT_RETRIEVER,
  search(query, topK = 4, filters = {}) {
    void filters
    return bm25Search(query, topK)
  },
})

const RETRIEVERS = Object.freeze({
  [DEFAULT_RETRIEVER]: bm25Retriever,
})

export function getRetriever(name = DEFAULT_RETRIEVER) {
  const key = String(name || DEFAULT_RETRIEVER).trim().toLowerCase()
  const retriever = RETRIEVERS[key]
  if (!retriever) throw new Error(`unsupported retriever: ${key}`)
  return retriever
}
