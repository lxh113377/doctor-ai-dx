// hybrid_rrf.js — RRF 融合层（零新依赖，为 dense 预留接口）
// 对标 MedRAG hybrid_retriever.py + RxLM RRF：bm25 在位，dense 缺席时退化为 BM25 单路，不改变现有排序。
// 输入：rankLists: Array<Array<string>>（每路为 id 有序列表）；k=60（默认）；weights 可选
// 输出：Array<{id, score}> 降序
'use strict';
export function rrfFuse(rankLists, k, weights) {
  const K = (typeof k === 'number' && k > 0) ? k : 60;
  const scores = new Map();
  const lists = Array.isArray(rankLists) ? rankLists : [];
  lists.forEach((list, li) => {
    const w = (weights && typeof weights[li] === 'number') ? weights[li] : 1;
    if (!Array.isArray(list)) return;
    const seen = new Set();
    list.forEach((id, rank) => {
      if (typeof id !== 'string' || seen.has(id)) return;
      seen.add(id);
      const s = w / (K + rank + 1);
      scores.set(id, (scores.get(id) || 0) + s);
    });
  });
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
// hybrid 入口：bm25Ids 必选；denseIds 可选（缺席即单路）；同义词扩展已在上游完成，此处不重复展开
export function hybridRetrieve(bm25Ids, denseIds, opts) {
  const o = opts || {};
  const lists = [bm25Ids];
  const weights = [1];
  if (Array.isArray(denseIds)) {
    lists.push(denseIds);
    weights.push(typeof o.denseWeight === 'number' ? o.denseWeight : 1);
  }
  const fused = rrfFuse(lists, o.k, weights);
  const topN = (typeof o.topN === 'number' && o.topN > 0) ? o.topN : 5;
  return fused.slice(0, topN);
}
import { strict as assert } from 'node:assert';
// 自检：node hybrid_rrf.js -> HYBRID-RRF-SELFTEST-PASS
// ESM 包下直接执行自检（本文件无副作用导出，仅自检块打印一行）
{
  // 单路退化 = 保序
  const single = hybridRetrieve(['a', 'b', 'c'], null, { topN: 3 });
  assert.deepStrictEqual(single.map((x) => x.id), ['a', 'b', 'c']);
  // 双路 RRF：a 在两路靠前应第一
  const fused = hybridRetrieve(['a', 'b', 'c'], ['b', 'a', 'd'], { topN: 3 });
  assert.strictEqual(fused[0].id, 'a');
  // 去重
  const dup = hybridRetrieve(['a', 'a', 'b'], null, { topN: 2 });
  assert.deepStrictEqual(dup.map((x) => x.id), ['a', 'b']);
  console.log('HYBRID-RRF-SELFTEST-PASS: single-order + rrf-order + dedup');
}
