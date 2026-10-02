// 文档内引用完整性守卫（v1.19.0 第二十一轮）。
// 为什么存在：本仓文档大量以「路径 + 判据文件名」互为凭据（`docs/PITFALLS.md` 每条都写着"常驻判据是谁"）。
// 这类引用一旦改名/挪目录就成死链，而 link_health.mjs 只管**外网 URL**、openapi 只管契约——
// 文档指向仓内文件这条面此前无人守（实测：改名 scripts/ 下任一脚本文档全绿）。
// 判据方向：既拦"引用不存在的文件"（假凭据），也拦"扫描面为空"（防"没扫到＝通过"的假绿）。
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { dirname, resolve, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB, SYNONYMS } from "../functions/lib/knowledge.js"

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
  ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "docs/PITFALLS.md", "AGENTS.md"].every((f) => mdFiles.includes(f)),
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

// 引用面 3：以 `../` 起头的仓外凭据。为什么单独一条判据（第二十四轮）：
// PATH_RE 只认四个顶层目录开头，`../iCAN…/live_eval.mjs` 这类写法**根本不在射程内**；
// 而本机 clone 出来的仓外面恰好还摆着参赛工作区，existsSync 为真 ⇒ 「零假凭据」照样判绿。
// 对评审/协作者而言交付物只有这个仓，仓外路径等于死链——只是在我这台机器上暂时不发作。
// 只认「指向仓外某个具体对象」的写法；文档里以反引号单举 `../` 说明坑本身（PITFALLS §H、README 说明行）
// 不是凭据引用，不该被判红。**注意**：这里刻意不用 [\w./-] 字符类——\w 是 ASCII-only，
// 而本仓真实要拦的那条路径是 `../iCAN大学生创新创业大赛/…`（中文目录名），首版因此恒绿、被变异实测打回。
const UP_RE = /`(\.\.[^`\n]*)`/g
const upRefs = []
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  const text = mdOf(file)
  for (const m of text.matchAll(UP_RE)) {
    const p = m[1]
    if (p === ".." || p === "../" || p === "../../") continue  // 讲坑本身的裸写法，不是路径凭据
    upRefs.push(`${file} → ${p}`)
  }
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1].split("#")[0]
    if (!target || /^(https?:|mailto:)/.test(target)) continue
    const abs = resolve(ROOT, dirname(file), target)
    // 逃出仓根的 markdown 链接同样算假凭据（本机可解析 ≠ 第三方可解析）
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) upRefs.push(`${file} → ](${target}) 链接逃出仓根`)
  }
}
check("文档不得以仓外路径作凭据（`../` 起头或链接逃出仓根即红）",
  upRefs.length === 0, upRefs.slice(0, 8).join(" | "))

// —— 上面这条自身的接线证明：扫描面为空 = 判据失效，不许"没扫到＝通过" ——
const backtickSpans = mdFiles.filter((f) => !HISTORY_FILES.has(f))
  .reduce((n, f) => n + (mdOf(f).match(/`[^`\n]+`/g) || []).length, 0)
check(`仓外路径判据确有输入（非 CHANGELOG 文档里反引号片段 ${backtickSpans} 处，≥200 才算扫到东西）`,
  backtickSpans >= 200, "反引号片段过少＝文档没读进来，该判据会恒绿")

// 文档里的「N 件套」「N 份工作流」必须是派生值（第二十五轮 #51）。
// 为什么：本轮我自己就手改了 4 处过期的「十五件套」（实际早已是十八/十九），上一轮也改过一次——
// 同一个数字抄在 N 份文档里，改实现的人不会记得逐处同步，这是**结构性的**漂移而不是笔误。
// 现在把真值收拢到两处：`package.json` 的 scripts.test 拆分数、`.github/workflows/*.yml` 枚举数；
// 文档里再出现别的数字即判红（并且反向断言扫描面非空，防"没扫到＝通过"）。
const pkg = JSON.parse(readFileSync(resolve(ROOT, "frontend", "package.json"), "utf8"))
const suiteCount = pkg.scripts.test.split("&&").length
const wfDir = resolve(ROOT, ".github", "workflows")
const wfCount = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith(".yml")).length : -1
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const toNum = (raw) => (/^\d+$/.test(raw) ? Number(raw)
  : (raw.length === 1 ? (CN[raw] ?? NaN)
    : raw.startsWith("十") ? 10 + (CN[raw.slice(1)] ?? 0)
      : raw.endsWith("十") ? (CN[raw.slice(0, -1)] ?? 0) * 10
        : /^([一二三四五六七八九])十([一二三四五六七八九])?$/.test(raw)
          ? Number(CN[raw.match(/^([一二三四五六七八九])/)[1]]) * 10 + (raw.endsWith("十") ? 0 : (CN[raw.slice(-1)] ?? 0))
          : NaN))
