#!/usr/bin/env node
// 接线常驻守卫（wiring guard）——第一百零九轮改进2。
//
// 立判据的一手起因（现算证据，不是假设）：
//   `functions/lib/hybrid_rrf.js` 在 MODULES.md 在册、有 JSDoc、带自检说明，但**没有任何运行时路径 import 它**
//   （BFS 证据：从 functions/api/[[route]].js 与 functions/cds-services/* 三个入口出发的静态 import 闭包，
//   27 个 lib 模块里只有它不可达；rrfFuse 的权威实现住在 `retriever.js`，本件是零调用方的重复物）。
//   「在册」与「接线」从此不再是同一个词：MODULES.md 由 `gen_modules_manifest.py` 生成，它只认"文件存在"，
//   不认"运行时可达"⇒ 死代码可以在册、有文档、有说明，然后陪着整个仓一起变老。
//
// 判据：对 `frontend/functions` 的静态 import 图做闭包可达性扫描——
//   每个 `lib/*.js` 必须满足之一，否则 ORPHAN 判红：
//   ① 从某个运行时入口（Pages 文件路由的 api/*、cds-services/*、middleware）可达；
//   ② 自身就是运行时入口（文件路由按文件名即端点，不算孤儿）；
//   ③ 被声明在 ENTRY_EXEMPT 名单（显式豁免＝治理动作，须写明理由与复验日期，不是无限期白名单）。
//
// 为什么静态 import 就够（射程诚实声明）：本仓 Functions 层**没有**动态 `import()`／`require()` 拼路径的用法
//   （本守卫一并扫描并禁止这种形态——它们会让静态图失真）。守卫对每个 lib 文件**额外直查引用名**
//   （export 名在非 import 文件中出现即算被引），治"导入形漏抓"；两把尺都过才算零接线。
//
// 用法：node tests/wiring_guard.mjs [--selftest]
// 退出码：0 无孤儿｜1 有孤儿/判据失效｜2 取数面坏（图空、入口空）
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const FE = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const FUNC = join(FE, "functions")

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")) }
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(e.name)) continue
    const p = join(dir, e.name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (e.name.endsWith(".js")) acc.push(p)
  }
  return acc
}

/** 抓静态 import/export-from 的相对路径说明符。 */
export function staticImports(src) {
  const out = []
  const re = /(?:^|[^\w$.])(?:import|export)\s[\s\S]*?from\s*["']([^"']+)["']/g
  for (const m of src.matchAll(re)) out.push(m[1])
  const bare = /(?:^|[^\w$.])import\s*["']([^"']+)["']/g
  for (const m of src.matchAll(bare)) out.push(m[1])
  return out
}

/** 抓动态 import 与 require：在 Functions 运行时里两者都会让静态图失真 ⇒ 出现即违例。 */
export function dynamicLoaderSpecs(src) {
  const out = []
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const m of src.matchAll(/require\s*\(\s*["']([^"']+)["']/g)) out.push(m[1])
  return out
}

/** 导出名单（export function/const/class/let + export { a, b }）。 */
export function exportNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1].split(",")) {
    const n = part.trim().split(/\s+as\s+/).pop().trim()
    if (n) names.add(n)
  }
  return names
}

/** 纯判据体：files = [{rel, src}]，返回 {orphans, violations, entriesCount, libsCount}。 */
export function verdict(files, exempt = []) {
  const graph = new Map()
  for (const f of files) graph.set(f.rel, f)
  const rels = [...graph.keys()]
  const entries = rels.filter((r) => /^functions\/(api|cds-services)\/[^/]+\.js$/.test(r) || /^functions\/middleware/.test(r))
  const libs = rels.filter((r) => /^functions\/lib\/[^/]+\.js$/.test(r))
  if (!rels.length) return { orphans: [], violations: ["GRAPH_EMPTY: functions/ 下没有 .js 文件 ⇒ 判据没有被测对象"], entriesCount: 0, libsCount: 0, reachable: new Set() }
  if (!entries.length) return { orphans: [], violations: ["ENTRIES_EMPTY: 没有运行时入口（api/、cds-services/ 都空）⇒ 可达性无从谈起"], entriesCount: 0, libsCount: libs.length, reachable: new Set() }
  // 静态 import 图
  const edges = new Map()
  for (const f of files) {
    const deps = []
    for (const spec of staticImports(f.src)) {
      if (!spec.startsWith(".")) continue
      const abs = resolve(dirname(join(FE, f.rel)), spec)
      deps.push(relative(FE, abs).replace(/\\/g, "/"))
    }
    edges.set(f.rel, deps)
  }
  // 动态加载形：让静态图失真的写法一律违例
  const violations = []
  for (const f of files) for (const spec of dynamicLoaderSpecs(f.src)) violations.push(`DYNAMIC_LOADER: ${f.rel} → ${spec}`)
  // BFS 可达闭包
  const reachable = new Set()
  const q = [...entries]
  while (q.length) {
    const cur = q.shift()
    if (reachable.has(cur)) continue
    reachable.add(cur)
    for (const d of edges.get(cur) || []) if (graph.has(d) && !reachable.has(d)) q.push(d)
  }
  // 第二把尺：导出名引用（把 import 形漏抓的引用面补上）。importersOf[name] = set(file)
  const importersOf = new Map()
  for (const f of files) for (const n of exportNames(f.src)) {
    if (!importersOf.has(n)) importersOf.set(n, new Set())
    importersOf.get(n).add(f.rel)
  }
  const exemptSet = new Set(exempt)
  const orphans = []
  for (const lib of libs) {
    if (reachable.has(lib)) continue
    if (exemptSet.has(lib)) continue
    const src = graph.get(lib).src
    const names = exportNames(src)
    // 在 functions/ 里（除自身）出现它的导出名 ⇒ 被引用（含无 import 的用法誊写，按接线算）
    let referenced = false
    for (const n of names) {
      for (const [rel2, f2] of graph) {
        if (rel2 === lib) continue
        if (rel2.startsWith("functions/lib/")) {
          // lib 之间也看 import 边，引用名只对非 lib 面看（防同名误伤太宽）
          continue
        }
        if (f2.src.includes(n)) { referenced = true; break }
      }
      if (referenced) break
    }
    if (!referenced) orphans.push(lib)
  }
  return { orphans, violations, entriesCount: entries.length, libsCount: libs.length, reachable }
}

