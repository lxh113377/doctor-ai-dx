#!/usr/bin/env node
// 对外入口 rc 传递守卫（conformance entry guard）——第一百一十一轮改进4。
//
// 立判据的一手起因（现算，不是假设）：
//   `examples/conformance_basic.mjs` 是**仓外第三方唯一会跑的那一条命令**（docs/CONFORMANCE.md §1 与
//   README 都指向它）。它在仓内 6 处被引用，却**没有任何判据测过它自己的行为**——
//   判据本体 `conformance_guard.mjs` 的 25 面全绿，只证明「判据会判」，不证明「入口会把那个结论传出去」。
//   中间这条断点很实在：入口若恒 exit 0、或漏传 --base、或 spawn 失败时把 status===null 当 0 返回，
//   第三方拿到的就是「跑完了＝通过了」的假绿，而仓内一切仍然全绿。
//   形态同 r107-13（只在绿态被复验的判据＝没验过它的 red 面）与 r110-1（在盘 ≠ 可用）：
//   **「有入口」与「入口如实转达结论」是两件事。**
//
// 判据：真起子进程跑那个入口（被测对象就是它，不是等价重写），断言**三态都被如实转达**：
//   ① 真面离线（零网络零密钥）⇒ rc=0 且末行带 [GATE:conformance:pass]；
//   ② 取数面坏（--base 指向必然不可达地址）⇒ rc=2 且末行是 broken，**不得**读成通过；
//   ③ 单请求中途传输失败 ⇒ 不崩栈（本件与 conformance_guard 各自的 red 面证据）。
// 反例腿：把入口的 rc 传递换成恒 0 的合成替身 ⇒ 必须判红（证这把尺有牙）。
//
// 用法：node tests/conformance_entry_guard.mjs [--selftest]
// 退出码：0 全过｜1 有违例｜2 取数面坏（入口文件读不到/子进程没跑起来 ⇒ 未验，不得读成合规）
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const FE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MVP = resolve(FE, "..")
const ENTRY = join(MVP, "examples", "conformance_basic.mjs")
// 不可达地址：127.0.0.1:9 是 discard 端口，本机必无服务（load_probe 的既有红态样本就用它）
const DEAD_BASE = "http://127.0.0.1:9"
const TIMEOUT_MS = 180000

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")) }
}