const docClaims = []
let countTotal = 0
// 第三个派生真值：知识库条目数。第二十七轮实测——扩库 5 条后 README/ARCHITECTURE/EVAL_CARD 各写各的条数，
// 手抄条数一旦进文档，评审按它核对仓库就会对不上；条数只准由 KNOWLEDGE_BASE 现算。
const KB_COUNT = KNOWLEDGE_BASE.length
const KB_RE = [/知识库[^\d\n]{0,6}(\d{1,4})\s*条/g, /(\d{1,4})\s*条(?:知识|知识库|条目|逐条)/g, /(\d{1,4})\s*条\s*\/\s*\d+\s*病种域/g]
let kbTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const m of mdOf(file).matchAll(/(\d+|[一二三四五六七八九十]{1,3})\s*件套/g)) {
    countTotal++
    const n = toNum(m[1])
    if (n !== suiteCount) docClaims.push(`${file} → "${m[0]}" 应为 ${suiteCount} 件套`)
  }
  for (const m of mdOf(file).matchAll(/(\d+|[一二三四五六七八九十]{1,3})\s*份(?:工作流|workflow)/g)) {
    countTotal++
    const n = toNum(m[1])
    if (n !== wfCount) docClaims.push(`${file} → "${m[0]}" 应为 ${wfCount} 份`)
  }
  const text = mdOf(file)
  for (const re of KB_RE) {
    for (const m of text.matchAll(re)) {
      kbTotal++
      if (Number(m[1]) !== KB_COUNT) docClaims.push(`${file} → "${m[0]}" 应为 ${KB_COUNT} 条`)
    }
  }
}
// 第七十五轮补的**第二面**：上面这个循环只覆盖本仓 docs/README，而「手抄条数」这一族的缺口
// 是按面漏的（#51 的原始结论就是"补一次不算完"）。一手实测：本仓这把尺此前已抓到过一次
// （PITFALLS 那条 55→60 就是它点名的），而父仓两份**注入面**——`../AGENTS.md` 04 节与
// `../memory/04-file-map.md`——旧写条数 55 而真值已 60，且父仓 freeze_check 的 29 检里
// 没有条数这把尺（本轮 freeze 29/29 全绿即为证）。这两面会被自动注入每一个新会话，过期读数直接进上下文。
// 干净检出里父仓不在场 ⇒ 声明为**可选面**：在场就纳入同一判据，不在场不冒充"已覆盖"（读数进 check 名）。
// 注：本注释块自身的写法也要避开 `N 条知识库` 形——源码面在射程内，第一版就是被这条判据判红的（自踩实录）。
const INJECT_FACES = ["../AGENTS.md", "../memory/04-file-map.md"]
  .map((p) => resolve(ROOT, p)).filter((p) => existsSync(p))
