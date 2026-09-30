// OPENAPI.md 漂移守卫（第八十三轮）：docs/OPENAPI.md 是 docs/openapi.json 的派生件，
// 第八十二轮它由一次性命令产出、既无生成源也无守卫 ⇒ 属 #106 同族（手抄快照必然过期）：
// json 里加一个端点或升一个版本号，md 会静静地停在旧值上，而人类正是读 md 的那一方。
// 判据：版本 / 端点集合 / 每端点响应码 / summary 文案 四处**双向全等**，任一侧单向改动即红。
import { readFileSync, existsSync } from "node:fs"

const spec = JSON.parse(readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8"))
const mdPath = new URL("../../docs/OPENAPI.md", import.meta.url)

let fail = 0
if (!existsSync(mdPath)) {
  console.log("FAIL docs/OPENAPI.md 缺失（由 docs/openapi.json 派生，运行 python scripts/gen_openapi.py）")
  process.exit(1)
}
const md = readFileSync(mdPath, "utf8")

// 1) 版本：json info.version ⇄ md 头部"版本: x.y.z"
const mdVer = /^版本:\s*(\S+)/m.exec(md)?.[1]
if (mdVer !== spec.info.version) {
  console.log(`FAIL 版本漂移：md=${mdVer} json=${spec.info.version}`)
  fail++
} else console.log(`PASS 版本一致：${mdVer}`)

// 2) 端点集合双向全等（method+path）
const wantOps = new Set()
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const m of Object.keys(ops)) wantOps.add(`${m.toUpperCase()} ${path}`)
}
const gotOps = new Set([...md.matchAll(/^##\s+([A-Z]+)\s+(\S+)\s*$/gm)].map((m) => `${m[1]} ${m[2]}`))
for (const op of wantOps) if (!gotOps.has(op)) { console.log(`FAIL md 缺端点：${op}`); fail++ }
for (const op of gotOps) if (!wantOps.has(op)) { console.log(`FAIL md 出现 json 未声明的端点：${op}`); fail++ }
if ([...wantOps].every((o) => gotOps.has(o)) && gotOps.size === wantOps.size) {
  console.log(`PASS 端点集合双向全等（${wantOps.size} 个）`)
}

// 3) 每端点响应码⇄summary 逐字对账（防"人顺手改了 md 文案，契约却没变"）
const blocks = md.split(/^##\s+/m).slice(1)
for (const block of blocks) {
  const head = /^([A-Z]+)\s+(\S+)\s*$/m.exec(block.split("\n")[0])
  if (!head) continue
  const [, method, path] = head
  const op = spec.paths[path]?.[method.toLowerCase()]
  if (!op) continue
  const wantCodes = Object.keys(op.responses || {}).sort((a, b) => a - b)
  const gotCodes = (/响应码:\s*([^\n]+)/.exec(block)?.[1] || "").split("/").map((s) => s.trim()).filter(Boolean).sort((a, b) => a - b)
  if (wantCodes.join("/") !== gotCodes.join("/")) {
    console.log(`FAIL ${method} ${path} 响应码：md=${gotCodes.join("/") || "空"} json=${wantCodes.join("/")}`)
    fail++
  } else console.log(`PASS ${method} ${path} 响应码 ${wantCodes.join("/")}`)
  const wantSummary = (op.summary || "").trim()
  if (wantSummary && !block.includes(wantSummary)) {
    console.log(`FAIL ${method} ${path} summary 与 json 不等：json="${wantSummary}"`)
    fail++
  }
}

// 4) 派生声明在位（缺了就退化成"看着像权威、其实可手改"的第二真值源）
if (!/单向派生/.test(md)) { console.log("FAIL md 缺「单向派生」声明"); fail++ }
else console.log("PASS 派生声明在位")

console.log(`OPENAPI.md 漂移守卫: ${fail === 0 ? "ALL PASS" : `FAIL(${fail})`}（版本/端点/响应码/summary 四处双向对账）`)
process.exit(fail === 0 ? 0 : 1)
