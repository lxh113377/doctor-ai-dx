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

// ── 并发面（第一百一十一轮，r111-1）：把「并发读数」从人工触发变成常驻判据 ──
// 立判据的一手依据（现取，不是推演）：docs/OBSERVABILITY.md §七 自陈「load_probe.mjs 已进仓，但**尚未在 CI 里跑**，
//   并发读数目前是人工触发、非守门」；仓内 peer 名册 fixtures/bench_peer_roster.json 对 locustio/locust 的
//   borrowable 原话是「benchmarks/dispatch.py 单件仓内可复算负载基准……**这正是我方性能维缺的那一件**」。
// 射程声明（不许含糊）：本段测**单进程内并发下的直驱吞吐**，不是网络堆栈、不是多实例、不是线上并发承诺——
//   那两把尺分别属 load_probe.mjs（活端点）与 perf_gate.mjs（线上报告）。本段只回答一个问题：
//   **代码路径在并发调用下会不会退化或串行化**。
// 为什么用**相对吞吐**而不是绝对 req/s：绝对读数随机器/负载一秒一变（本轮实测同机两次：14573 vs 19106 req/s，
//   差 31%），当阈值判据会变成「测机器心情」。相对比值（并发/单worker）的机器无关性远比绝对值高。
//   ⚠ 但比值的方向要判对：单线程 CPU-bound 代码的 speedup 本来就 ≈1，所以地板不能设在 1 以上
//   （那是把「Node 单线程」这个事实判成红）。地板设在 0.5：真正的缺陷形态是**并发下比单跑还慢**——
//   全局锁、同步阻塞 IO、无界共享缓冲的争用，都会让这个比值掉到 0.5 以下。
const CONC = {
  vu: 8,
  window_ms: 1500,
  // ⚠ 不判「加速比地板」：本仓直驱面（Functions onRequest）是**单线程 CPU-bound**的纯同步计算，
  //   不存在 IO 等待，因此 VU=8 不会带来吞吐线性提升——本轮一手实测 speedup 1.05–1.26×，
  //   这是 Node 单线程的**预期行为**，不是缺陷。把「加速比 ≥ N」写进判据就是拿错误前提造恒红尺。
  //   真判据抓的是**并发退化**：加了全局锁/同步阻塞/共享缓冲后，并发吞吐会**低于**单 worker，
  //   即 speedup < min_speedup(=0.5)。这才能在真出问题时会红，在正常时不会误红。
  min_speedup: 0.5,
  max_error_rate: 0.02,
}

const runConcurrent = async (call, vu, windowMs) => {
  const stop = Date.now() + windowMs
  const lat = []
  let ok = 0, err = 0
  const worker = async () => {
    while (Date.now() < stop) {
      const t0 = performance.now()
      try { await call(); lat.push(performance.now() - t0); ok++ }
      catch { lat.push(performance.now() - t0); err++ }
    }
  }
  const t0 = Date.now()
  await Promise.all(Array.from({ length: vu }, worker))
  const dur = (Date.now() - t0) / 1000
  const total = ok + err
  return { vu, dur, total, ok, err, rps: dur > 0 ? total / dur : 0, error_rate: total ? err / total : 1, lat }
}

// 判据体抽成纯函数：红态自证必须驱动**同一条**判定路径（不在自证里重写一份阈值比较＝第二把尺）。
const judgeConcurrency = (r, lim = CONC) => {
  const bad = []
  // 全部失败时「吞吐」是拒绝数不是吞吐（r98 一手教训：对 127.0.0.1:9 跑出 43939 req/s）
  if (!(r.total >= 1)) bad.push("零样本（total=" + r.total + "）⇒ 吞吐不可声称，不得读成达标")
  if (r.error_rate >= 1) bad.push("错误率 100% ⇒ 该 " + r.rps.toFixed(1) + " req/s 是拒绝数而非吞吐，禁当吞吐读数")
  else if (r.error_rate > lim.max_error_rate) bad.push("错误率 " + (r.error_rate * 100).toFixed(2) + "% > " + lim.max_error_rate * 100 + "%")
  // 缺 speedup 字段 ⇒ UNVERIFIED 形态：不得折成达标（对照 observe_slo 的「缺字段不折成 0」纪律）
  const sp = r.speedup
  if (!Number.isFinite(sp)) bad.push("加速比不可读（speedup=" + JSON.stringify(sp) + "）⇒ 不得声称并发收益")
  else if (sp < lim.min_speedup) bad.push("并发加速比 " + sp.toFixed(2) + "× < 地板 " + lim.min_speedup + "×（并发下反而更慢＝全局锁/同步阻塞/资源争用征兆）")
  return { bad, stat: stat(r.lat) }
}

// 真面：对每条链先测单 worker 基线，再测 VU 并发，比值即加速比。
for (const [name, call] of [
  ["GET /api/health", () => apiT("/api/health")],
  ["POST /api/dx/c1 (mock)", () => apiT("/api/dx/c1", dxInit)],
]) {
  const single = await runConcurrent(call, 1, CONC.window_ms)
  const multi = await runConcurrent(call, CONC.vu, CONC.window_ms)
  multi.speedup = single.rps > 0 ? multi.rps / single.rps : 0
  const v = judgeConcurrency(multi)
  const p95s = v.stat.p95 === undefined ? "undefined" : v.stat.p95.toFixed(2)
  check(name + " 并发：单 worker " + single.rps.toFixed(0) + " req/s → VU=" + multi.vu + " " + multi.rps.toFixed(0) + " req/s＝" + multi.speedup.toFixed(2) + "×（错误率 " + (multi.error_rate * 100).toFixed(2) + "%，p95 " + p95s + "ms，样本 " + multi.total + "）", v.bad.length === 0, v.bad.join("；"))
}


