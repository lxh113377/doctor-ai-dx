// 双端错误码对账（v1.19.0 第二十一轮建，v1.20.0 第二十二轮改为**枚举矩阵**）。
// 台账#28 的教训不是"有一处差异"，而是**差异被测试钉住当既成事实**：`route_guard` 曾明写
// "未预期异常返回 500"，把客户端错误当服务端故障测了两个月（污染故障口径，且滥用流量会把
// error 日志刷成噪声＝掩盖真故障，正是 r19 立"4xx 不记 error"的理由）。
// 三方对账：fixture 期望码 ↔ 权威面(Functions/JS) ↔ 镜像面(FastAPI/Py)。
// 只比"两端互相等"不够——两边一起错就永远绿 ⇒ 期望值落在仓内单一源；
// 用例由 scripts/gen_error_matrix.py 按「POST 路由 × 入站违规类型」枚举积生成（抽样会随路由增加静默失真）。
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { onRequest } from "../functions/api/[[route]].js"

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")
const fixture = JSON.parse(readFileSync(new URL("./fixtures/error_parity.json", import.meta.url), "utf8"))
const cases = fixture.cases
const meta = fixture._meta || {}

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

console.log("== 覆盖面与来源完整性（抽样不等于覆盖）==")
check(`用例数 == 路由 × 违规 + 路由级（${meta.routes}×${meta.violations}+${meta.route_level}=${meta.cases}）`,
  Number.isInteger(meta.cases) && cases.length === meta.routes * meta.violations + meta.route_level,
  `实测 ${cases.length}，_meta=${JSON.stringify(meta)}`)
// 只统计矩阵用例（名字形如 `路由kind × 违规名`）；路由级用例（未知病例 id 等）不参与枚举积，
// 否则会被当成"只有 1 条用例的路由"造成假红——本判据第一版就是这样，被自己抓到后修正。
const perRoute = new Map()
for (const c of cases) {
  const [kind, violation] = c.name.split(" × ")
  if (!violation) continue
  perRoute.set(kind, (perRoute.get(kind) || 0) + 1)
}
check(`矩阵用例的路由数 == fixture.routes 数（${perRoute.size}/${meta.routes}）`, perRoute.size === meta.routes,
  `实测路由 ${[...perRoute.keys()]}`)
const thin = [...perRoute.entries()].filter(([, n]) => n < (meta.violations || 0)).map(([k, n]) => `${k}=${n}条`)
check(`每条 POST 路由都吃到全部 ${meta.violations} 类违规`, thin.length === 0, `覆盖不足：${thin}`)
const seenKinds = new Set(cases.map((c) => c.name.split(" × ")[1]).filter(Boolean))
const missingKinds = (fixture.violation_kinds || []).filter((k) => !seenKinds.has(k))
check(`每类入站违规都进了矩阵（种类数 ${fixture.violation_kinds?.length}）`, missingKinds.length === 0, `缺 ${missingKinds}`)
check("每条用例都带期望码", cases.every((c) => Number.isInteger(c.status)), "缺 status 就无法三方对账")
const gen = spawnSync(PY, [fileURLToPath(new URL("../../scripts/gen_error_matrix.py", import.meta.url)), "--check"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
check("矩阵与生成器无漂移（禁手改 fixture；改路由或违规种类须重生成）", gen.status === 0,
  ((gen.stdout || "") + (gen.stderr || "")).split(/\r?\n/)
    .filter((l) => l.includes("::error::") || l.includes("缺用例") || l.includes("多用例")).join(" | ").slice(0, 220))

const stripId = (m) => String(m || "").replace(/（故障编号 [0-9a-f]+）$/, "")

function buildBody(c) {
  if (c.raw !== undefined) return c.raw
  const body = JSON.parse(JSON.stringify(c.body ?? {}))
  if (c.repeat_items) {
    const one = body.history[0]
    body.history = Array.from({ length: c.repeat_items }, () => ({ ...one }))
  }
  if (c.repeat_content) body.history[0].content = "腹".repeat(c.repeat_content)
  return JSON.stringify(body)
}

console.log("== 权威面（Functions/Node 直接调 onRequest）==")
const jsRows = []
for (const c of cases) {
  const res = await onRequest({ request: new Request(`https://dx.test${c.path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: buildBody(c),
  }), env: {}, waitUntil() {} })
  let msg = null
  try { msg = (JSON.parse(await res.text())).message } catch { msg = null }
  jsRows.push({ name: c.name, status: res.status, message: msg })
}

console.log("== 镜像面（FastAPI TestClient，由 backend/tests/error_parity_dump.py 取样）==")
const dump = fileURLToPath(new URL("../../backend/tests/error_parity_dump.py", import.meta.url))
const proc = spawnSync(PY, [dump], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
if (proc.status !== 0) {
  console.error(`python 取样失败（${PY}，rc=${proc.status}）:\n${(proc.stderr || "").slice(0, 1500)}`)
  process.exit(1)
}
const pyRows = JSON.parse(proc.stdout.trim().split(/\r?\n/).pop())

const byName = (rows) => new Map(rows.map((r) => [r.name, r]))
const js = byName(jsRows)
const py = byName(pyRows)
check("两侧取样数与 fixture 一致", js.size === cases.length && py.size === cases.length,
  `JS=${js.size} Py=${py.size} fixture=${cases.length}`)

console.log("== 三方对账（期望 ↔ JS ↔ Py）==")
const bad = []
for (const c of cases) {
  const j = js.get(c.name)
  const p = py.get(c.name)
  if (!j || !p) { bad.push(`${c.name}：缺一侧取样 JS=${!!j} Py=${!!p}`); continue }
  if (j.status !== c.status || p.status !== c.status) {
    bad.push(`${c.name}：JS=${j.status} Py=${p.status} 期望=${c.status}`)
    continue
  }
  if (stripId(j.message) !== stripId(p.message)) {
    bad.push(`${c.name}：文案不等 JS=${JSON.stringify(stripId(j.message))} Py=${JSON.stringify(stripId(p.message))}`)
    continue
  }
  if (c.message !== undefined && stripId(j.message) !== c.message) {
    bad.push(`${c.name}：文案不等于 fixture 期望 ${JSON.stringify(c.message)}（实测 ${JSON.stringify(stripId(j.message))}）`)
  }
}
check(`${cases.length} 条用例三方全等（状态码 + 剥故障编号后的文案）`, bad.length === 0, `不符 ${bad.length} 条`)
for (const line of bad.slice(0, 14)) console.log("   ·", line)

console.log("== 口径不变式 ==")
check("客户端错误一律 4xx：双端都不得出现 5xx",
  cases.filter((c) => c.status < 500).every((c) => js.get(c.name).status < 500 && py.get(c.name).status < 500),
  "500 用在入参错误上＝把滥用流量刷成 error 日志、掩盖真故障（r19 立的口径）")
check("4xx 响应体仍是 {code,message} 同形且 message 非空",
  [...js.values()].concat([...py.values()])
    .filter((r) => r.status >= 400 && r.status < 500)
    .every((r) => typeof r.message === "string" && r.message.length > 4),
  "空 message＝对外等于没说话")

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
