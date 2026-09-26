// 配置契约门禁（第十八轮）：代码里读的环境变量必须全部写在 backend/.env.example 里。
// 立论：`.env.example` 是「从零启动」唯一的人读入口，属**声明面**；声明面靠手工维护必然漂移。
// 本轮首跑即抓到一条真实漂移：`BGE_ENGINE_DIR`（scripts/build_semantic_neighbors.py 读）从未出现在 .env.example。
// 对标：OpenEMR 有 `Check Vendored Contracts`（契约文件防漂移）、ragflow 有 `conf/service_conf.yaml.example`
// 的「example 即契约」惯例——都是把声明面钉成判据，而非靠人记。
// 口径：只扫**字面量**键名（getenv("X") / environ["X"] / environ.get("X")）。动态拼接的键不在本判据内（实测无此用法）。
// 用法：node tests/env_guard.mjs [--quiet]
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..")
const ENV_EXAMPLE = join(REPO, "backend", ".env.example")

// 扫描根分两面对账：`.env.example` 是**应用**从零启动的人读入口，把 CI 令牌写进去会误导使用者
// （"跑演示要 GitHub token？"——不要）。故工具链侧的键改由 `.github/workflows/*` 自身担保声明，
// 判据仍闭合：应用面必须入 .env.example，工具面必须入两者之一，且任何键一旦被应用面读取就回到
// .env.example 口径（生产运行面因此不可能悄悄拿去读 CI 令牌）。
const APP_ROOTS = [
  join(REPO, "backend", "app"),
  join(REPO, "backend", "tests"),
  join(REPO, "backend", "run.py"),
  join(REPO, "frontend", "functions"),
]
const TOOL_ROOTS = [join(REPO, "scripts")]
const WF_DIR = join(REPO, ".github", "workflows")
const SKIP_NAMES = new Set(["node_modules", "dist", ".wrangler", "__pycache__", "test-results"])
// 键名前面可能有引号（Python 的 getenv("K") / environ["K"]），JS 侧是 env?.K / env.K（可选链必须吃到）
// JS 权威面读的是 `env?.DEEPSEEK_API_KEY`（可选链）。实测：漏吃 `?.` 时 JS 侧命中直接归 0，
// 而"总键数"仍非空（Python 侧 8 个键已覆盖同名项）——所以必须有下面的「双端各自非空」判据兜住半边失效。
const KEY_RE = /(?:getenv\(\s*|environ(?:\.get)?\(\s*|environ\[\s*|env\s*\??\s*\.\s*)["']?([A-Z][A-Z0-9_]{2,})\b/g

function walk(p, out) {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP_NAMES.has(name) || name.startsWith(".")) continue
      walk(join(p, name), out)
    }
  } else if (/\.(py|js|mjs|jsx)$/.test(p)) out.push(p)
  return out
}

const files = []
const toolFiles = []
for (const root of APP_ROOTS) {
  try { walk(root, files) } catch { /* 目录不存在＝扫描面收缩，由下面的非空证明拦住 */ }
}
for (const root of TOOL_ROOTS) {
  try { walk(root, toolFiles) } catch { /* 同上 */ }
}

const reads = new Map() // key -> [file:line]
const keySides = new Map() // key -> Set<"app"|"tool">，用来判"这个键有没有被应用面读过"
function collect(list, side) {
  for (const f of list) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/)
    lines.forEach((line, i) => {
      if (/^\s*(#|\/\/)/.test(line)) return // 注释里的键名不算读取点（防用文档字面量满足判据）
      for (const m of line.matchAll(KEY_RE)) {
        const k = m[1]
        if (!reads.has(k)) reads.set(k, [])
        reads.get(k).push(`${relative(REPO, f).replace(/\\/g, "/")}:${i + 1}`)
        if (!keySides.has(k)) keySides.set(k, new Set())
        keySides.get(k).add(side)
      }
    })
  }
}
collect(files, "app")
collect(toolFiles, "tool")

// CI 侧声明面：工作流里出现过的 secrets/env 键名即"由 CI 提供"的证明（不另立手工白名单，防第二真值）。
// 两条通道都要吃：`${{ secrets.X }}` 直引，和 `env:` 段里的键名映射（本仓用的是后者）。
const ciDeclared = new Set()
try {
  for (const name of readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(name)) continue
    const text = readFileSync(join(WF_DIR, name), "utf8")
    for (const m of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) ciDeclared.add(m[1].toUpperCase())
    for (const m of text.matchAll(/^\s{2,}([A-Z][A-Z0-9_]{2,}):.*\$\{\{/gm)) ciDeclared.add(m[1])
  }
} catch { /* 目录缺失由下面 check 拦住 */ }

const documented = new Map()
for (const line of readFileSync(ENV_EXAMPLE, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=(.*)$/)
  if (m) documented.set(m[1], m[2].trim())
}

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; if (!QUIET) console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const QUIET = process.argv.includes("--quiet")

// 1) 非空证明：扫描面与键集合都必须非空，否则"零漂移"是假象（R247）
check(`扫描面非空（${files.length} 个文件、读到 ${reads.size} 个环境变量键）`, files.length >= 20 && reads.size >= 5,
  `files=${files.length} keys=${reads.size}`)
check(`.env.example 非空（声明 ${documented.size} 个键）`, documented.size >= 5, `实测 ${documented.size}`)

// 1b) 双端各自都要有命中：权威面是 Functions(JS)，镜像面是 FastAPI(Py)。
//     只按"总键数 > 0"判非空会掩盖"其中一半根本没扫到"（本轮实测：正则漏吃 `env?.` 时 JS 侧命中为 0，
//     而总键数仍为 8 —— 半数扫描面失效却不判红）。
const sides = { py: new Set(), js: new Set() }
for (const [, locs] of reads) {
  for (const l of locs) {
    const file = l.split(":")[0] // 定位串是 `相对路径:行号`，必须先剥行号再判扩展名
    sides[file.endsWith(".py") ? "py" : "js"].add(file)
  }
}
check(`双端扫描面各自非空（Py ${sides.py.size} 文件 / JS ${sides.js.size} 文件）`,
  sides.py.size > 0 && sides.js.size > 0, `py=${sides.py.size} js=${sides.js.size}`)

// 2) 代码读的键必须全部有文档。分两面判：应用面（会进 .env 的）与工具面（由 CI 提供的）。
//    应用面一律要求 .env.example；工具面允许"由工作流显式提供"，但键名必须真出现在工作流里——
//    这样"生产代码偷偷去读 CI 令牌"仍然判红（它落在应用面，只能走 .env.example）。
const appUndoc = [...reads.keys()].filter((k) => keySides.get(k).has("app") && !documented.has(k))
check("应用面读取的环境变量全部登记在 .env.example", appUndoc.length === 0,
  `漏登记 ${appUndoc.map((k) => `${k}@${reads.get(k)[0]}`).join(", ")}`)
const toolUndoc = [...reads.keys()].filter((k) => !keySides.get(k).has("app") && !documented.has(k) && !ciDeclared.has(k))
check("工具链侧读取的键须入 .env.example 或由工作流提供", toolUndoc.length === 0,
  `两面都没有 ${toolUndoc.map((k) => `${k}@${reads.get(k)[0]}`).join(", ")}`)
// CI 声明面的下限按**结构**取，不拍数字：目录可读 + 至少解析出一个键。
// （写死 ">=3" 会在别人删秘密时变假红；写死某个键名又会被"别处还引用着它"掩盖——真正的咬合力
//   来自上面那条"工具面的键必须两面之一有声明"，本条只保证扫描面没有塌成空集。）
check(`CI 声明面真解析（读到 ${[...ciDeclared].sort().join(", ") || "无"}）`,
  ciDeclared.size >= 1 && toolFiles.length >= 5,
  `ciDeclared=${ciDeclared.size} toolFiles=${toolFiles.length}`)

// 3) 反向漂移：文档里声明了但代码从不读的键，是假配置（会误导使用者去填一个无效项）
const orphan = [...documented.keys()].filter((k) => !reads.has(k))
check("无孤儿配置项（.env.example 声明但代码不读）", orphan.length === 0,
  `孤儿 ${orphan.join(", ")}；注：确需保留的示例项须在本文件写明豁免理由并计入下限`)

// 4) 密钥类条目必须留空（防把真实 key 写进示例面）
const secretish = [...documented].filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/.test(k) && v !== "")
check("示例面密钥类条目一律留空", secretish.length === 0,
  `带值 ${secretish.map(([k, v]) => `${k}=${v.slice(0, 6)}…`).join(", ")}`)

if (!QUIET) console.log(`\n读取键(${reads.size}): ${[...reads.keys()].sort().join(", ")}`)
console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