for (const p of INJECT_FACES) {
  const t = readFileSync(p, "utf8")
  for (const re of KB_RE) {
    for (const m of t.matchAll(re)) {
      kbTotal++
      if (Number(m[1]) !== KB_COUNT) docClaims.push(`${relative(ROOT, p).replace(/\\/g, "/")} → "${m[0]}" 应为 ${KB_COUNT} 条（父仓注入面）`)
    }
  }
}
// 第四~六族派生真值（第三十三轮 #51 的第一块落点）：知识库的另外三个计数。
// 触发实测：本轮把 `docs/ARCHITECTURE.md` 的「症状→证据映射 60 键」核出来是 73——
// 上一轮的 #91 只把**条数**扩了射程，同一段里的键数/组数/加权词数仍无人对账，
// 说明「手抄计数」这一族的缺口是按"名词"逐个漏的，不是补一次就完。
const KB_TALLIES = [
  [/症状\s*(?:→|至|到)\s*证据映射\s*(\d+)\s*键/g, Object.keys(SYMPTOM_TO_KB).length, "症状→证据映射键数"],
  [/同义词扩展[：:]?\s*(\d+)\s*组/g, Object.keys(SYNONYMS).length, "同义词组数"],
  [/红旗加权词\s*(\d+)\s*个/g, RED_FLAG_KEYWORDS.length, "红旗加权词数"],
]
const tallySeen = {}
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  const text = mdOf(file)
  for (const [re, truth, label] of KB_TALLIES) {
    for (const m of text.matchAll(re)) {
      tallySeen[label] = (tallySeen[label] || 0) + 1
      if (Number(m[1]) !== truth) docClaims.push(`${file} → "${m[0]}" 应为 ${truth}（${label}现算）`)
    }
  }
}
const tallyTruths = KB_TALLIES.map(([, t, label]) => `${label}=${t}`).join("、")
check(`文档中的知识库三个计数亦为派生真值（${tallyTruths}）`, docClaims.length === 0, docClaims.slice(0, 8).join(" | "))
check(`三个计数判据各自有输入（每族 ≥1 处，实测 ${KB_TALLIES.map(([, , label]) => `${label}:${tallySeen[label] || 0}`).join("、")}）`,
  KB_TALLIES.every(([, , label]) => (tallySeen[label] || 0) >= 1),
  "某族扫到 0 处＝该族正则失效或文档已不写这个数，两种都要点名而不是静默")

check(`文档中的套件数/工作流份数/知识库条数全部为派生真值（套件=${suiteCount}、工作流=${wfCount}、条目=${KB_COUNT}、父仓注入面在场 ${INJECT_FACES.length}/2）`,
  docClaims.length === 0, docClaims.slice(0, 8).join(" | "))
check(`该判据确有输入（扫到 ${countTotal} 处计数声明，≥3 才算在射程内）`, countTotal >= 3,

  "一处都没扫到＝正则失效，判红而不是跳过")

// 第七族派生真值（第三十七轮 #112）：pre-commit 钩数。
// 触发实测：本轮往 .pre-commit-config.yaml 加第 13 只钩，动手前四份文档已是**三个值**——
// AGENTS/CONTRIBUTING 写 12、PITFALLS 写「十二钩」、README 还停在「九钩子」（v1.21 前的数）。
// 同一个事实抄四处必然漂移，与 #51 立的同一族同一条根因；钩数只准由配置文件现算。
const HOOK_CFG = resolve(ROOT, ".pre-commit-config.yaml")
const hookCount = existsSync(HOOK_CFG)
  ? (readFileSync(HOOK_CFG, "utf8").match(/^\s*-\s+id:\s+/gm) || []).length : -1
const hookClaims = []
let hookTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const m of mdOf(file).matchAll(/(\d+|[一二三四五六七八九十]{1,3})\s*个?\s*钩(?:子)?/g)) {
    hookTotal++
    const n = toNum(m[1])
    if (n !== hookCount) hookClaims.push(`${file} → "${m[0]}" 应为 ${hookCount} 钩`)
  }
}
check(`文档中的 pre-commit 钩数为派生真值（钩=${hookCount}，现算自 .pre-commit-config.yaml）`,
  hookClaims.length === 0, hookClaims.slice(0, 8).join(" | "))
check(`钩数判据确有输入（扫到 ${hookTotal} 处钩数声明，≥2 才算在射程内）`, hookTotal >= 2,
  "扫到 0 处＝正则失效或文档已不写这个数，两种都要点名而不是静默")

// #91（第三十二轮）：同一条派生真值的**另一半射程**——源码注释里也会写条数。
// 第二十七轮只把 .md 纳进来，本轮实测 `frontend/functions/lib/data.js` 头部注释长期写着过期条数，
// 且顺手写死了当时的生成器文件名（该文件本轮已退役）——注释会烂，判据看不见就等于没判。
const GENERATED_FACES = new Set(["knowledge.js", "knowledge.py", "red_flag_rules.js", "red_flag_rules.py",
  "scope_rules.js", "scope_rules.py", "semantic_neighbors.js", "semantic_neighbors.json"])
