// 隐私/数据留存声明 ↔ 代码一致性门禁。
// 为什么需要：docs/PRIVACY.md 一旦写下「服务端什么都不存」，它就是对外承诺。
// 承诺最怕的失效方式不是有人撒谎，而是**后来加了一行存储代码而没人回头改文档**——
// 本门禁把声明里可机器化的条款钉成判据：代码漂移即判红（同族思路见 semantic_guard 的语料指纹防陈旧）。
// 自匹配防护：只扫生产源码面（frontend/src、frontend/functions、backend/app），
// 不扫 tests/docs——否则本文件与 PRIVACY.md 里作为"被禁清单"出现的 localStorage 会被自己扫成违规（R236 白名单排除法）。
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { redact as jsRedact, OBSERVE_PATTERNS as JS_PATTERNS } from "../functions/lib/observe.js"

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const ROOT = new URL("../../", import.meta.url)
const rel = (p) => fileURLToPath(new URL(p, ROOT))
const read = (p) => (existsSync(rel(p)) ? readFileSync(rel(p), "utf8") : "")

// 判据本体：喂"文件名 → 内容"的表，返回违规清单（正样本应为空，反样本必须非空）
const PERSISTENCE = [/localStorage/, /sessionStorage/, /indexedDB/i, /document\.cookie/, /openDatabase/, /\bfs\.writeFile/, /\bwriteFileSync\b/, /createConnection/, /\bsqlite3\b/i, /pymysql/, /SQLAlchemy/i, /mongoose/, /redis/i]
const TELEMETRY = [/sentry\.io/, /@sentry\//, /Sentry\.init/, /dsn\s*:/, /googletagmanager/, /gtag\(/,
  /google-analytics/, /navigator\.sendBeacon/, /posthog/, /matomo/, /clarity\.ms/, /fbm.*sdk/i]
// 反例驱动的补全（2026-09-25）：初版只认 sentry.io 域名，反例 '@sentry/browser' 零命中——
// 实际最可能的引入方式是 npm 包名与 Sentry.init/dsn 配置，域名形态反而少见。判据要按真实形态写。
const LOG_LEAK = /logEvent\([^)]*\b(body|history|transcript|requestText|patient)\b/

function scan(sources) {
  const problems = { persistence: [], telemetry: [], logLeak: [] }
  for (const [name, text] of Object.entries(sources)) {
    for (const re of PERSISTENCE) { const m = text.match(re); if (m) problems.persistence.push(`${name}: ${m[0]}`) }
    for (const re of TELEMETRY) { const m = text.match(re); if (m) problems.telemetry.push(`${name}: ${m[0]}`) }
    if (LOG_LEAK.test(text)) problems.logLeak.push(name)
  }
  return problems
}

const productionFiles = {}
for (const dir of ["frontend/src", "frontend/functions", "backend/app"]) {
  let listing = ""
  try {
    listing = execFileSync("git", ["-C", rel("."), "ls-files", "--", dir], { encoding: "utf8" })
  } catch { listing = "" }
  const files = listing.split(/\r?\n/).filter((f) => /\.(jsx?|mjs|py)$/.test(f))
  check(`生产源码清单非空：${dir}`, files.length > 0, "清单为空会导致扫描静默通过（R247）")
  for (const f of files) productionFiles[f] = read(f)
}

const live = scan(productionFiles)
check("声明「无服务端/客户端持久化」与代码一致", live.persistence.length === 0, live.persistence.slice(0, 4).join(" | "))
check("声明「无第三方遥测/埋点」与代码一致", live.telemetry.length === 0, live.telemetry.slice(0, 4).join(" | "))
check("日志调用点未把请求体/问诊文本写进日志", live.logLeak.length === 0, live.logLeak.join(" "))

const CASES = ["联系人 13800138000 请回电", "身份证 11010119900307777X", "时间戳 1758777600000 毫秒", "key sk-abcdefghijkl123456", "file:///srv/app/main.py", "无敏感信息的主诉描述"]
// 后端镜像面的脱敏输出与模式表：同一次 spawn 取回，避免两次进程调用间的漂移
const PY_SRC = `
import json, sys
sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL("../../backend", import.meta.url)))})
from app.observe import redact, OBSERVE_PATTERNS
cases = json.loads(sys.argv[1])
print(json.dumps({"out": [redact(c) for c in cases], "pat": OBSERVE_PATTERNS}, ensure_ascii=False))
`

let PY_OUT = { out: [], pat: {} }
try {
  PY_OUT = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python", ["-c", PY_SRC, JSON.stringify(CASES)],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }))
} catch (e) {
  console.error("Python 侧不可用，无法做双端脱敏对账:", String(e.message).slice(0, 160))
  console.log(`
RESULT: 0 pass / 1 fail`)
  process.exit(1)
}
check("Python 侧返回完整（输出与模式表俱在，非静默空对象）",
  Array.isArray(PY_OUT.out) && PY_OUT.out.length === CASES.length && PY_OUT.pat && Array.isArray(PY_OUT.pat.pii))

