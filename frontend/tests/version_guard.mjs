// 版本真值守卫：五处版本声明必须同值（round7 实测抓到 0.2.0/1.5.0/v1.5.0 三处漂移后固化）。
// 口径：git 最新 SemVer tag 是发布事实源；未到 tag 的升版提交以 package.json 为准，其余五处必须与它一致。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
const SEMVER = /^\d+\.\d+\.\d+$/

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const pkg = JSON.parse(read("../package.json")).version
const fe = (read("../functions/lib/version.js").match(/APP_VERSION = "([^"]+)"/) || [])[1] || "<缺失>"
const be = (read("../../backend/app/version.py").match(/APP_VERSION = "([^"]+)"/) || [])[1] || "<缺失>"
const oa = JSON.parse(read("../../docs/openapi.json")).info.version
// package-lock 根上的 version 是第五份副本，第三十二轮实测它停在 v1.23.2（差 6 个 tag 没人动过）：
// npm install --package-lock-only 只改这两行，所以它必须进对账而不是靠人记得跑。
const lock = JSON.parse(read("../package-lock.json")).version

console.log("== 五处声明同值 ==")
check(`package.json ${pkg} == functions/lib/version.js ${fe}`, pkg === fe)
check(`package.json == backend/app/version.py ${be}`, pkg === be)
check(`package.json == docs/openapi.json ${oa}（派生件须重新生成）`, pkg === oa)
check(`package.json == package-lock.json 根 version ${lock}（npm install --package-lock-only 同步）`, pkg === lock)
check("语义化版本形态 x.y.z", SEMVER.test(pkg), pkg)

console.log("== 与最新 SemVer tag 对账 ==")
let tags = []
try {
  tags = execFileSync("git", ["tag", "--sort=-creatordate"], { encoding: "utf8" })
    .split(/\r?\n/).filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
} catch { tags = null }
if (tags === null) {
  // fail-closed：git 不可用不得当作通过（与 kb_guard 解释器口径一致）
  check("git tag 可读", false, "git 命令不可用")
} else {
  const latest = (tags[0] || "").slice(1)
  if (!latest) check("存在 SemVer tag（首版前允许）", true, "无 tag，跳过对账")
  else {
    const [cur, lat] = [pkg.split(".").map(Number), latest.split(".").map(Number)]
    const ok = pkg === latest || cur[0] > lat[0]
      || (cur[0] === lat[0] && (cur[1] > lat[1] || (cur[1] === lat[1] && cur[2] >= lat[2])))
    check(`package.json ${pkg} ≥ 最新 tag v${latest}（等于=已发布，大于=待打 tag）`, ok,
      ok ? "" : "版本回退：低于已发布 tag，禁止")
    if (pkg !== latest) console.log(`  NOTE 当前 ${pkg} 尚未打 tag v${pkg}，发布时补打`)
  }
}

console.log("== CHANGELOG 小节与发布正文阈值（与 release.yml 同源，防『预检放行、出包判红』）==")
const REL_YML = read("../../.github/workflows/release.yml")
check("release.yml 的正文长度阈值取自 fixtures/release_notes.json（不抄第二份数字）",
  REL_YML.includes("frontend/tests/fixtures/release_notes.json"),
  "步骤里没读 fixture ⇒ fixture 成摆设，改数字只改一处会漂移")
let minChars = 0
try {
  minChars = JSON.parse(read("./fixtures/release_notes.json")).min_body_chars
} catch { /* 下面按 0 判红，不静默跳过 */ }
check(`fixture 阈值形态合法（≥50）`, Number.isInteger(minChars) && minChars >= 50, `实测 ${minChars}`)
let changelog = ""
try {
  changelog = read("../../CHANGELOG.md")
} catch {
  check("CHANGELOG.md 可读", false, "读不到＝工作目录不对，不得当作通过")
}
if (changelog) {
  const lines = changelog.split(/\r?\n/)
  const head = `## [${pkg}]`
  const i = lines.findIndex((l) => l.startsWith(head))
  check(`CHANGELOG.md 有 ${head} 小节（升版本必须同轮写变更说明）`, i >= 0, "缺失则 Release 只有占位正文")
  if (i >= 0) {
    const j = lines.findIndex((l, k) => k > i && l.startsWith("## ["))
    const body = lines.slice(i + 1, j < 0 ? undefined : j).join("\n").trim()
    check(`${head} 正文 ≥ ${minChars} 字符（Release 正文给人读，不是一句空话）`,
      body.length >= minChars, `实测 ${body.length}`)
  }
}