const walkSrc = (rel) => {
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return []
  const out = []
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...walkSrc(`${rel}/${e.name}`))
    } else if (e.isFile() && /\.(js|mjs|jsx|py)$/.test(e.name) && !GENERATED_FACES.has(e.name)) {
      out.push(`${rel}/${e.name}`)
    }
  }
  return out
}
const srcFiles = [...walkSrc("frontend/functions"), ...walkSrc("frontend/src"), ...walkSrc("frontend/tests"),
  ...walkSrc("scripts"), ...walkSrc("backend/app"), ...walkSrc("backend/tests")]
check(`源码射程非空（扫 ${srcFiles.length} 个源文件，< 40 即射程塌陷＝判据看不见输入）`, srcFiles.length >= 40, srcFiles.slice(0, 6).join(","))
const srcClaims = []
let srcKbTotal = 0
let srcHistory = 0
// 历史叙述不做现状核（与 CHANGELOG 同一条理由）：本轮 3 处命中里「旧 30 条」「知识库曾有 16 条」是真历史，
// 只有 accuracy_guard 那句「自建 NN 条知识库」是过期现状声明（本轮已改为不写条数）。排除项**逐处计数并打印**，
// 免得这个判据变成"带关键字就能躲过"的静默放行——被排除的处数必须看得见。
const HISTORY_WORDS = /曾|此前|当年|旧\s*\d+\s*条|原为|已废弃|第\s*\d+\s*轮/
for (const rel of srcFiles) {
  let text = ""
  try {
    text = readFileSync(resolve(ROOT, rel), "utf8")
  } catch {
    continue
  }
  for (const line of text.split("\n")) {
    for (const re of KB_RE) {
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        if (HISTORY_WORDS.test(line)) {
          srcHistory++
          continue
        }
        srcKbTotal++
        if (Number(m[1]) !== KB_COUNT) srcClaims.push(`${rel} → "${m[0]}" 应为 ${KB_COUNT} 条`)
      }
    }
  }
}
check(`源码注释里的知识库条数声明亦为派生真值（现状声明 ${srcKbTotal} 处，另有 ${srcHistory} 处按历史叙述排除）`, srcClaims.length === 0, srcClaims.slice(0, 6).join(" | "))
// 恒真防护：不依赖"恰好有人写错过"——直接喂对/错两个数给同一组正则，错的必须被识破。
const probeOk = KB_RE.some((re) => { re.lastIndex = 0; return re.test(`知识库 ${KB_COUNT} 条`) })
const probeBad = KB_RE.some((re) => { re.lastIndex = 0; return re.test(`知识库 ${KB_COUNT + 1} 条`) })
const probeNamed = probeBad && ![...KB_RE].some((re) => {
  re.lastIndex = 0
  const m = `知识库 ${KB_COUNT + 1} 条`.match(re)
  return m && Number(m[1]) === KB_COUNT
})
check("条数正则非恒真（对数与错数都能被解析，且错数会被判为不等）", probeOk && probeNamed,
  `ok=${probeOk} named=${probeNamed}`)
check(`知识库条数判据有输入（扫到 ${kbTotal} 处条数声明，≥3 才算在射程内）`, kbTotal >= 3,
  "扫到 0 处＝KB_RE 失效或文档已不写条数，两种都要点名而不是静默")

