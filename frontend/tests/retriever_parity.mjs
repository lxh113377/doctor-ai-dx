// 检索器双端一致性：同一批查询，JS 与 Python 端的命中条目序列与分数必须逐字段相等。
// 覆盖注册表全部档位（bm25 / hybrid / semantic）——原实现硬编码 "hybrid"，
// 新增档若不进这条判据，「双端一致」就只对旧档成立（2026-09-25 第十轮实测发现并泛化）。
// 与 contract_parity.mjs（引擎级 31 例）互补：那条守线上默认口径，这条守新增检索器不漂移。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { getRetriever, DEFAULT_RETRIEVER, SEMANTIC_NAME } from "../functions/lib/retriever.js"

const suite = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", import.meta.url), "utf8"))
const queries = suite.cases.map((c) => c.query)
const TOP_K = 5
const NAMES = [DEFAULT_RETRIEVER, "hybrid", SEMANTIC_NAME]

const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../../backend", import.meta.url)))})
from app.retriever import get_retriever
qs = json.load(sys.stdin)
names = ${JSON.stringify(NAMES)}
out = {}
for n in names:
    r = get_retriever(n)
    out[n] = [[{"id": e["id"], "score": e["score"]} for e in r.search(q, ${TOP_K})] for q in qs]
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

let totalFail = 0
const lines = []
for (const name of NAMES) {
  const retriever = getRetriever(name)
  const rows = pyResults[name]
  if (!Array.isArray(rows)) {
    console.error(`FAIL ${name}: Python 端未返回该档结果（判据未接线）`)
    totalFail++
    continue
  }
  let fail = 0
  const mismatches = []
  queries.forEach((q, i) => {
    const js = retriever.search(q, TOP_K).map((e) => ({ id: e.id, score: e.score }))
    const pyRow = (rows[i] || []).map((e) => ({ id: e.id, score: e.score }))
    const ok = js.length === pyRow.length && js.every((row, r) =>
      row.id === pyRow[r]?.id && Math.abs(row.score - pyRow[r]?.score) < 1e-6)
    if (!ok) {
      fail++
      if (mismatches.length < 2) mismatches.push({ q: q.slice(0, 24), js, py: pyRow })
    }
  })
  totalFail += fail
  lines.push(`  ${fail === 0 ? "PASS" : "FAIL"} ${name} 双端比对: ${queries.length - fail}/${queries.length} 一致`)
  for (const m of mismatches) console.error(JSON.stringify(m, null, 2))
}

for (const line of lines) console.log(line)
if (totalFail) {
  console.error("RETRIEVER PARITY FAIL")
  process.exit(1)
}
console.log(`RETRIEVER PARITY ALL PASS（${NAMES.length} 档 × ${queries.length} 例）`)