// —— 并发隔离面（第一百一十一轮 r111-2）：并发不是只有吞吐，**串扰**才是真伤人的那一面 ——
// 立判据的一手依据：本仓运行面是 Cloudflare Workers 单 isolate（多个请求共享同一模块实例）。
//   若任一模块持**模块级可变状态**（缓存/缓冲/计数器/单例上下文），并发请求就会互相污染——
//   症状是「偶发串病例」，单请求串行测试**永远抓不到**（每个请求都从头来过）。
// 判据：并发交错地打三个不同病例的 /api/dx，比对每条的响应与**串行**打同一病例的响应逐字节相同。
//   串行基线是自证的：同一输入串行两次必须相同（否则是模型随机，不是串扰——本面 mock 模式下应当确定）。
const CASE_IDS = ["c1", "c2", "c3"]
const dxFor = (id) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: id, history: [{ role: "user", content: "压榨样胸痛" }] }) })
const bodyOf = async (req) => { const res = await api({ request: new Request("https://dx.test/api/dx/" + req.id, req.init), env: {} }); return await res.text() }

// 串行基线（同时也是「同输入两次相同」的确定性子面前提）
const serial = {}
for (const id of CASE_IDS) {
  const a = await bodyOf({ id, init: dxFor(id) })
  const b = await bodyOf({ id, init: dxFor(id) })
  serial[id] = a
  check("串行基线 /api/dx/" + id + " 同输入两次逐字节相同（确定性子面前提）", a === b, "length " + a.length + " vs " + b.length)
}

// 并发交错：20 轮 × 3 病例，同轮内 Promise.all 同时发出（真并发而非排队）
const ROUNDS = 20
let contaminated = 0
const contamination = []
for (let round = 0; round < ROUNDS; round++) {
  const got = await Promise.all(CASE_IDS.map((id) => bodyOf({ id, init: dxFor(id) })))
  for (let i = 0; i < CASE_IDS.length; i++) {
    const id = CASE_IDS[i]
    if (got[i] !== serial[id]) {
      contaminated++
      if (contamination.length < 3) contamination.push("round " + round + " /" + id + " 与串行基线不等（" + got[i].length + "B vs " + serial[id].length + "B）")
    }
  }
}
check("并发交错 " + ROUNDS + " 轮 × " + CASE_IDS.length + " 病例：零串扰（每条响应与串行基线逐字节相同）", contaminated === 0, (contaminated ? contaminated + " 条被污染；首例 " + contamination.join("｜") : ""))


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

// —— 并发面的红态自证（第一百一十一轮）：新增的并发判据同样必须自带「会红」的证据 ——
// 合成样本驱动与真面**同一条** judgeConcurrency（不重写阈值比较），四条必须红的腿 + 一条对照绿腿。
{
  const mk = (over) => Object.assign({ vu: 8, dur: 1, total: 1000, ok: 1000, err: 0, rps: 400, error_rate: 0, speedup: 5, lat: Array.from({ length: 100 }, () => 5) }, over)
  const redConc = (name, expectPass, raw, lim) => {
    const v = judgeConcurrency(raw, lim)
    redOk(name, expectPass, v.bad.length === 0, v.bad.join("；") || "无红因")
  }
  redConc("红态腿-并发退化：加速比 0.3× < 地板 0.5×（并发比单跑还慢）", false, mk({ speedup: 0.3 }), CONC)
  redConc("红态腿-加速比缺失（speedup=undefined）⇒ 不得声称并发收益", false, mk({ speedup: undefined }), CONC)
  redConc("红态腿-并发错误率超上限（10% vs 2%）", false, mk({ error_rate: 0.10, ok: 900, err: 100 }), CONC)
  redConc("红态腿-全失败时吞吐是拒绝数（error_rate=100%）", false, mk({ error_rate: 1, ok: 0, err: 1000, rps: 5000 }), CONC)
  redConc("红态腿-零样本不得读成达标", false, mk({ total: 0, ok: 0, err: 0, rps: 0, error_rate: 0, speedup: 0, lat: [] }), CONC)
  redConc("对照腿-单线程 CPU-bound 正常样本（1.05× / 0% 错误）⇒ 判绿不误红", true, mk({ speedup: 1.05 }), CONC)
}



// —— 串扰判据的红态自证（第一百一十一轮 r111-2）：证明这把尺在真被污染时会红 ——
{
  // 期望红的合成样本：把 c2 的响应换成 c1 的（模拟单例上下文被后一个请求覆盖）
  const fake = { c1: serial.c1, c2: serial.c1, c3: serial.c3 }
  const mism = CASE_IDS.filter((id) => fake[id] !== serial[id])
  redOk("红态腿-合成串扰样本（c2 被 c1 覆盖）⇒ 判红", false, mism.length === 0, "命中 " + mism.join(","))
  const clean = { c1: serial.c1, c2: serial.c2, c3: serial.c3 }
  redOk("对照腿-零串扰样本 ⇒ 判绿", true, CASE_IDS.every((id) => clean[id] === serial[id]), "")
}

console.log(`[GATE:latency:${fail === 0 ? "pass" : "fail"}] matched=${pass} mismatched=${fail}｜faces=${faces.length}×${N}｜conc=${CONC.vu}VU×${CONC.window_ms}ms｜rc=${fail === 0 ? 0 : 1}`)
process.exit(fail === 0 ? 0 : 1)