// EVAL_CARD 第 4 节「病种覆盖清单」逐域逐条与知识库对账（第二十七轮 #53 扩库后新增）。
// 为什么：这一节此前手抄 55 条·19 域，扩库当天就会变成"评审按它核对仓库对不上"的假清单；
// 光对账条数不够——条目改名、挪域、漏列都看不见，所以按 (域 → 诊断名集合) 做全等比对。
const covBad = []
{
  const card = "docs/EVAL_CARD.md"
  const text = existsSync(resolve(ROOT, card)) ? mdOf(card) : ""
  const sec = text.split(/^## /m).find((b) => b.startsWith("4. 病种覆盖清单")) || ""
  const declared = new Map()
  for (const m of sec.matchAll(/([^\s（｜]+)（(\d+)）：([^\n｜]+)/g)) {
    for (const name of m[3].split("、")) declared.set(name.trim(), m[1])
    if (Number(m[2]) !== m[3].split("、").length) covBad.push(`${card} ${m[1]} 声明 ${m[2]} 条但列举 ${m[3].split("、").length} 条`)
  }
  const actual = new Map()
  for (const k of KNOWLEDGE_BASE) actual.set(k.condition, String(k.scope).split("/")[0].trim())
  if (declared.size === 0) covBad.push(`${card} 第 4 节一条都没解析出来＝判据失效，不许记绿`)
  for (const [name, dom] of actual) {
    if (!declared.has(name)) covBad.push(`库内有「${name}」但清单未列`)
    else if (declared.get(name) !== dom) covBad.push(`「${name}」清单记在 ${declared.get(name)}，库内 scope 为 ${dom}`)
  }
  for (const name of declared.keys()) if (!actual.has(name)) covBad.push(`清单有「${name}」但库内已无此条`)
}
check("EVAL_CARD 病种覆盖清单与知识库逐条逐域全等（防手抄清单漂移）",
  covBad.length === 0, covBad.slice(0, 6).join(" | "))

// 行号引用对账：文档写 `engine.js:173` 时，第 173 行必须真的还在讲它声称的那个标识符。
// 为什么本轮加：改 engine.js 让 ARCHITECTURE 链路图里三处行号全部漂移到别的函数上，
// 而既有判据只核"文件存在"、不核"行号指向的内容"——即"路径真、内容假"的凭据（本轮实测自纠）。
const lineBad = []
let lineTotal = 0
// 实测形状：链路图里的引用是**裸文本** `engine.js:48`（在代码围栏内），不是反引号包裹，
// 所以这里按"裸 file.ext:行号"匹配；改成只匹配反引号会扫到 0 处并假通过（本轮实测踩到，靠零输入守卫抓住）。
const CITE_RE = /([\w./-]+\.(?:js|py|mjs|jsx|json|ts|tsx))[:：](\d{1,5})/g
// 文档常只写文件名（engine.js），真身在 functions/lib/ 或 src/views/ 下 ⇒ 先按 basename 建索引，
// 而不是猜固定路径（猜路径就是刚才扫到 0 处的根因）。
const SRC_DIRS = ["frontend/functions", "frontend/src", "frontend/tests", "backend/app", "scripts", ".github"]
const BY_BASENAME = new Map()
const walk = (rel) => {
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs)) return
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue
    const child = `${rel}/${e.name}`
    if (e.isDirectory()) walk(child)
    else if (!BY_BASENAME.has(e.name)) BY_BASENAME.set(e.name, child)
  }
}
for (const d of SRC_DIRS) walk(d)
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  const text = mdOf(file)
  for (const m of text.matchAll(CITE_RE)) {
    const rel = m[1].replace(/^\.?\//, "")
    const lineNo = Number(m[2])
    const abs = resolve(ROOT, existsSync(resolve(ROOT, rel)) ? rel
      : (BY_BASENAME.get(rel.split("/").pop()) || "__no_such_file__"))
    if (!existsSync(abs)) continue // 定位不到交给"假凭据"判据点名
    lineTotal++
    const lines = readFileSync(abs, "utf8").split(/\r?\n/)
    if (lineNo < 1 || lineNo > lines.length) {
      lineBad.push(`${file} → ${m[0]} 越界（${rel} 只有 ${lines.length} 行）`)
      continue
    }
    // 声称的标识符：引用前后 60 字里出现的驼峰/下划线函数名
    const ctx = text.slice(Math.max(0, m.index - 60), m.index + 60)
    const named = [...ctx.matchAll(/\b([A-Za-z_$][\w$]{3,})\b/g)].map((x) => x[1])
      .filter((n) => !["http", "https", "com", "www", "docs", "src", "lib", "test", "tests", "engine", "rag", "py", "js", "mjs"].includes(n))
    if (!named.length) continue // 没声称具体符号 ⇒ 只核不越界
    const window = lines.slice(Math.max(0, lineNo - 4), lineNo + 3).join("\n")
    if (!named.some((n) => window.includes(n))) {
      lineBad.push(`${file} → ${m[0]} 第 ${lineNo}±3 行不含所声称的 ${named.slice(0, 3).join("/")}（行号已漂移）`)
    }
  }
}
check("文档里的 `文件:行号` 引用其行确实指向所声称的符号（防行号漂移假凭据）",
  lineBad.length === 0, lineBad.slice(0, 6).join(" | "))
