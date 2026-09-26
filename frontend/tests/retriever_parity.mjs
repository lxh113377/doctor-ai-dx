// 检索器双端一致性：同一批查询，JS 与 Python 端的命中条目序列与分数必须逐字段相等。
// 覆盖注册表全部档位（bm25 / hybrid / semantic）——原实现硬编码 "hybrid"，
// 新增档若不进这条判据，「双端一致」就只对旧档成立（2026-09-25 第十轮实测发现并泛化）。
// 与 contract_parity.mjs（引擎级 31 例）互补：那条守线上默认口径，这条守新增检索器不漂移。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { getRetriever, DEFAULT_RETRIEVER, SEMANTIC_NAME } from "../functions/lib/retriever.js"
import { reachableFlagTerms } from "../functions/lib/rag.js"

const suite = JSON.parse(readFileSync(new URL("./fixtures/retrieval_cases.json", import.meta.url), "utf8"))
const queries = suite.cases.map((c) => c.query)
// 第二十七轮：把带标点/单位的查询也送进双端比对——标点过滤是本次改动，任何一端单边生效都会在这里露出来
// （此前双端比对用的是同一份 fixture 查询，全是干净文本，覆盖不到这条面）。
const PUNCT_QUERIES = ["胸痛，伴发热、咳嗽。", "血压 190/110 mmHg（视物模糊）", "持续高热≥39℃，伴寒战！"]
queries.push(...PUNCT_QUERIES)
// 第三十三轮：加权词的匹配面扩到「原查询 ∪ 同义词扩展词形」，而 fixture 里 50 例全是指南侧写法，
// 一条都走不到这条新分支——双端比对必须自带口语侧样本，否则「双端一致」只对旧路径成立（同 #27 标点那次的教训）。
const COLLOQUIAL_QUERIES = [
  "冒冷汗伴胸痛", "孩子高热惊厥", "停经后来好多血头晕", "婴幼儿拉果酱色大便",
  "腰痛连带不上厕所", "嘴巴肿了喉咙发紧", "今天天气不错适合出门",
]
queries.push(...COLLOQUIAL_QUERIES)
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
// 不在这里 exit：先让下面的标点判据与桥判据也跑完，各条判据各自出结论（防止一条红把另一条遮蔽掉）。
let parityBad = totalFail
if (totalFail) console.error(`PARITY MISMATCH: ${totalFail} 例`)
console.log(`RETRIEVER PARITY ${totalFail ? "FAIL" : "ALL PASS"}（${NAMES.length} 档 × ${queries.length} 例）`)

// 标点不进索引（第二十七轮新增，与 rag.js/rag.py 的 tokenize 同批改动）。
// 为什么值得钉成判据：实测「，」曾以 df=54 被当作检索词，一次偶然匹配就能把无关条目顶到榜首——
// 这是扩库当天把 recall@5 从 0.85 打到 0.83 的真因，不是内容问题，所以要用行为断言锁住而不是靠 review 记着。
// 正反双向：只断言"加标点结果不变"会因"检索器整体失灵返回空"而假绿，故同时断言"改真字结果必变"。
{
  let punctBad = 0
  for (const name of NAMES) {
    const r = getRetriever(name)
    const shape = (list) => list.map((e) => `${e.id}:${e.score}`).join(",")
    const clean = "胸痛伴发热咳嗽"
    const noisy = "胸痛，伴发热、咳嗽。"
    if (shape(r.search(clean, TOP_K)) !== shape(r.search(noisy, TOP_K))) {
      console.error(`FAIL ${name}: 标点改变了结果（标点仍进索引）`)
      punctBad++
    }
    const changed = shape(r.search(clean, TOP_K)) !== shape(r.search("胸痛伴腹泻咳嗽", TOP_K))
    if (!changed) {
      console.error(`FAIL ${name}: 改真字结果不变＝检索器无判别力，本判据失去分母`)
      punctBad++
    }
    if (!r.search(noisy, TOP_K).length) {
      console.error(`FAIL ${name}: 带标点查询召回 0 条（不许用空结果冒充"标点已过滤"）`)
      punctBad++
    }
  }
  if (punctBad) {
    console.error(`PUNCT FILTER FAIL（${punctBad} 处）`)
  } else {
    console.log(`PUNCT FILTER PASS（${NAMES.length} 档：标点无关 + 真字敏感 + 非空召回 双向自证）`)
  }
  if (punctBad) parityBad += punctBad
}

// 口语侧→指南侧的加权桥：双端必须算出同一份「够得着的加权词」。
// 为什么单列一条：这条桥是第三十三轮新接的（加权词表已改成指南侧词形，口语输入靠同义词表桥过去），
// 只比 id/score 的上方那几档在「两端都算错成同一种错」时照样绿——所以直接比桥的中间量本身。
// 反例实测：把 JS 侧匹配面改回只扫原始 q，本条立刻红并点名差异（第三十三轮本地演练）。
{
  const pyBridge = `
import json, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../../backend", import.meta.url)))})
from app.rag import reachable_flag_terms
qs = json.load(sys.stdin)
print(json.dumps({q: reachable_flag_terms(q) for q in qs}, ensure_ascii=False))
`
  let pyMap = null
  try {
    pyMap = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python", ["-c", pyBridge], {
      input: JSON.stringify(COLLOQUIAL_QUERIES), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    }))
  } catch (e) {
    console.error(`FAIL 桥判据：Python 侧不可用，无法比对（${String(e.message).slice(0, 120)}）`)
    parityBad++
  }
  if (pyMap) {
    let bad = 0
    const detail = []
    for (const q of COLLOQUIAL_QUERIES) {
      const js = reachableFlagTerms(q).slice().sort().join(",")
      const py = (pyMap[q] || []).slice().sort().join(",")
      if (js !== py) { bad++; detail.push(`${q}: JS[${js || "-"}] vs Py[${py || "-"}]`) }
    }
    // 覆盖面自证：口语样本里至少要有一条真的桥到词、且至少一条桥不到（两端全空＝判据恒真）
    const fired = COLLOQUIAL_QUERIES.filter((q) => reachableFlagTerms(q).length > 0).length
    const silent = COLLOQUIAL_QUERIES.length - fired
    const denomOk = fired > 0 && silent > 0
    if (!denomOk) { bad++; detail.push(`分母失效：桥命中 ${fired} 条 / 零命中 ${silent} 条（必须两侧都有样本）`) }
    parityBad += bad
    console.log(`${bad === 0 ? "PASS" : "FAIL"} 加权桥双端一致 + 分母自证：${COLLOQUIAL_QUERIES.length} 条口语查询（桥上有词 ${fired}／无词 ${silent}）`)
    for (const d of detail.slice(0, 4)) console.error(`  ${d}`)
  }
}

if (parityBad) process.exit(1)
