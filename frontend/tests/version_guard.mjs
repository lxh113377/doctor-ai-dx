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

console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
