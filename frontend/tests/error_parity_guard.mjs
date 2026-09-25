// 双端错误码/文案对账（v1.19.0 第二十一轮）。台账#28 的教训不是"有一处差异"，而是
// **差异被测试钉住当既成事实**（`route_guard` 明写"未预期异常返回 500"，把客户端错误当服务端故障测了两个月）。
// 本守卫把"同一入参双端同码同文案"变成常驻判据，且三方比对：fixture 期望 ↔ 权威面(JS) ↔ 镜像面(Py)。
// 只比"两端互相等"是不够的——两边一起错就永远绿，所以期望值必须写在仓内单一源里。
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { onRequest } from "../functions/api/[[route]].js"

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")
const fxPath = new URL("./fixtures/error_parity.json", import.meta.url)
const fixture = JSON.parse(readFileSync(fxPath, "utf8"))
const cases = fixture.cases

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

// 反空证明：用例数下限，防"清空 fixture 就全绿"（本仓同类判据已反复要求过，见 limits_guard/sbom_guard）
check(`fixture 用例数 ≥ 12（实测 ${cases.length}）`, cases.length >= 12, `清空 fixture 不得变成通过`)
check("每条用例都带期望码", cases.every((c) => Number.isInteger(c.status)), "缺 status 即无法三方对账")

const stripId = (m) => String(m || "").replace(/（故障编号 [0-9a-f]+）$/, "")

function buildBody(c) {
  const body = JSON.parse(JSON.stringify(c.json ?? {}))
  if (c.repeat_items) {
    const one = body.history[0]
    body.history = Array.from({ length: c.repeat_items }, () => ({ ...one }))
  }
  if (c.repeat_content) body.history[0].content = "腹".repeat(c.repeat_content)
  return c.raw !== undefined ? c.raw : JSON.stringify(body)
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

console.log("== 镜像面（FastAPI TestClient，经 backend/tests/error_parity_dump.py 取样）==")
const dump = fileURLToPath(new URL("../../backend/tests/error_parity_dump.py", import.meta.url))
const proc = spawnSync(PY, [dump], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
if (proc.status !== 0) {
  console.error(`python 取样失败（${PY}，rc=${proc.status}）:\n${(proc.stderr || "").slice(0, 1200)}`)
  process.exit(1)
}
const pyRows = JSON.parse(proc.stdout.trim().split(/\r?\n/).pop())

const byName = (rows) => new Map(rows.map((r) => [r.name, r]))
const js = byName(jsRows)
const py = byName(pyRows)
check("两侧取样数与 fixture 一致", js.size === cases.length && py.size === cases.length,
  `JS=${js.size} Py=${py.size} 期望=${cases.length}`)

console.log("== 三方对账（期望 ↔ JS ↔ Py）==")
for (const c of cases) {
  const j = js.get(c.name); const p = py.get(c.name)
  const same = j && p && j.status === c.status && p.status === c.status
  const msgSame = j && p && stripId(j.message) === stripId(p.message)
  check(`${c.name} 双端同码且等于期望 ${c.status}`, same, `JS=${j?.status} Py=${p?.status} 期望=${c.status}`)
  check(`${c.name} 双端文案同值（剥故障编号后）`, msgSame, `JS=${JSON.stringify(stripId(j?.message))} Py=${JSON.stringify(stripId(p?.message))}`)
  // fixture 里写了 message 的用例还要**逐字等于期望**（只比双端互相等，两边一起错就会永远绿）
  if (c.message !== undefined) {
    check(`${c.name} 文案逐字等于 fixture 期望`,
      stripId(j?.message) === c.message && stripId(p?.message) === c.message,
      `期望=${JSON.stringify(c.message)} JS=${JSON.stringify(stripId(j?.message))} Py=${JSON.stringify(stripId(p?.message))}`)
  }
}

console.log("== 口径不变式 ==")
check("客户端错误一律 4xx：双端都不得出现 5xx",
  cases.filter((c) => c.status < 500).every((c) => (js.get(c.name).status < 500) && (py.get(c.name).status < 500)),
  "500 用在入参错误上会把滥用流量刷成 error 日志，掩盖真故障（r19 立的口径）")
check("4xx 响应体仍是 {code,message} 同形且 message 非空",
  [...js.values()].concat([...py.values()])
    .filter((r) => r.status >= 400 && r.status < 500)
    .every((r) => typeof r.message === "string" && r.message.length > 4),
  "空 message＝对外等于没说话")

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
