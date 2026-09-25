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
// 声明↔实现双向对账（v1.17.0 滥用护栏；v1.19.0 起含 422）：spec 里给 POST 声明的 400/413/422，
// 源码必须真发得出来，否则 openapi 就退化成"许愿式契约"（写了但没人实现）。
// 本轮把"实现有分支"的判法从**比字符串**（`routeSrc.includes("e?.status === 413")`）升级为
// **比实现真的会抛出的状态码集合**：源码里的 if 条件写法一改（本轮改成 4xx 区间判断），
// 旧判法就会假红；而"某个 4xx 码由 limits 里的哪个常量产出"才是契约本体。
const GUARD_STATUSES = ["400", "413", "422"]
const limits = await import("../functions/lib/limits.js")
const produced = new Set([limits.STATUS_BAD_JSON, limits.STATUS_TOO_LARGE, limits.STATUS_BAD_SHAPE].map(Number))
if (produced.size !== GUARD_STATUSES.length) {
  console.log(`FAIL limits.js 产出的 4xx 状态码数(${produced.size}) 与声明数(${GUARD_STATUSES.length})不符`); fail++
}
const routeHasGuard = /e\.status >= 400 && e\.status < 500/.test(routeSrc)
for (const [path, method] of Object.entries(spec.paths)) {
  if (!method.post) continue
  for (const code of GUARD_STATUSES) {
    const declared = method.post.responses?.[code] != null
    const ok = declared && produced.has(Number(code)) && routeHasGuard
    if (!ok) {
      console.log(`FAIL POST ${path} 声明 ${code}=${declared} 实现产出该码=${produced.has(Number(code))} 路由有 4xx 分支=${routeHasGuard}`)
      fail++
    }
  }
}
if (fail === 0) console.log(`PASS 入站边界响应码：4 个 POST 均声明并由 limits 常量产出 ${GUARD_STATUSES.join("/")}`)

console.log(`API 契约守卫: ${fail === 0 ? "ALL PASS" : `FAIL(${fail})`}（${CONTRACT.length} 端点双向对账）`)
process.exit(fail === 0 ? 0 : 1)
