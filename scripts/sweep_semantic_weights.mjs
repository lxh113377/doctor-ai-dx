// 第四十八轮从工作区私有面 `医/work/` 搬进本仓：评审侧可自己复算下面那条「0/54 组严格优于 bm25」的结论，
// 不必再依赖一个不随仓发布的脚本（红线：未回链的量化事实不得进入方案/答辩）。
// 语义通道权重标定（一次性）：在 50 例标定集扫 (W_SEM, SEM_TOP, SEM_FLOOR)，
// 再用 20 例留出集判泛化——标定集涨、留出集不涨 = 过拟合，不得改默认档（台账#10）。
// 指标口径与 tests/retrieval_eval.mjs 一致：recall@5 用相关集归一，MRR 取首个命中倒数名次。
import { readFileSync } from "node:fs"
import { search as bm25Search } from "../frontend/functions/lib/rag.js"
import { semanticChannel } from "../frontend/functions/lib/retriever.js"
import { KB_ID_SET } from "../frontend/functions/lib/knowledge.js"

const K = 60
const TOP = 5
const SETS = {
  calib: JSON.parse(readFileSync(new URL("../frontend/tests/fixtures/retrieval_cases.json", import.meta.url), "utf8")).cases,
  holdout: JSON.parse(readFileSync(new URL("../frontend/tests/fixtures/retrieval_holdout.json", import.meta.url), "utf8")).cases,
}

function fuse(bm, sem, w, topK = TOP) {
  const acc = new Map()
  const add = (list, weight) => (list || []).forEach((id, r) => {
    if (!KB_ID_SET.has(id)) return
    acc.set(id, (acc.get(id) || 0) + weight / (K + r + 1))
  })
  add(bm, 1)
  add(sem, w)
  return [...acc.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, topK).map(([id]) => id)
}

function score(cases, w, top, floor) {
  let r5 = 0, rr = 0, rf5 = 0, rfHit = 0, rfN = 0, n = 0
  for (const c of cases) {
    const bm = bm25Search(c.query, 10).map((e) => e.id)
    const sem = w > 0 ? semanticChannel(bm, top, floor) : []
    const ids = fuse(bm, sem, w)
    const rel = new Set(c.relevant_ids)
    const hits = ids.slice(0, 5).filter((i) => rel.has(i)).length
    r5 += rel.size ? hits / rel.size : 0
    const idx = ids.findIndex((i) => rel.has(i))
    rr += idx < 0 ? 0 : 1 / (idx + 1)
    if (c.red_flag) {
      rfN++
      rf5 += rel.size ? ids.slice(0, 5).filter((i) => rel.has(i)).length / rel.size : 0
      rfHit += ids.some((i) => rel.has(i)) ? 1 : 0
    }
    n++
  }
  return { r5: r5 / n, mrr: rr / n, rf5: rfN ? rf5 / rfN : 0, rfHit: rfN ? rfHit / rfN : 0, rfN, n }
}

const grid = []
for (const w of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
  for (const top of [3, 5, 8]) {
    for (const floor of [600, 700, 750]) {
      if (w === 0 && (top !== 5 || floor !== 600)) continue   // w=0 即 bm25，只留一行参照
      grid.push({ w, top, floor })
    }
  }
}

// 假指标自检（R247 同族机器化）：子集 n=0 却照样输出 rf5=0.000，会把「字段名写错」伪装成「指标为 0」。
// 2026-09-25 实测踩过：误用 c.is_red_flag（夹具实为 c.red_flag）→ 整列红旗 R@5 恒 0.000 且无任何报错。
const subCheck = (cases) => {
  const n = cases.filter((c) => "red_flag" in c).length
  if (!n) throw new Error("红旗子集判据未接线：夹具无 red_flag 字段（禁止静默输出 0.000 假指标）")
  return n
}
subCheck(SETS.calib); subCheck(SETS.holdout)

const rows = grid.map(({ w, top, floor }) => {
  const c = score(SETS.calib, w, top, floor)
  const h = score(SETS.holdout, w, top, floor)
  return { w, top, floor, c, h }
})
const base = rows.find((r) => r.w === 0)
const fmt = (x) => (Math.round(x * 1000) / 1000).toFixed(3)

console.log("W/top/floor  |  标定集 R@5 / MRR / 红旗R@5  |  留出集 R@5 / MRR / 红旗R@5  |  Δ留出MRR")
for (const r of rows) {
  const tag = r.w === 0 ? "bm25 参照" : `w=${r.w} top=${r.top} fl=${r.floor}`
  const d = r.h.mrr - base.h.mrr
  const flag = r.w === 0 ? "  <= 线上默认档" : (d > 0 ? "  +" : "  ")
  console.log(`  ${tag.padEnd(20)} ${fmt(r.c.r5)} ${fmt(r.c.mrr)} ${fmt(r.c.rf5)}   |   ${fmt(r.h.r5)} ${fmt(r.h.mrr)} ${fmt(r.h.rf5)}   |  ${d >= 0 ? "+" : ""}${fmt(d)}${flag}`)
}

// 决策口径：留出集必须**严格优于** bm25 才算泛化成立。
// 用 >= 会把「通道惰性、结果与 bm25 逐位相同」的 w=0.05 行误判成增益（2026-09-25 实测即踩到：9 组"候选"全为 Δ=0 等值行）。
const winners = rows.filter((r) => r.w > 0 && (
  r.h.mrr > base.h.mrr || (Math.abs(r.h.mrr - base.h.mrr) < 1e-9 && r.h.r5 > base.h.r5)))
const inert = rows.filter((r) => r.w > 0 && Math.abs(r.h.mrr - base.h.mrr) < 1e-9 && Math.abs(r.h.r5 - base.h.r5) < 1e-9)
console.log(`\n泛化候选（留出集严格优于 bm25）: ${winners.length} 组`)
console.log(`其中与 bm25 逐位等值（通道惰性 = 白跑一趟，非增益）: ${inert.length} 组`)
for (const r of winners.slice(0, 6)) console.log(`  w=${r.w} top=${r.top} floor=${r.floor} -> holdout R@5=${fmt(r.h.r5)} MRR=${fmt(r.h.mrr)} calib MRR=${fmt(r.c.mrr)}`)
if (!winners.length) console.log("  无 → 维持 opt-in、默认 bm25，线上口径零改动")
const worse = rows.filter((r) => r.w > 0 && r.h.mrr < base.h.mrr)
console.log(`劣化组数: ${worse.length} / ${rows.length - 1}（最大劣化 ΔMRR=${fmt(Math.min(...worse.map((r) => r.h.mrr - base.h.mrr)))}）`)