check(`行号引用判据有输入（扫到 ${lineTotal} 处 ` + "`文件:行号`" + "，≥3 才算在射程内）", lineTotal >= 3,
  "扫到 0 处＝正则失效或文档不再引用行号，两种都要点名而不是静默")

// 「N 段链路」也是派生值：本轮加第⑦步（弃权）后 README/ARCHITECTURE 仍写着"六段"，
// 与上面的套件数/条数同族——同一个事实抄在几份文档里，就必须有一个人人都过的真值源。
const archText = existsSync(resolve(ROOT, "docs", "ARCHITECTURE.md")) ? mdOf("docs/ARCHITECTURE.md") : ""
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩"
const chainSteps = new Set([...archText].filter((c) => CIRCLED.includes(c))).size
const chainBad = []
let chainTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const m of mdOf(file).matchAll(/(\d+|[一二三四五六七八九十]{1,3})\s*段(?:链路|流程)/g)) {
    chainTotal++
    const n = toNum(m[1])
    if (n !== chainSteps) chainBad.push(`${file} → "${m[0]}" 应为 ${chainSteps} 段（ARCHITECTURE 图内 ①..${CIRCLED[chainSteps - 1]} 实测）`)
  }
}
check(`文档里的「N 段链路」== ARCHITECTURE 图内实际步数（实测 ${chainSteps} 段）`,
  chainBad.length === 0, chainBad.slice(0, 5).join(" | "))
check(`链路步数判据有输入（扫到 ${chainTotal} 处「N 段」声明，≥2 才算在射程内）`, chainTotal >= 2 && chainSteps >= 5,
  `扫到 ${chainTotal} 处、图内 ${chainSteps} 步——任一为 0 即判据失效，不许静默通过`)

// 判据 18：复现命令行不得把覆盖率读数抄成第二真值
// 为什么存在：EVAL_CARD 复现区把 `coverage:py` 写成「实测 90.53%，地板 88」，而 fixture 里的全局
// 地板自 v1.19 起是 90、本轮实测 94.65% —— 该命令每次运行都会打印真值，文档抄一份只会随实现过期
// （实测 v1.13→v1.26 期间这两个数字从未被同步过，也没有任何判据能看见它）。
// 射程刻意只取**命令行**（`cd`/`node`/`npm`/`python` 起头）：带日期的度量叙述（EVAL_CARD 度量表、
// ARCHITECTURE 门禁表）是「当时为真」的历史陈述，与本判据无冲突——首版按「含 coverage: 的整行」扫，
// 一上来就把那两类也判红，属误伤，故收窄。
const CMD_LINE_RE = /^\s*(?:cd\s+\S+\s+&&\s*)?(?:node|npm|npx|python|bash|docker)\b/
const covLines = []
let covTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const line of mdOf(file).split(/\r?\n/)) {
    if (!/coverage:(js|py)\b/.test(line) || !CMD_LINE_RE.test(line)) continue
    covTotal++
    const pct = line.match(/\d+(?:\.\d+)?\s*%/)
    if (pct) covLines.push(`${file} → 命令注释里抄了读数「${pct[0].trim()}」（真值由该命令自己打印，地板源是 fixture）`)
  }
}
check("复现命令行未把覆盖率读数抄成第二真值（数字唯一源 = 实跑输出 + coverage_floor.json）",
  covLines.length === 0, covLines.slice(0, 5).join(" | "))
check(`覆盖率命令行判据有输入（扫到 ${covTotal} 处，≥3 才算在射程内）`, covTotal >= 3,
  "扫到 0 处＝命令行从文档里消失了或正则失效，判据同样失效，不许静默通过")

