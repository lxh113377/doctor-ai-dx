// SBOM 对账门禁：校验一份 CycloneDX 清单是否真的覆盖本仓声明的依赖。
//
// 为什么需要（第十六轮对标实测）：OpenEMR / ragflow / phlox 三家在 GitHub 侧都能读到依赖图 SBOM
// （实测 components 分别为 1817 / 3038 / 1223），而本仓 `GET .../dependency-graph/sbom` 与
// `PUT .../dependency-graph/sbom` **均返回 404** ⇒ 平台侧依赖图这条路在我的账号/仓库设置上不通，
// 不能拿它当"已具备可审计性"。故本轮把可审计性做在仓库自证的产物上：
//   SBOM 由成熟工具生成（@cyclonedx/cyclonedx-npm，版本钉在本文件 TOOL 常量），
//   随 tag 发布为 Release 资产（见 .github/workflows/release.yml），本门禁负责"清单没骗人"。
// 判据取向：**不断言传递闭包全等**（lock 495 个节点里含本平台未安装的可选二进制变体，
// 实测生成 362 条 ⇒ 逐节点相等必然假红），只断言"本仓直接声明的每个依赖 + 锁定版本都在清单里"，
// 这正是评审要追溯的那一层；闭包规模差异以 NOTE 报出而非判红。
//
// 用法：
//   node scripts/sbom_guard.mjs --sbom docs/sbom/frontend.cdx.json --manifest npm
//   node scripts/sbom_guard.mjs --sbom docs/sbom/backend.cdx.json  --manifest pip
//   反例自证：--sbom <被删条/改版的清单> ⇒ 必须 rc=1
// 退出码：0 达标 / 1 判红 / 2 参数或环境错误（fail-closed，缺文件不静默通过）。
import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

// 本文件在 frontend/tests/ 下（与 kb_guard / fhir_guard / coverage_floor_guard 同一族，
// 因此也在 ESLint 覆盖范围内；仓根 scripts/ 只放 Python 工具链。）
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
// 生成工具主版本按 manifest 分列（唯一一处，换大版本＝换判据须复核后同步改）：
// npm → @cyclonedx/cyclonedx-npm 6.x；pip → cyclonedx-bom 7.x
const TOOL_MAJOR = { npm: 6, pip: 7 }
// 组件数下限同样按 manifest 分列：npm 是整棵 lock（实测 362）；pip 侧 CI 只装本仓两份
// requirements（闭包约 30），换环境数字会大幅浮动 ⇒ 下限取"足以证明非空"的量级，不取实测值。
const MIN_COMPONENTS = { npm: 50, pip: 15 }
const LOCK = resolve(REPO, "frontend/package-lock.json")
const PKG = resolve(REPO, "frontend/package.json")
const REQS = [resolve(REPO, "backend/requirements.txt"), resolve(REPO, "backend/requirements-dev.txt")]

const argv = process.argv.slice(2)
const opt = (name, def = "") => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const sbomPath = opt("sbom")
const manifest = opt("manifest")
if (!sbomPath || !["npm", "pip"].includes(manifest)) {
  console.error("用法：node scripts/sbom_guard.mjs --sbom <path> --manifest npm|pip")
  process.exit(2)
}
if (!existsSync(resolve(REPO, sbomPath))) {
  console.error(`[GATE:sbom-fail] 清单文件不存在：${sbomPath}`)
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const raw = readFileSync(resolve(REPO, sbomPath), "utf8")
const bom = JSON.parse(raw)
const comps = Array.isArray(bom.components) ? bom.components : []
const keyOf = (c) => (c.group ? `${c.group}/${c.name}` : c.name)
const byName = new Map()
for (const c of comps) {
  if (!byName.has(keyOf(c))) byName.set(keyOf(c), [])
  byName.get(keyOf(c)).push(String(c.version ?? ""))
}

console.log("== 清单本体 ==")
check("bomFormat 为 CycloneDX", bom.bomFormat === "CycloneDX", String(bom.bomFormat))
check("specVersion 存在且为 1.x", /^1\.\d+$/.test(String(bom.specVersion)), String(bom.specVersion))
check(`组件数 ≥ ${MIN_COMPONENTS[manifest]}（${manifest} 侧输入非空证明：空清单不得判绿）`,
  comps.length >= MIN_COMPONENTS[manifest], `实测 ${comps.length}`)
check("每个组件都有 name 与非空 version", comps.every((c) => c.name && String(c.version ?? "").length > 0),
  comps.filter((c) => !c.name || !c.version).slice(0, 3).map((c) => c.name || "(无名)").join(","))
check("每个组件都有 purl（可跨源追溯源）", comps.every((c) => typeof c.purl === "string" && c.purl.startsWith("pkg:")),
  `缺 purl ${comps.filter((c) => !c.purl).length} 条`)
const toolLine = JSON.stringify((bom.metadata?.tools) ?? {}) + JSON.stringify((bom.metadata?.tools?.component) ?? {})
const wantMajor = String(TOOL_MAJOR[manifest])
check(`生成工具为 cyclonedx 系且主版本 = ${wantMajor}（${manifest} 侧，换大版本＝换判据）`,
  /cyclonedx/i.test(toolLine) && toolLine.includes(`"${wantMajor}.`), toolLine.slice(0, 160))

console.log(`== 与本仓声明对账（manifest=${manifest}）==`)
const declared = []
if (manifest === "npm") {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"))
  const lock = JSON.parse(readFileSync(LOCK, "utf8"))
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const node = lock.packages?.[`node_modules/${name}`]
      declared.push({ name, wantVersion: node?.version ?? null, field })
    }
  }
} else {
  for (const f of REQS) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~].*)?$/)
      if (m && !line.startsWith("#")) declared.push({ name: m[1], wantVersion: null, field: "requirements" })
    }
  }
}
check(`本仓声明的依赖数 ≥ 5（${manifest}，防"声明侧为空⇒零缺失"假通过）`, declared.length >= 5, `实测 ${declared.length}`)
const missing = declared.filter((d) => !byName.has(d.name))
check("每个声明依赖都出现在清单里", missing.length === 0, missing.slice(0, 5).map((d) => d.name).join(","))
const verBad = declared.filter((d) => d.wantVersion && byName.has(d.name) && !byName.get(d.name).includes(d.wantVersion))
check("每个声明依赖的锁定版本与清单一致（仅 npm 侧有 lock 解析版本；pip 侧声明为区间故自然通过）", verBad.length === 0,
  verBad.slice(0, 5).map((d) => `${d.name}: lock ${d.wantVersion} vs bom [${byName.get(d.name)?.join("|")}]`).join(" ; "))

console.log(`\nSBOM GUARD SUMMARY: 文件=${sbomPath} 组件=${comps.length} 声明依赖=${declared.length} 判据通过=${pass} `
  + `sha256=${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`)
if (manifest === "npm") console.log("  NOTE 传递闭包规模差属正常：lock 节点含本平台未安装的可选二进制变体，按声明层对账不按其全等")
if (fail) {
  console.error(`[GATE:sbom-fail] ${fail} 项未达标（清单须由钉版工具重新生成，禁手改 JSON 凑对）`)
  process.exit(1)
}
console.log("[GATE:sbom-pass] RESULT: 全部达标")