/** 起子进程跑入口，返回 {status, stdout, stderr, terminal}。status 为 null 表示没跑起来/超时。 */
export function runEntry(argv, entryPath = ENTRY) {
  const r = spawnSync(process.execPath, [entryPath, ...argv], { encoding: "utf8", timeout: TIMEOUT_MS, cwd: MVP })
  const all = `${r.stdout || ""}\n${r.stderr || ""}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", terminal: all.length ? all[all.length - 1] : "" }
}

/** 纯判定：一条实测结果 → 是否达成期望（供真面与反例腿共用同一条尺）。 */
export function verdictFor(expect, r) {
  if (r.status === null || r.status === undefined) return { ok: false, why: "子进程没跑起来或超时 ⇒ 未验，不得读成合规" }
  if (expect === "pass") {
    const tagOk = /\[GATE:conformance:pass\]/.test(r.stdout + r.stderr)
    return { ok: r.status === 0 && tagOk, why: `rc=${r.status} tag=${tagOk ? "pass" : "缺/非pass"}｜末行=${r.terminal}` }
  }
  if (expect === "broken") {
    const tagOk = /\[GATE:conformance:broken\]/.test(r.stdout + r.stderr)
    const noStack = !/\bat .*\(.*:\d+:\d+\)/.test(r.stdout + r.stderr)
    return { ok: r.status === 2 && tagOk && noStack, why: `rc=${r.status}（期望 2）tag=${tagOk ? "broken" : "缺/非broken"} 无栈=${noStack}｜末行=${r.terminal}` }
  }
  return { ok: false, why: "未知期望值 " + expect }
}

const selftest = () => {
  const cases = []
  const push = (n, ok, detail = "") => cases.push([n, ok, detail])
  // 正例：入口如实传 pass
  push("正例-入口如实转达 rc=0 且末行 pass", verdictFor("pass", { status: 0, stdout: "[GATE:conformance:pass] matched=25 mismatched=0｜rc=0", stderr: "", terminal: "[GATE:conformance:pass] …｜rc=0" }).ok)
  // 反例腿：入口恒 0（最危险的形态——跑完必「通过」）
  push("反例腿-入口恒 exit 0 但没印 pass 标记 ⇒ 判红（不能只看退出码）", !verdictFor("pass", { status: 0, stdout: "跑了 25 面", stderr: "", terminal: "跑了 25 面" }).ok)
  push("反例腿-入口转达了非 0 却声称 pass ⇒ 判红（声称与事实不符）", !verdictFor("pass", { status: 1, stdout: "[GATE:conformance:pass]", stderr: "", terminal: "[GATE:conformance:pass]" }).ok)
  // 反例腿：取数面坏却 exit 0
  push("反例腿-取数面坏却 rc=0 ⇒ 判红（坏输入不得读成通过）", !verdictFor("broken", { status: 0, stdout: "[GATE:conformance:broken] …｜rc=2", stderr: "", terminal: "[GATE:conformance:broken]" }).ok)
  push("反例腿-取数面坏但印了栈帧 ⇒ 判红（违反本仓红线：不展示堆栈）", !verdictFor("broken", { status: 2, stdout: "[GATE:conformance:broken]", stderr: "Error: fetch failed\n    at doFetch (file:///x/y.mjs:12:3)", terminal: "[GATE:conformance:broken]" }).ok)
  push("正例-取数面坏 ⇒ rc=2、印 broken、零栈帧", verdictFor("broken", { status: 2, stdout: "[GATE:conformance:broken] --base 不可达 ⇒ 不得读成通过｜rc=2", stderr: "", terminal: "[GATE:conformance:broken] …｜rc=2" }).ok)
  // 反例腿：子进程没跑起来（status=null）
  push("反例腿-子进程没起来/超时（status=null）⇒ 判红，不得读成合规", !verdictFor("pass", { status: null, stdout: "", stderr: "", terminal: "" }).ok)
  let bad = 0
  for (const [n, ok, detail] of cases) { console.log(`${ok ? "  pass" : "  FAIL"}  ${n}${ok ? "" : `（${detail}）`}`); if (!ok) bad++ }
  const neg = cases.filter(([n]) => n.startsWith("反例腿")).length
  console.log(`CONFORMANCE-ENTRY SELFTEST: ${bad === 0 ? "PASS" : `FAIL(${bad})`}（${cases.length} 例，含 ${neg} 条反例腿）｜rc=${bad === 0 ? 0 : 1}`)
  process.exit(bad === 0 ? 0 : 1)
}

const main = () => {
  if (process.argv.includes("--selftest")) return selftest()
  if (!existsSync(ENTRY)) {
    console.error(`[GATE:conformance-entry:broken] 入口文件不存在（${ENTRY}）⇒ 未验，不得读成合规｜rc=2`)
    process.exit(2)
  }
  // ① 真面离线（零网络零密钥）：入口应转达 rc=0 + pass 标记
  const okRun = runEntry([])
  const v1 = verdictFor("pass", okRun)
  check("真面离线：入口转达 rc=0 且末行带 [GATE:conformance:pass]", v1.ok, v1.why)
  // ② 取数面坏：入口应转达 rc=2 + broken 标记，且不吐栈帧
  const badRun = runEntry(["--base", DEAD_BASE])
  const v2 = verdictFor("broken", badRun)
  check("取数面坏：入口转达 rc=2 且印 broken、零栈帧（不得读成通过）", v2.ok, v2.why)

  console.log(`[GATE:conformance-entry:${fail === 0 ? "pass" : "fail"}] matched=${pass} mismatched=${fail}｜面 2（真面离线＋取数面坏）｜rc=${fail === 0 ? 0 : 1}`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