// ─────────────────────────────────────────────────────────────────────────────
// 第八族（2026-10-02 对标 r85，台账 #213）：**行为承诺**也是第二真值。
// 前七族管的是"计数/路径/版本/条数"，全都管不到这样一句话——「X 至多重试一次」「`Y=z` 可切」——
// 它描述的是一个**根本不存在的机制**。一手实测两处：
//   ① `docs/KNOWLEDGE_MAINTENANCE.md` §3 写「timeout／net_error 至多重试一次」并自称"逐行对得上该实现"，
//      而 `engine.js` 全文只有 **1** 个 `fetch` 调用点（现算 grep），无重试环、无熔断；
//   ② `docs/EVAL_CARD.md` 写「`RETRIEVER=semantic` 可切，默认 bm25」，而双端引擎都是无参取检索器，
//      全仓没有任何读取 `RETRIEVER` 的代码，`env_guard` 的声明面里也没有这一项。
// 两处都由"补文档的那一轮"自己写进去的，且当时全套守卫全绿 ⇒ 说明这一类根本不在射程内，不是笔误。
// 治法：① 文档只能承诺代码里在场的能力位（按数据流划取数面）；② 行为承诺必须带机器可解析的**回执锚点**
// `〔回执：<仓根相对路径>::<该文件里真实存在的标识>〕`，指向不存在的实现即红；③④ 顺带把 README 的
// 标题版本位与 `kb_gap` 手抄条数纳入同一纪律。每条判据都配在场反例（真实历史句）与合规样例，
// 防"扫到 0 处＝通过"的恒绿。
// ─────────────────────────────────────────────────────────────────────────────

// 声明面：环境变量类能力位的唯一来源（.env.example ∪ config.py 的 getenv ∪ engine.js 的 process.env）
const declSources = [
  ["backend/.env.example", (t) => t.match(/^[A-Z][A-Z0-9_]{2,}/gm) || []],
  ["backend/app/config.py", (t) => t.match(/getenv\("[A-Z0-9_]+"/g) || []],
  ["frontend/functions/lib/engine.js", (t) => t.match(/process\.env\.[A-Z0-9_]+/g) || []],
]
const ENV_DECL_FACE = new Set()
for (const [rel, pick] of declSources) {
  const p = resolve(ROOT, rel)
  if (!existsSync(p)) continue
  for (const raw of pick(readFileSync(p, "utf8"))) {
    const name = (raw.match(/[A-Z][A-Z0-9_]{2,}/) || [])[0]
    if (name) ENV_DECL_FACE.add(name)
  }
}
const SWITCH_VERB = /可切|切换|设为|改成|改为|开关|启用/
// 纯函数：喂入 [{file, line}]，返回违规串。抽出来是为了能拿历史句子当面打反例。
function envSwitchViolations(rows, face) {
  const out = []
  for (const { file, line } of rows) {
    if (!SWITCH_VERB.test(line)) continue
    const names = new Set()
    for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,})=[^`\s]*`/g)) names.add(m[1])
    for (const m of line.matchAll(/`([A-Z][A-Z0-9_]{2,})`\s*[*]*\s*(?:可切|可配置|切换)/g)) names.add(m[1])
    for (const n of names) out.push(`${file} → 宣称 ${n} 是可切换的能力位，但声明面（${declSources.map(([r]) => r).join("／")}）现算 ${face.size} 项里没有 ${n}`)
  }
  return out
}
const switchRows = []
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const line of mdOf(file).split(/\r?\n/)) switchRows.push({ file, line })
}
const switchHits = envSwitchViolations(switchRows, ENV_DECL_FACE)
check(`文档点名的能力开关必须在声明面在场（声明面现算 ${ENV_DECL_FACE.size} 项，耐久面扫到 ${switchRows.length} 行）`,
  switchHits.length === 0, switchHits.slice(0, 5).join(" | "))
check("反例·能力位判据四向都动得了（两种谎形被抓＋合规句与辟谣句不误伤）", (() => {
  const v = (line) => envSwitchViolations([{ file: "t", line }], ENV_DECL_FACE).length
  return v("**未启用**（`RETRIEVER=semantic` 可切，默认 bm25）") === 1
    && v("**未启用**（`RETRIEVER` 可切换，默认 bm25）") === 1
    && v("档位只在评测 CLI 里按 `--retriever` 选，运行期没有档位开关，链路固定 bm25") === 0
    && v("本行原先写的环境变量开关经实测并不存在；不存在读取 `RETRIEVER` 的代码") === 0
})(), "漏抓＝判据是装饰；误伤辟谣句＝逼人把更正从文档里删掉（判据拒真话即判据缺陷）")