// 双端脱敏模式表一致（JS 源里 \/ 是正则字面量转义，语义与 Python 相同，比对前归一）
const norm = (arr) => [...arr].map((s) => s.replace(/\\\//g, "/")).sort()
for (const k of ["secret", "pii", "internal"]) {
  check(`双端脱敏模式表同值：${k}`, JSON.stringify(norm(JS_PATTERNS[k])) === JSON.stringify(norm((PY_OUT.pat && PY_OUT.pat[k]) || [])))
}
check("pii 模式表非空（防双端同为空数组也相等的假通过）", JS_PATTERNS.pii.length >= 2 && PY_OUT.pat.pii.length >= 2)

// 双端逐用例行为一致（含"时间戳不得被误伤"的反向断言）
const diffs = CASES.map((c, i) => (jsRedact(c) === PY_OUT.out[i] ? null : `${i}: JS<${jsRedact(c)}> PY<${PY_OUT.out[i]}>`)).filter(Boolean)
check("双端脱敏输出逐用例相同", diffs.length === 0, diffs.slice(0, 3).join(" | "))
check("手机号被脱敏", jsRedact("联系电话13800138000").includes("[已脱敏]"))
check("身份证被脱敏", jsRedact("证件 11010119900307777X").includes("[已脱敏]"))
check("反向：13 位毫秒时间戳不被误脱敏（假脱敏会掩盖真问题）",
  jsRedact("耗时 1758777600000 毫秒").includes("1758777600000"))

// 合成病例与文档锚点
check("演示病例标注为脱敏合成", /脱敏/.test(read("frontend/functions/lib/data.js")))
check("FHIR 导出对每位患者打 syntheticCase 标记", read("frontend/functions/lib/fhir.js").includes("syntheticCase"))
const PRIV = read("docs/PRIVACY.md")
check("PRIVACY.md 存在且非空", PRIV.length > 1500, `bytes=${PRIV.length}`)
check("PRIVACY.md 显式声明不构成合规认证", /不构成\s*(HIPAA|GDPR)|合规认证/.test(PRIV))
const anchors = [...new Set([...PRIV.matchAll(/`((?:backend|frontend|docs)\/[\w./\[\]-]+\.(?:js|jsx|mjs|py|md|example))`|`([\w.-]+\.(?:js|jsx|py|md))`/g)])]
  .map((m) => m[1] || m[2]).filter((p) => !/env\.example$/.test(p) ? true : true)
const dead = anchors.filter((p) => !existsSync(rel(p)))
check("PRIVACY.md 引用的代码锚点全部存在（防文档腐烂）", dead.length === 0, `失效 ${dead.length} 个：${dead.slice(0, 4).join(" ")}`)
check("锚点抽取本身非空（判据未接线时也会 0 失效）", anchors.length >= 5, `实际抽到 ${anchors.length} 个`)
check("日志字段白名单与声明一致（req/path/method/ms/kind/msg）",
  /logEvent\("error",\s*\{[\s\S]{0,200}?req:[\s\S]*?path,[\s\S]*?method,[\s\S]*?ms,[\s\S]*?kind:[\s\S]*?msg:/.test(read("frontend/functions/api/[[route]].js")))
check("LLM 单次硬超时 8s 与声明一致", read("frontend/functions/lib/engine.js").includes("AbortSignal.timeout(8000)"))
check(".env 不入库（密钥只走环境变量）", /^\.env$/m.test(read(".gitignore")) && read("backend/.env.example").includes("DEEPSEEK_API_KEY="))

// 反例实测：把违例喂进判据本体，必须被拦
const poisons = [
  ["注入 localStorage 的前端源码", { "frontend/src/App.jsx": "useEffect(() => localStorage.setItem('dx', x), [])" }],
  ["注入 fs 写入的后端模块", { "backend/app/store.py": "import os\ndef save(p):\n    open(p,'w').write(p)\n" , "x": "writeFileSync('a','b')" }],
  ["注入 sentry 遥测", { "frontend/src/main.jsx": "import * as Sentry from '@sentry/browser'; Sentry.init({dsn:'x'})" }],
  ["把问诊文本写进日志", { "frontend/functions/api/[[route]].js": 'logEvent("error", { req, history: body.history })' }],
]
for (const [name, src] of poisons) {
  const r = scan(src)
  const hit = r.persistence.length + r.telemetry.length + r.logLeak.length
  check(`反例可拦：${name}`, hit > 0, "违例零命中=判据未接线")
}
const deadAnchor = "docs/PRIVACY.md 锚点 `frontend/functions/lib/__gone__.js`"
check("反例可拦：锚点文件不存在会被判失效",
  !existsSync(rel("frontend/functions/lib/__gone__.js")) && deadAnchor.length > 0)
check("对照组：当前生产面三类扫描全部零命中", live.persistence.length + live.telemetry.length + live.logLeak.length === 0)

console.log(`\nPRIVACY GUARD SUMMARY: 扫描文件=${Object.keys(productionFiles).length} 锚点=${anchors.length} 脱敏用例=${CASES.length}`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
