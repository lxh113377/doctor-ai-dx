// hybrid 检索器双端一致性：同一批查询，JS 与 Python 端的命中条目序列与分数必须逐字段相等。
// 与 contract_parity.mjs（引擎级 31 例）互补：那条守线上默认口径，这条守新增检索器不漂移。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { getRetriever } from "../functions/lib/retriever.js"

const suite = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", import.meta.url), "utf8"))
const queries = suite.cases.map((c) => c.query)
const TOP_K = 5
const jsRetriever = getRetriever("hybrid")

const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../../backend", import.meta.url)))})
from app.retriever import get_retriever
qs = json.load(sys.stdin)
r = get_retriever("hybrid")
out = [[{"id": e["id"], "score": e["score"]} for e in r.search(q, ${TOP_K})] for q in qs]
print(json.dumps(out, ensure_ascii=False))
`

let pyResults
try {
  const raw = execFileSync(process.env.PYTHON_BIN || "python", ["-c", py], {
    input: JSON.stringify(queries), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  })
  pyResults = JSON.parse(raw)
} catch (e) {
  console.error(`Python 侧不可用，无法做双端比对（可用 PYTHON_BIN 指定）: ${String(e.message).slice(0, 160)}`)
  process.exit(1)
}

let fail = 0
const mismatches = []
queries.forEach((q, i) => {
  const js = jsRetriever.search(q, TOP_K).map((e) => ({ id: e.id, score: e.score }))
  const pyRow = (pyResults[i] || []).map((e) => ({ id: e.id, score: e.score }))
  const ok = js.length === pyRow.length && js.every((row, r) =>
    row.id === pyRow[r]?.id && Math.abs(row.score - pyRow[r]?.score) < 1e-6)
  if (!ok) {
    fail++
    if (mismatches.length < 3) mismatches.push({ q: q.slice(0, 24), js, py: pyRow })
  }
})

console.log(`hybrid 双端比对: ${queries.length - fail}/${queries.length} 一致`)
for (const m of mismatches) console.error(JSON.stringify(m, null, 2))
if (fail) {
  console.error("HYBRID PARITY FAIL")
  process.exit(1)
}
console.log("HYBRID PARITY ALL PASS")
