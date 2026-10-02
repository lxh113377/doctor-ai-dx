// 主包体积地板线（round4 实测 react 19.3 使 gzip 65.07→73.81KB 无门禁拦截 → 补防回弹资产）。
// 前置：先 npm run build（dist 缺失 = 显式失败，禁止静默跳过，R236）。
// 上限依据 2026-09-24 实测标定：主 chunk 73,806B、assets 合计 82,174B；上限 = 实测 + 约 5% 余量。
// 2026-10-02 重新标定（round90 对话面）：加入两个**懒加载**视图（ChatView 2,150B ＋ AdminView 1,880B gzip）
// 后 assets 合计实测 87,614B ⇒ 上限 = 87,614 × 1.05 ≈ 92,000B。**主 chunk 未变**（72,458B），
// 因此 MAX_INDEX_GZIP 不动——新增体积来自按需分块，不是首屏变胖，这条区分要留着。
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { gzipSync } from "node:zlib"

const MAX_INDEX_GZIP = 77500
const MAX_ASSETS_TOTAL_GZIP = 92000
const dir = new URL("../dist/assets/", import.meta.url)

if (!existsSync(dir)) {
  console.error("FAIL dist/assets 不存在——先 npm run build（缺产物不算通过）")
  process.exit(1)
}
let total = 0
let max = { name: "", bytes: 0 }
for (const f of readdirSync(dir)) {
  const b = gzipSync(readFileSync(new URL(f, dir))).length
  total += b
  if (b > max.bytes) max = { name: f, bytes: b }
}
const checks = [
  [`主 chunk gzip ≤ ${MAX_INDEX_GZIP}B`, max.bytes <= MAX_INDEX_GZIP],
  [`assets 合计 gzip ≤ ${MAX_ASSETS_TOTAL_GZIP}B`, total <= MAX_ASSETS_TOTAL_GZIP],
]
let fail = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`)
  if (!ok) fail++
}
console.log(`体积地板线: max=${max.name} ${max.bytes}B total=${total}B → ${fail === 0 ? "ALL PASS" : "FAIL"}`)
process.exit(fail === 0 ? 0 : 1)
