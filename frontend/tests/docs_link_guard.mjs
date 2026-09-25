// 文档内引用完整性守卫（v1.19.0 第二十一轮）。
// 为什么存在：本仓文档大量以「路径 + 判据文件名」互为凭据（`docs/PITFALLS.md` 每条都写着"常驻判据是谁"）。
// 这类引用一旦改名/挪目录就成死链，而 link_health.mjs 只管**外网 URL**、openapi 只管契约——
// 文档指向仓内文件这条面此前无人守（实测：改名 scripts/ 下任一脚本文档全绿）。
// 判据方向：既拦"引用不存在的文件"（假凭据），也拦"扫描面为空"（防"没扫到＝通过"的假绿）。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

// 扫描面**枚举**而不是手列文件清单：新增 md 文档自动进射程（同 error_parity 从抽样改枚举积的口径）。
// 排除：node_modules / archive / dist（历史归档与产物不做现状核）。
const SKIP_DIRS = new Set(["node_modules", "archive", "dist", ".wrangler", "sbom"])
const walkMd = (rel) => {
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return []
  const out = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...walkMd(`${rel}/${e.name}`))
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(rel ? `${rel}/${e.name}` : e.name)
    }
  }
  return out
}
const mdFiles = [...walkMd(""), ...walkMd("docs")].filter((f, i, arr) => arr.indexOf(f) === i).sort()
check(`扫描面非空（md 文件 ≥ 8，实测 ${mdFiles.length}）`, mdFiles.length >= 8, "读不到文档＝守卫失效")
check("关键文档在射程内（README/CONTRIBUTING/SECURITY/CHANGELOG/PITFALLS 缺一即红）",
  ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "docs/PITFALLS.md"].every((f) => mdFiles.includes(f)),
  mdFiles.join(", "))

// 锚点 slug 按 GitHub 规则近似：小写、去标点（保留 CJK/字母/数字/-/空格）、空格转 -
const slug = (s) => s.trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
  .replace(/ /g, "-")
const headingsOf = (text) => new Set(text.split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l)).map((l) => slug(l.replace(/^#+\s*/, ""))))

const MD_CACHE = new Map()
const mdOf = (rel) => {
  if (!MD_CACHE.has(rel)) MD_CACHE.set(rel, readFileSync(resolve(ROOT, rel), "utf8"))
  return MD_CACHE.get(rel)
}

let linkTotal = 0
let pathTotal = 0
const deadLinks = []
const deadPaths = []

// 引用面 1：markdown 链接的**仓内**目标与锚点
const LINK_RE = /\]\((?!https?:|mailto:)([^)\s]+)\)/g
// 引用面 2：反引号里的仓内路径（只认这四个顶层目录开头，避免把 `docker run ...` 之类命令当路径）
const PATH_RE = /`((?:scripts|backend|frontend|docs|\.github|tests)\/[\w./-]+?)(?::\d+)?`/g

// `tests/xxx` 这类写法在文档里指 frontend/tests/xxx（相对前端套件目录的习惯写法）
const resolveRepoPath = (p) => {
  const direct = resolve(ROOT, p)
  if (existsSync(direct)) return direct
  if (p.startsWith("tests/")) {
    const alt = resolve(ROOT, "frontend", p)
    if (existsSync(alt)) return alt
  }
  return direct
}

const HISTORY_FILES = new Set(["CHANGELOG.md"])  // 历史叙述不做现状核，见上
for (const file of mdFiles) {
  const text = mdOf(file)
  for (const m of text.matchAll(LINK_RE)) {
    linkTotal++
    const raw = m[1]
    const [target, anchor] = raw.split("#")
    const abs = resolve(ROOT, dirname(file), target || dirname(file))
    if (target && !existsSync(abs)) { deadLinks.push(`${file} → ${raw}（文件不存在）`); continue }
    if (anchor) {
      const host = target ? relative(ROOT, abs).replace(/\\/g, "/") : file
      if (host.endsWith(".md") && existsSync(resolve(ROOT, host))) {
        if (!headingsOf(mdOf(host)).has(slug(anchor))) deadLinks.push(`${file} → ${raw}（锚点不存在于 ${host}）`)
      }
    }
  }
  if (HISTORY_FILES.has(file)) continue
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1]
    pathTotal++
    if (p.includes("*") || p.endsWith("/")) continue  // 通配与目录前缀写法不做强判定
    if (!existsSync(resolveRepoPath(p))) deadPaths.push(`${file} → ${p}`)
  }
}

check(`markdown 仓内链接扫描非空（实测 ${linkTotal} 条）`, linkTotal >= 5, "一条都没扫到＝正则失效")
check(`反引号路径引用扫描非空（实测 ${pathTotal} 处）`, pathTotal >= 40, "扫描面过窄＝形同没扫")
check("零死链（markdown 目标与锚点都存在）", deadLinks.length === 0, deadLinks.slice(0, 6).join(" | "))
check("零假凭据（反引号里的仓内路径都真实存在）", deadPaths.length === 0, deadPaths.slice(0, 8).join(" | "))

// PITFALLS 的自证要求：每条"常驻判据"必须点名一个真实存在的文件（否则固化=空话）
const pitfalls = mdOf("docs/PITFALLS.md")
const judgeLines = pitfalls.split(/\r?\n/).filter((l) => /常驻判据|判据：/.test(l))
check(`PITFALLS 每条都写了常驻判据（实测 ${judgeLines.length} 条）`, judgeLines.length >= 12,
  "有坑没写判据＝该坑还会复发")
const citedFiles = [...pitfalls.matchAll(PATH_RE)].map((m) => m[1])
check(`被点名的判据文件全部存在（扫到 ${citedFiles.length} 个）`,
  citedFiles.length >= 12 && citedFiles.every((f) => existsSync(resolveRepoPath(f))),
  citedFiles.filter((f) => !existsSync(resolveRepoPath(f))).join(", "))

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