// CHANGELOG 小节集合单调性（第二十五轮 #59）：上一个已发布 tag 里的每个 `## [x.y.z]` 今天必须还在。
// 为什么必须机器核：本仓已**第四次**发生"整节标题静默消失"——本轮我在把 1.23.1 插到
// `## [Unreleased]\n\n## [1.23.0] - 2026-09-26` 之后时，替换文本里漏写回 1.23.0 标题行，
// 结果 1.23.0 正文被并进 1.23.1 小节，`version_guard` 当时照样 9 pass / 0 fail（它只核当前版本有没有小节）。
// append-only 是 CHANGELOG 的立命之本，而"只核新增"的判据恰好对"丢失"全盲。
console.log("== CHANGELOG 小节单调性（append-only 机器核）==")
const headsOf = (text) => new Set([...text.matchAll(/^## \[([^\]]+)\][^\n]*$/gm)].map((m) => m[1]))
const cur = headsOf(changelog)
// 环境判定：CI 的 actions/checkout 默认 depth 1 浅克隆 ⇒ 本地根本没有 tag。
// 这条判据的发力点在**本地提交时**（本轮我就是用编辑器把 `## [1.23.0]` 整行弄丢的，pre-commit 跑得它）。
// 所以：取到 tag ⇒ 硬核；浅克隆取不到 ⇒ **显式 SKIPPED**（既不静默记绿，也不做成 CI 里永远响的假警报）；
// 非浅克隆却仍取不到 tag ⇒ 异常，判红（那种环境下"没有 tag"才真的是问题）。
const gitCwd = fileURLToPath(new URL("../..", import.meta.url))
let shallow = "unknown"
try { shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8", cwd: gitCwd }).trim() } catch { /* 交给下面的分支处理 */ }
let prevRef = ""
try {
  prevRef = execFileSync("git", ["describe", "--tags", "--abbrev=0", "--exclude", `v${pkg}`],
    { encoding: "utf8", cwd: gitCwd }).trim()
} catch { prevRef = "" }
if (prevRef) {
  let prevHeads = new Set()
  try {
    const prevText = execFileSync("git", ["show", `${prevRef}:CHANGELOG.md`],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
        cwd: fileURLToPath(new URL("../..", import.meta.url)) })
    prevHeads = headsOf(prevText)
  } catch (e) {
    check(`上一个 tag ${prevRef} 的 CHANGELOG 可读`, false, String(e).slice(0, 120))
  }
  if (prevHeads.size) {
    const lost = [...prevHeads].filter((h) => h !== "Unreleased" && !cur.has(h))
    check(`${prevRef} 的 ${prevHeads.size} 个小节今天全部仍在（丢失即判红）`,
      lost.length === 0, `丢失=${lost.join(",")}`)
    check("单调性判据自身有分母（上一版本小节 ≥ 5，读空＝判据失效不许记绿）",
      prevHeads.size >= 5, `读到 ${prevHeads.size} 个`)
  } else {
    check("上一版本小节非空（取到 tag 却解析出 0 个＝正则失效）", false, `tag=${prevRef}`)
  }
} else if (shallow === "true") {
  console.log("  SKIPPED 浅克隆（CI checkout 默认 depth 1）本地无 tag 可对照 ⇒ 本判据在本地 pre-commit 生效；"
    + "这是**具名跳过**，不得读作已通过（同 test_limits 镜像内显式 SKIP 的口径）")
} else {
  check(`能取到上一个已发布 tag（非浅克隆环境取不到＝异常，浅克隆才允许具名跳过；实测 shallow=${shallow}）`,
    false, "git describe 未返回 tag")
}

console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
