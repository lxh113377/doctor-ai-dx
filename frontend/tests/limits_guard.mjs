// 滥用护栏对账门禁（第十九轮 v1.17.0）。三件事：数值同源、行为一致、**真接线**。
// 为什么"接线"要单独判：新增 lib 模块最容易的死法是写完没人调用（本仓历史上有 py 地板数字无人读、
// CI 覆盖率步骤挂错 job 等同类事故），所以除了跑行为断言，还要从路由源文本反查调用点。
// 用法：node tests/limits_guard.mjs [--selftest-negative]（后者会临时注入脏值验证本门禁真的会红）
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  MAX_BODY_BYTES, MAX_HISTORY_ITEMS, MAX_CONTENT_CHARS, MAX_DX_JSON_BYTES,
  parseBoundedBody, assertDeclaredSize, RequestTooLarge, byteLength,
} from "../functions/lib/limits.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "request_limits.json"), "utf8"))
const pySrc = readFileSync(join(REPO, "backend", "app", "limits.py"), "utf8")
const routeSrc = readFileSync(join(REPO, "frontend", "functions", "api", "[[route]].js"), "utf8")
const pyMain = readFileSync(join(REPO, "backend", "app", "main.py"), "utf8")
const pyModels = readFileSync(join(REPO, "backend", "app", "models.py"), "utf8")

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const pyNum = (name) => {
  const m = pySrc.match(new RegExp(`${name} = (\\d+)`))
  return m ? Number(m[1]) : NaN
}

console.log("== 1. 数值单一源三处全等（fixture ↔ JS ↔ Py）==")
for (const key of ["max_body_bytes", "max_history_items", "max_content_chars", "max_dx_json_bytes"]) {
  const jsVal = { max_body_bytes: MAX_BODY_BYTES, max_history_items: MAX_HISTORY_ITEMS, max_content_chars: MAX_CONTENT_CHARS, max_dx_json_bytes: MAX_DX_JSON_BYTES }[key]
  const pyVal = pyNum(key.toUpperCase())
  check(`${key} 三处全等（=${fixture[key]}）`, jsVal === fixture[key] && pyVal === fixture[key],
    `fixture=${fixture[key]} js=${jsVal} py=${pyVal}`)
}

console.log("== 2. 行为：合法请求必须放行（护栏不得误伤真实链路）==")
const legal = JSON.stringify({ case_id: "c1", history: [{ role: "user", content: "压榨样胸痛伴冷汗" }] })
let legalOk = true
let legalErr = ""
try { parseBoundedBody(legal) } catch (e) { legalOk = false; legalErr = e.reason }
check("正常 body 放行", legalOk, legalErr)
check("空 body 仍返回 {}（保持既有契约，不在本轮改行为）", JSON.stringify(parseBoundedBody("")) === "{}")
assertDeclaredSize("512") // 真实峰值量级必须不抛
check("合法量级的 Content-Length 不拦", true)

