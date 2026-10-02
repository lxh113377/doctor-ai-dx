// 管理后台鉴权守卫（round90）：三态鉴权 + 令牌不落库 + 恒定时间比较。
//
// 三态是刻意设计的：**未配置 ADMIN_TOKEN 时一律 503 拒绝，而不是放行**。
// 「没配就当没门」是后台类端点最常见的安全塌陷，所以这里把它写成判据而不是注释。
// 反向对照尤其重要：如果守卫只测「拒绝」而不测「正确令牌必须放行」，
// 一个永远拒绝的实现也能全绿——那是假绿。
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { onRequest } from "../functions/api/[[route]].js"
import { safeEqual, authorizeAdmin } from "../functions/lib/admin_auth.js"

/** 令牌是否出现在一段文本里——抽成函数，好让「反向对照」能真的驱动它一次。 */
const leaksSecret = (text, secret) => text.includes(secret)

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const SECRET = "guard-only-token-9f2c"
const call = (path, token, env) => onRequest({
  request: new Request(`https://dx.test${path}`, { headers: token ? { "x-admin-token": token } : {} }),
  env,
})

console.log("== 三态鉴权（已配置令牌）==")
const envOn = { ADMIN_TOKEN: SECRET }
const noTok = await call("/api/admin/stats", "", envOn)
check("无令牌 => 401", noTok.status === 401, String(noTok.status))
const badTok = await call("/api/admin/stats", "wrong", envOn)
check("错误令牌 => 403", badTok.status === 403, String(badTok.status))
const good = await call("/api/admin/stats", SECRET, envOn)
check("正确令牌 => 200（反向对照：防「永远拒绝」的假绿）", good.status === 200, String(good.status))

console.log("== 未配置令牌 ==")
for (const p of ["/api/admin/stats", "/api/admin/handoffs", "/api/admin/conversations"]) {
  const r = await call(p, SECRET, {})
  check(`${p} 未配置令牌 => 503（不放行）`, r.status === 503, String(r.status))
}
check("authorizeAdmin 直接调用：未配置 => 503", authorizeAdmin({ headers: new Headers() }, {}).status === 503)
check("authorizeAdmin 直接调用：正确令牌 => ok", authorizeAdmin({ headers: new Headers({ "x-admin-token": SECRET }) }, envOn).ok === true)

console.log("== 令牌不得出现在任何被跟踪源文件里 ==")
// 递归扫 frontend/functions 与 data：令牌值一旦被写进代码/配置，就是可从仓库读出的"秘密"。
const scanDirs = ["../functions", "../../data"]
const walk = (p, out = []) => {
  for (const n of readdirSync(p)) {
    const f = join(p, n)
    if (statSync(f).isDirectory()) walk(f, out)
    else if (/\.(js|json|toml)$/.test(n)) out.push(f)
  }
  return out
}
const files = scanDirs.flatMap((d) => walk(fileURLToPath(new URL(d, import.meta.url))))
check("扫描面非空（零命中是假象）", files.length > 10, `files=${files.length}`)
const leaks = files.filter((f) => leaksSecret(readFileSync(f, "utf8"), SECRET))
check("守卫令牌值未出现在任何源文件", leaks.length === 0, leaks.join(","))
// 反向对照：把同一批文本在内存里植入令牌，同一个判据必须点名——否则上面那条可能恒真。
check("反向对照：植入令牌后同一判据必须命中（证明扫描器不是摆设）",
  leaksSecret(`ADMIN_TOKEN=${SECRET}`, SECRET) && leaksSecret("ADMIN_TOKEN=", SECRET) === false)

console.log("== 恒定时间比较 ==")
check("safeEqual 相同串 => true", safeEqual(SECRET, SECRET) === true)
check("safeEqual 不同串 => false", safeEqual(SECRET, SECRET + "x") === false)
check("safeEqual 空串 vs 非空 => false", safeEqual("", SECRET) === false)

console.log(`\nADMIN AUTH GUARD: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)