// 回执锚点：〔回执：path::identifier〕——path 可从仓根解析，identifier 必须真在该文件里
const ANCHOR_RE = /〔回执：([^：\s]+)::([^〕]+)〕/g
const anchorViolations = []
let anchorTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const m of mdOf(file).matchAll(ANCHOR_RE)) {
    anchorTotal++
    const path = m[1].trim()
    const symbol = m[2].trim()
    const p = resolve(ROOT, path)
    if (!existsSync(p)) { anchorViolations.push(`${file} → 回执指向不存在的文件 ${path}`); continue }
    if (!readFileSync(p, "utf8").includes(symbol)) anchorViolations.push(`${file} → 回执标识 ${path}::${symbol} 在被指文件里找不到（承诺无源）`)
  }
}
check(`行为承诺的回执锚点全部可解析（扫到 ${anchorTotal} 处，≥3 才算在射程内）`,
  anchorViolations.length === 0 && anchorTotal >= 3, anchorViolations.slice(0, 5).join(" | ") || `在场 ${anchorTotal} 处`)
check("反例·回执锚点两向都动得了（假路径被抓＋假标识被抓＋真锚点不误伤）", (() => {
  const probe = (path, symbol) => !(existsSync(resolve(ROOT, path)) && readFileSync(resolve(ROOT, path), "utf8").includes(symbol))
  return probe("frontend/tests/nope_guard.mjs", "x") && probe("frontend/tests/live_path_guard.mjs", "这句话代码里没有") && !probe("frontend/tests/live_path_guard.mjs", "单次调用零重试")
})(), "假锚点漏抓＝这条腿是装饰")

// README 标题版本位：标题里抄版本号＝第二个真值（version_guard 五方不含 README，实测它停在 v0.3）
const APP_VERSION = ((readFileSync(resolve(ROOT, "frontend/functions/lib/version.js"), "utf8").match(/APP_VERSION\s*=\s*"([^"]+)"/) || [])[1]) || ""
const titleLine = (mdOf("README.md").split(/\r?\n/)[0] || "")
const titleVersion = (titleLine.match(/\bv(\d+(?:\.\d+)*)\b/i) || [])[1] || ""
check(`README 标题行不带版本号（唯一源 version.js::APP_VERSION=${APP_VERSION || "读不到"}；标题实测「${titleLine.slice(0, 28)}」）`,
  titleVersion === "" || titleVersion === APP_VERSION, `标题写着 v${titleVersion}，而发布版本是 ${APP_VERSION}——差 ${titleVersion ? "若干" : "？"} 个小版本且没人对账`)
check("反例·标题版本位判据抓得住 v9.9.9", /^\s*#\s.*\bv\d/i.test("# 医 · 某系统 — v9.9.9") && !/^\s*#\s.*\bv\d/i.test(titleLine),
  "抓不到注入版本号的写法＝这条判据对未来的漂移无防")

// kb_gap 手抄条数：真值 = fixture 里 kb_gap 为真的例数
const GOLD = JSON.parse(readFileSync(resolve(ROOT, "frontend/tests/fixtures/dx_gold.json"), "utf8"))
const goldCases = Array.isArray(GOLD) ? GOLD : (GOLD.cases || [])
const KB_GAP_TRUTH = goldCases.filter((c) => c && c.kb_gap).length
const kbGapClaims = []
let kbGapTotal = 0
for (const file of mdFiles) {
  if (HISTORY_FILES.has(file)) continue
  for (const line of mdOf(file).split(/\r?\n/)) {
    if (!line.includes("kb_gap")) continue
    for (const m of line.matchAll(/（现\s*(\d+)\s*条/g)) {
      kbGapTotal++
      if (Number(m[1]) !== KB_GAP_TRUTH) kbGapClaims.push(`${file} → "${m[0]}）" 应为 ${KB_GAP_TRUTH} 条（fixture 现算，共 ${goldCases.length} 例）`)
    }
  }
}
check(`kb_gap 缺口条数为派生真值（现算 ${KB_GAP_TRUTH} 条，扫到 ${kbGapTotal} 处声明）`,
  kbGapClaims.length === 0 && kbGapTotal >= 1, kbGapClaims.slice(0, 4).join(" | ") || "扫到 0 处＝文档已不写这个数或正则失效，两种都要点名")
check("反例·kb_gap 判据对旧数敏感（truth=0 时「现 5 条」必须被抓）",
  (5 !== KB_GAP_TRUTH) && (KB_GAP_TRUTH === 0 ? true : KB_GAP_TRUTH !== 5), `fixture 真值=${KB_GAP_TRUTH}`)

console.log(`\nRESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