console.log("== 3. 行为：越界必须拒绝且只出可理解文案 ==")
const rejects = [
  ["body 字节超限", JSON.stringify({ history: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES + 10) }] }), 413],
  ["history 条数超限", JSON.stringify({ history: Array.from({ length: MAX_HISTORY_ITEMS + 6 }, () => ({ role: "user", content: "a" })) }), 413],
  ["单条文本超限", JSON.stringify({ history: Array.from({ length: 3 }, () => ({ role: "user", content: "y".repeat(MAX_CONTENT_CHARS + 500) })) }), 413],
  ["坏 JSON", "{oops", 400],
  ["顶层非对象", "[1,2,3]", 400],
  ["dx 单条证据超长", JSON.stringify({ dx: { evidence: [{ text: "z".repeat(MAX_CONTENT_CHARS + 10) }] } }), 413],
]
for (const [name, body, want] of rejects) {
  let got = 0
  let msg = ""
  try { parseBoundedBody(body); got = 0 } catch (e) { got = e.status; msg = e.message }
  check(`${name} → ${want}`, got === want, `实测 ${got || "未拦"}`)
  if (got === want) {
    check(`  └ ${name} 文案医生可读（无路径/无内部计算）`,
      !/[A-Za-z]:\\|\//.test(msg) && !/>\s*\d/.test(msg) && msg.length > 8, msg)
  }
}
check("Content-Length 伪造为超大也拦", (() => { try { assertDeclaredSize("9001000"); return false } catch (e) { return e instanceof RequestTooLarge } })())
check("Content-Length 非法字符串不误拦", (() => { try { assertDeclaredSize("abc"); return true } catch { return false } })())

console.log("== 4. 双端响应同形同码（镜像既有 {code,message} 契约）==")
const jsMsg = new RequestTooLarge("x").message
// 从 Py 源里取 RequestTooLarge 的对外文案（实际源码是 super().__init__("...")）
// 文案对账用「JS 文案原样出现在 Py 源里」这一条硬判据（不做正则提取：跨语言提字面量易碎，
// 且提错时会退化成"两边都取到空串＝相等"的假通过）。
check("Py 与 JS 的 413 文案逐字相同", pySrc.includes(jsMsg) && jsMsg.length > 8,
  `JS 文案=${JSON.stringify(jsMsg)} 未在 backend/app/limits.py 中找到`)
check("Py 侧 reason 只进日志不进响应", !/content \d+ > /.test(new RequestTooLarge("history 条数 70 > 64").message))
check("Py 处理器注册了 413 专用分支（不再落 500 兜底）",
  /exception_handler\(RequestTooLarge\)/.test(pyMain) && /status_code=exc\.status/.test(pyMain))
check("Py 契约层真的调用边界检查（models 非死代码）",
  /limits\.check_history\(/.test(pyModels) && /limits\.check_dx\(/.test(pyModels))
// 判据升级（本轮实测驱动）：先前写的是"main.py 里出现 MAX_BODY_BYTES 字样"，
// 而我把阈值逻辑收进 limits.check_declared_size 后该字样消失，判据立刻误判红——
// 说明它盯的是**实现细节的形态**而不是**行为**。改盯"中间件必须委托单一实现 + 处理越界异常"，
// 这样阈值只有一处定义（两处各写一遍正是漂移的开端）。
check("Py 中间件委托 limits 单一实现做声明长度检查",
  /limits\.check_declared_size\(/.test(pyMain) && /except RequestTooLarge/.test(pyMain) && /content-length/.test(pyMain),
  "中间件未委托单一实现（自己重写阈值判断＝两套实现漂移）")
check("阈值只在 limits 一处定义（main.py 不得再出现 MAX_BODY_BYTES 字面量）", !/MAX_BODY_BYTES/.test(pyMain))

console.log("== 5. 接线实证：Functions 路由真的调用护栏 ==")
check("route.js 导入 limits", /from "\.\.\/lib\/limits\.js"/.test(routeSrc))
check("route.js 声明长度先检", /assertDeclaredSize\(context\.request\.headers\.get\("content-length"\)\)/.test(routeSrc))
const routeCode = routeSrc.split("\n").filter((x) => !/^\s*\/\//.test(x)).join("\n") // 剥掉整行注释后再做反模式匹配
check("route.js 用 parseBoundedBody 取代静默 catch", /parseBoundedBody\(await context\.request\.text\(\)\)/.test(routeCode)
  && !/catch\s*\{\s*return\s*\{\}\s*\}/.test(routeCode), "代码里仍残留静默 catch 即为假接线")
check("客户端 4xx 不被记成 error 级日志",
  routeSrc.indexOf('logEvent("warn", { req: requestId, path, method, ms, kind: e.name') < routeSrc.indexOf('logEvent("error"'),
  "413/400 分支必须在 error 日志之前")

console.log("== 6. 上限余量证明（防把上限定得比真实链路还小）==")
const suite = JSON.parse(readFileSync(join(HERE, "fixtures", "eval_cases.json"), "utf8"))
let maxBody = 0
let maxItems = 0
let maxChars = 0
for (const c of suite.cases) {
  maxItems = Math.max(maxItems, c.answers.length)
  maxBody = Math.max(maxBody, byteLength(JSON.stringify({ case_id: c.case_id || "c1", history: c.answers.map((a) => ({ role: "user", content: a })) })))
  for (const a of c.answers) maxChars = Math.max(maxChars, a.length)
}
check(`31 例最大 body ${maxBody}B < 上限 ${MAX_BODY_BYTES}B`, maxBody < MAX_BODY_BYTES)
check(`31 例最长 history ${maxItems} 条 < 上限 ${MAX_HISTORY_ITEMS} 条`, maxItems < MAX_HISTORY_ITEMS)
check(`31 例最长单条 ${maxChars} 字 < 上限 ${MAX_CONTENT_CHARS} 字`, maxChars < MAX_CONTENT_CHARS)
console.log(`  信息：真实峰值 body=${maxBody}B history=${maxItems}条 ⇒ 余量 ${(MAX_BODY_BYTES / Math.max(1, maxBody)).toFixed(1)}x`)

if (process.argv.includes("--selftest-negative")) {
  // 变异体：故意断言一个必假命题，证明"判红路径真的会走到 exit 1"而不是静默通过
  console.log("== 反例模式（本次运行预期 FAIL + exit 1）==")
  check("上限小于真实峰值时必须判红", MAX_BODY_BYTES < maxBody, `实测 MAX_BODY_BYTES=${MAX_BODY_BYTES} maxBody=${maxBody}`)
  check("坏 JSON 必须被拒", (() => { try { parseBoundedBody("{oops"); return true } catch { return false } })() === false,
    "反例：此条必为 FAIL，用于自证门禁会红")
}

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
