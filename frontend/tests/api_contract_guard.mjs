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

// 错误目录（docs/ERRORS.md）↔ 契约 ↔ 实现三方对账（v1.20.0 第二十二轮）。
// 为什么值得单独立判据：集成方（HIS、脚本、AI Agent）写重试分支时只看文档，不看 openapi 的 $ref；
// 文档一旦落后，"能用但会误导"比"直接报错"更糟。所以：**码集合双向全等 + 文案逐字等于常量**。
const errDoc = readFileSync(new URL("../../docs/ERRORS.md", import.meta.url), "utf8")
const rows = [...errDoc.matchAll(/^\|\s*`(\d{3})`\s*\|([^|]*)\|([^|]*)\|/gm)]
  .map((m) => ({ code: Number(m[1]), msg: m[3].replace(/`/g, "").trim() }))
const declaredCodes = new Set(
  Object.values(spec.paths).flatMap((ops) => Object.values(ops).flatMap((op) => Object.keys(op.responses || {})))
    .map(Number),
)
checkRows(rows, declaredCodes)

function checkRows(list, declared) {
  if (list.length < 5) { console.log(`FAIL ERRORS.md 表行过少(${list.length})＝文档没写全或表格格式变了`); fail++; return }
  const docCodes = new Set(list.map((r) => r.code))
  const missing = [...declared].filter((c) => !docCodes.has(c))
  const extra = [...docCodes].filter((c) => !declared.has(c))
  if (missing.length) { console.log(`FAIL ERRORS.md 缺状态码行：${missing}（openapi 已声明却没写进文档）`); fail++ }
  if (extra.length) { console.log(`FAIL ERRORS.md 出现 openapi 未声明的码：${extra}（文档领先实现）`); fail++ }
  // 有常量的三个码，文案必须逐字相等（404/500 由路由拼装、不在此列，由 error_parity 三方对账兜）
  const wantMsg = {
    [limits.STATUS_BAD_JSON]: limits.BAD_JSON_MESSAGE,
    [limits.STATUS_TOO_LARGE]: limits.TOO_LARGE_MESSAGE,
    [limits.STATUS_BAD_SHAPE]: limits.BAD_SHAPE_MESSAGE,
  }
  for (const r of list) {
    const want = wantMsg[r.code]
    if (want === undefined) continue
    const got = r.msg.replace(/（.*$/, "").trim()
    if (got !== want) { console.log(`FAIL ERRORS.md ${r.code} 文案与实现常量不等：文档="${got}" 常量="${want}"`); fail++ }
  }
  if (!missing.length && !extra.length) {
    console.log(`PASS 错误目录与契约双向全等（${list.length} 行 / 声明码 ${declared.size} 个），三处文案等于 limits 常量`)
  }
}

console.log(`API 契约守卫: ${fail === 0 ? "ALL PASS" : `FAIL(${fail})`}（${CONTRACT.length} 端点双向对账）`)
process.exit(fail === 0 ? 0 : 1)
