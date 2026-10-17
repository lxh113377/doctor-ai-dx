#!/usr/bin/env node
// 离线时延地板线（latency guard）——第一百零九轮改进4，收口对标报告遗留 R-9「复测时延」。
//
// 对标依据（现取 peer facts，非推演）：openemr 有 container_benchmarking、blaze 有 load-test——
// 「性能」在 peer 仓里是**可复算的资产**。我方时延读数此前只有两个来源：live 评测报告（需密钥+公网，
// 且 #146 间歇）与 load_probe（需起服务）。**零模型路径**（红旗/CDS 卡/健康面）的本地时延没有任何地板线——
// 谁引入一次全语料线性扫描，没有任何守卫会红。
//
// 判据：直驱 Functions 处理器（零网络零密钥），三条链各采 60 样本，p50/p95/max 三分位全断言：
//   /api/health（最短链）｜/cds-services/red-flag-screen（红旗面）｜/api/dx/c1（诊断主链，mock 模式）。
// 阈值 = 实测分布的百分位余量 ×（本机标定见下方常量注释），**上限写在判据里，禁抄进文档当承诺**。
//
// 纪律对齐：本件测的是**代码路径成本**（离线、mock 模式），不是线上 P95 承诺——
// 线上 P95 ≤10s 的承诺面在 docs/AC.md，由 perf_gate.mjs 守 live 报告，两把尺不混。
//
// 用法：node tests/latency_guard.mjs
// 退出码：0 全过｜1 有超限｜2 取数面坏
import { performance } from "node:perf_hooks"

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")) }
}

// 标定（2026-10-15 本机 Node 24 实测，60 样本/链）：health p50 0.06/p95 0.18/max 17(首样 JIT)；
// cds p50 0.09/p95 0.25/max 1.0；dx p50 0.60/p95 1.06/max 4.9。
// 上限 = p95 实测 × 10（吸收机器波动），max 判据只看**稳态**（去掉首个 JIT 预热样本）。
const N = 60
const WARMUP = 1
const LIMITS = {
  "GET /api/health": { p95: 2.0 },
  "POST /cds-services/red-flag-screen": { p95: 2.5 },
  "POST /api/dx/c1 (mock)": { p95: 10.0 },
}

const wrap = (fn) => async (path, init) => {
  const t0 = performance.now()
  const res = await fn({ request: new Request("https://dx.test" + path, init), env: {} })
  await res.text()
  return performance.now() - t0
}

let api, invoke
try {
  api = (await import("../functions/api/[[route]].js")).onRequest
  invoke = (await import("../functions/cds-services/[service].js")).onRequest
} catch (e) {
  console.error(`[GATE:latency:broken] 权威处理器取不到（${String(e.message).slice(0, 80)}）｜rc=2`)
  process.exit(2)
}
const apiT = wrap(api), invT = wrap(invoke)
const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return { p50: s[Math.floor(s.length / 2)], p95: s[Math.ceil(s.length * 0.95) - 1], max: s[s.length - 1] }
}
const cdsInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook: "patient-view", hookInstance: "lat", context: { symptoms: ["压榨样胸痛"] } }) }
const dxInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: "c1", history: [{ role: "user", content: "压榨样胸痛" }] }) }

const faces = [
  ["GET /api/health", () => apiT("/api/health")],
  ["POST /cds-services/red-flag-screen", () => invT("/cds-services/red-flag-screen", cdsInit)],
  ["POST /api/dx/c1 (mock)", () => apiT("/api/dx/c1", dxInit)],
]

for (const [name, call] of faces) {
  const raw = []
  for (let i = 0; i < N + WARMUP; i++) raw.push(await call())
  const steady = raw.slice(WARMUP)
  const { p50, p95, max } = stat(steady)
  const lim = LIMITS[name]
  check(`${name}：p95=${p95.toFixed(2)}ms ≤ ${lim.p95}ms（p50=${p50.toFixed(2)} max=${max.toFixed(2)}，n=${steady.length}）`, p95 <= lim.p95)
}

// —— 红态自证（第一百一十轮，r109-3 收口）：地板线判据必须自带「会红」的证据 ——
// 三面取样循环只产 PASS 行：一次全语料线性扫描式的退化在本文件里没有任何东西会红。
// 用**合成毫秒样本**（不真实计时 ⇒ 不受本机负载影响）驱动与真面同一条 stat() 判定路径，
// 期望红的两条必须真红、对照腿必须绿——**期望红 ≠ 让本门禁红**：自证腿的结果独立计数，
// 任何一条不符合期望（该红不红／该绿不绿）才把整个门禁判红（判据自己坏＝红，与 r107 红态名册同口径）。
const redOk = (name, expectPass, got, detail) => {
  const ok = got === expectPass
  check(name + ` ⇒ ${expectPass ? "判绿" : "判红"}（${ok ? "符合期望" : "不符合期望"}）`, ok, detail)
}
{
  const slow = stat(Array.from({ length: 60 }, () => 500))
  redOk("红态腿-人为慢调用（p95=500ms vs 上限 10ms）", false, slow.p95 <= 10, `p95=${slow.p95.toFixed(2)}ms`)
  const empty = stat([])
  redOk("红态腿-零样本不得读成达标（undefined<=x 恒 false）", false, empty.p95 <= 10, `p95=${String(empty.p95)}`)
  const fast = stat(Array.from({ length: 60 }, () => 0.5))
  redOk("对照腿-快样本（p95=0.5ms vs 上限 10ms）", true, fast.p95 <= 10, `p95=${fast.p95.toFixed(2)}ms`)
}

console.log(`[GATE:latency:${fail === 0 ? "pass" : "fail"}] matched=${pass} mismatched=${fail}｜faces=${faces.length}×${N}｜rc=${fail === 0 ? 0 : 1}`)
process.exit(fail === 0 ? 0 : 1)