// 显式豁免名单：入册必须带理由与复验日期（r109 起）。当前为空——hybrid_rrf.js 已在 r109 删除。
const ENTRY_EXEMPT = []

function selftest() {
  const f = (rel, src) => ({ rel, src })
  const cases = []
  const push = (n, ok) => cases.push([n, ok])
  const libOk = f("functions/lib/a.js", "export const A = 1\n")
  const entryOk = f("functions/api/[[route]].js", "import { A } from \"../lib/a.js\"\nexport const onRequest = () => {}\n")
  push("正例-被入口 import 的 lib 不判孤儿", verdict([libOk, entryOk]).orphans.length === 0)
  push("反例腿-零引用 lib 判孤儿", verdict([f("functions/lib/dead.js", "export const D = 1\n"), entryOk]).orphans.includes("functions/lib/dead.js"))
  push("正例-入口自身不算孤儿（文件路由按文件名即端点）", !verdict([f("functions/cds-services/index.js", "export const onRequest = () => {}\n")]).orphans.length)
  push("反例腿-lib 之间互相 import 但无入口 ⇒ 判 ENTRIES_EMPTY（无入口=全死，且不许静默记绿）",
    verdict([f("functions/lib/a.js", "import { B } from \"./b.js\"\nexport const A = 1\n"), f("functions/lib/b.js", "export const B = 1\n")]).violations.some((v) => v.startsWith("ENTRIES_EMPTY")))
  push("反例腿-动态 import() 判违例（静态图会失真）",
    verdict([entryOk, f("functions/lib/x.js", "export const X = 1\n"), f("functions/api/[[route]].js", entryOk.src + "const p = import(\"../lib/x.js\")\n")]).violations.length > 0)
  push("正例-豁免名单生效", verdict([f("functions/lib/dead.js", "export const D = 1\n"), entryOk], ["functions/lib/dead.js"]).orphans.length === 0)
  push("反例腿-空图判 GRAPH_EMPTY", verdict([]).violations.some((v) => v.startsWith("GRAPH_EMPTY")))
  push("反例腿-有 lib 无入口判 ENTRIES_EMPTY", verdict([libOk]).violations.some((v) => v.startsWith("ENTRIES_EMPTY")))
  push("正例-导出名被非 lib 面引用（无 import）不算孤儿",
    verdict([f("functions/lib/a.js", "export const A = 1\n"), f("functions/api/[[route]].js", "const x = { A }\nexport const onRequest = () => {}\n")]).orphans.length === 0)
  let bad = 0
  for (const [n, ok] of cases) { console.log(`${ok ? "  pass" : "  FAIL"}  ${n}`); if (!ok) bad++ }
  console.log(`WIRING SELFTEST: ${bad === 0 ? "PASS" : `FAIL(${bad})`}（${cases.length} 例，含 ${cases.filter(([n]) => n.startsWith("反例腿")).length} 条反例腿）｜rc=${bad === 0 ? 0 : 1}`)
  process.exit(bad === 0 ? 0 : 1)
}

if (process.argv.includes("--selftest")) selftest()
else {
  const files = walk(FUNC).map((p) => ({ rel: relative(FE, p).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }))
  const v = verdict(files, ENTRY_EXEMPT)
  check(`运行时图非空（${v.entriesCount} 入口 / ${v.libsCount} lib 模块）`, v.entriesCount > 0 && v.libsCount > 0, "图空＝判据失效")
  check("零动态加载形（import()/require() 会让静态图失真）", v.violations.length === 0, v.violations.slice(0, 4).join(" | "))
  check(`lib 模块全部运行时可达（${v.libsCount - v.orphans.length}/${v.libsCount}）`, v.orphans.length === 0,
    "孤儿: " + v.orphans.join(", ") + " ⇒ 要么接线、要么入豁免名单（写理由+复验日期）、要么删")
  const verdictLine = `[GATE:wiring:${fail === 0 ? "pass" : "fail"}] matched=${pass} mismatched=${fail}｜entries=${v.entriesCount} libs=${v.libsCount}｜rc=${fail === 0 ? 0 : 1}`
  console.log(verdictLine)
  process.exit(fail === 0 ? 0 : 1)
}
