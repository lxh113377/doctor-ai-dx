// 版本真值守卫：五处版本声明必须同值（round7 实测抓到 0.2.0/1.5.0/v1.5.0 三处漂移后固化）。
// 口径：git 最新 SemVer tag 是发布事实源；未到 tag 的升版提交以 package.json 为准，其余四处必须与它一致。
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

console.log("== 四处声明同值 ==")
check(`package.json ${pkg} == functions/lib/version.js ${fe}`, pkg === fe)
check(`package.json == backend/app/version.py ${be}`, pkg === be)
check(`package.json == docs/openapi.json ${oa}（派生件须重新生成）`, pkg === oa)
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

console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
