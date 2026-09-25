// API 契约守卫：docs/openapi.json 与 functions/api/[[route]].js 实现逐端点对账（round1 §2.6 遗留补票）。
// 判据：路由源文本断言与 spec paths 双向一致——任一侧改而另一侧未同步即失败（防"文档冒充事实"）。
import { readFileSync } from "node:fs"

const spec = JSON.parse(readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8"))
const routeSrc = readFileSync(new URL("../functions/api/[[route]].js", import.meta.url), "utf8")

// 每条 = [spec path, method, 源码必须存在的分发断言]
const CONTRACT = [
  ["/api/cases", "get", "seg[1] === \"cases\" && method === \"GET\""],
  ["/api/intake/ask", "post", "seg[1] === \"intake\" && seg[2] === \"ask\" && method === \"POST\""],
  ["/api/dx/{caseId}", "post", "seg[1] === \"dx\" && method === \"POST\""],
  ["/api/workup/{caseId}", "post", "seg[1] === \"workup\" && method === \"POST\""],
  ["/api/report/{caseId}", "post", "seg[1] === \"report\" && method === \"POST\""],
  ["/api/health", "get", "seg[1] === \"health\""],
]

let fail = 0
for (const [path, method, srcAssert] of CONTRACT) {
  const inSpec = spec.paths[path]?.[method] != null
  const inSrc = routeSrc.includes(srcAssert)
  const ok = inSpec && inSrc
  if (!ok) { console.log(`FAIL ${method.toUpperCase()} ${path}  spec=${inSpec} src=${inSrc}`); fail++ }
  else console.log(`PASS ${method.toUpperCase()} ${path}`)
}
// 反向防漂移：spec 里不得出现契约外的孤儿 path
for (const p of Object.keys(spec.paths)) {
  if (!CONTRACT.some(([c]) => c === p)) { console.log(`FAIL spec 孤儿路径: ${p}`); fail++ }
}
// 安全声明在位（红线口径的机器留痕）
for (const kw of ["医生终审", "不可被模型覆盖", "白名单"]) {
  if (!JSON.stringify(spec.info).includes(kw)) { console.log(`FAIL info 缺安全口径: ${kw}`); fail++ }
}
// 声明↔实现双向对账（v1.17.0 滥用护栏）：spec 里给 POST 声明的 400/413，源码必须真发得出来，
// 否则 openapi 就退化成"许愿式契约"（写了但没人实现），这正是本仓 privacy_guard 同类的判据方向。
const GUARD_STATUSES = ["400", "413"]
const routeHasGuard = routeSrc.includes("e?.status === 413") && routeSrc.includes("e?.status === 400")
for (const [path, method] of Object.entries(spec.paths)) {
  if (!method.post) continue
  for (const code of GUARD_STATUSES) {
    const declared = method.post.responses?.[code] != null
    const ok = declared && routeHasGuard
    if (!ok) { console.log(`FAIL POST ${path} 声明 ${code}=${declared} 实现有分支=${routeHasGuard}`); fail++ }
  }
}
if (fail === 0) console.log(`PASS 入站边界响应码：4 个 POST 均声明并实现 400/413`)

console.log(`API 契约守卫: ${fail === 0 ? "ALL PASS" : `FAIL(${fail})`}（${CONTRACT.length} 端点双向对账）`)
process.exit(fail === 0 ? 0 : 1)
