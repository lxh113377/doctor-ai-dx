// 知识库入库门禁：条目 schema 强校验 + 引用完整性 + 孤儿条目检测 + 双端数据零漂移核验。
// 目的：知识库扩容（55→200）期防脏数据进入引用白名单；防 knowledge.py 被手改造成的单向导出静默漂移。
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB } from "../functions/lib/knowledge.js"
import { evidenceForSymptoms } from "../functions/lib/rag.js"

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) {
    pass++
    console.log("  PASS", name)
  } else {
    fail++
    console.log("  FAIL", name + (detail ? ` :: ${detail}` : ""))
  }
}

const CURRENT_YEAR = new Date().getUTCFullYear()
const MIN_YEAR = 1990
const ID_RE = /^kb-\d{3}$/
const ICD_RE = /^[A-Z]\d{2}(\.\d{1,2})?$/
// url 不在此列：未回链是已知存量债务，由下方「溯源等级棘轮」按数量守门，不逐条硬拦
const REQUIRED_TEXT_FIELDS = ["title", "source", "scope", "section", "condition", "text"]

// 溯源等级棘轮：只准变好，不准变坏。深链=URL 指向具体文档（pathname 非根）；门户=仅机构域名；未链=url 为空。
// 基线取自 2026-09-24 实测（55 条中 0 深链 / 23 门户 / 32 未链）。补链后请把 UNLINKED_MAX 调小，禁止调大。
const UNLINKED_MAX = 32
const DEEPLINK_MIN = 0
const isDeepLink = (raw) => {
  if (typeof raw !== "string" || !raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === "https:" && u.pathname.replace(/\/+$/, "").length > 0
  } catch {
    return false
  }
}
const deepLinkIds = new Set(KNOWLEDGE_BASE.filter((k) => isDeepLink(k.url)).map((k) => k.id))

// 递归排序键，做与生成顺序无关的深比较（值/结构差异仍会被捕获）
const canon = (value) => {
  if (Array.isArray(value)) return value.map(canon)
  if (value && typeof value === "object") {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key])
    return out
  }
  return value
}

console.log("== schema: 逐条字段约束 ==")
const ids = new Set()
const dupIds = []
const orphanSchema = []
for (const item of KNOWLEDGE_BASE) {
  const errs = []
  if (!ID_RE.test(String(item.id))) errs.push(`id 非法: ${item.id}`)
  if (ids.has(item.id)) dupIds.push(item.id)
  ids.add(item.id)
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof item[field] !== "string" || !item[field].trim()) errs.push(`${field} 缺失/非字符串`)
  }
  if (typeof item.year !== "string" || !/^\d{4}$/.test(item.year)) errs.push(`year 非 4 位数字: ${item.year}`)
  else if (+item.year < MIN_YEAR || +item.year > CURRENT_YEAR) errs.push(`year 越界 [${MIN_YEAR},${CURRENT_YEAR}]: ${item.year}`)
  const rawUrl = String(item.url ?? "").trim()
  if (rawUrl) {
    let urlOk = false
    try { urlOk = new URL(rawUrl).protocol === "https:" } catch { urlOk = false }
    if (!urlOk) errs.push(`url 非合法 https: ${JSON.stringify(rawUrl)}`)
  }
  if (!Array.isArray(item.keywords) || item.keywords.length < 3) errs.push(`keywords 少于 3: ${JSON.stringify(item.keywords)}`)
  else {
    const kw = item.keywords.map((k) => String(k).trim())
    if (kw.some((k) => !k)) errs.push("keywords 含空串")
    if (new Set(kw).size !== kw.length) errs.push("keywords 含重复")
  }
  if (typeof item.text === "string" && item.text.trim().length < 40) errs.push(`text 过短(${item.text.trim().length})`)
  if (!("icd" in item)) errs.push("icd 字段缺失（无编码须显式 null）")
  else if (item.icd !== null) {
    const codes = String(item.icd).split(";").map((c) => c.trim()).filter(Boolean)
    if (!codes.length || codes.some((c) => !ICD_RE.test(c))) errs.push(`icd 形态非法: ${item.icd}`)
  }
  if (errs.length) orphanSchema.push(`${item.id}: ${errs.join(" | ")}`)
}
check("55 条以上知识条目 schema 全部合规", orphanSchema.length === 0, orphanSchema.slice(0, 6).join(" ;; "))
check("id 无重复", dupIds.length === 0, dupIds.join(","))
check("id 连续编号 kb-001..kb-N", KNOWLEDGE_BASE.every((item, i) => item.id === `kb-${String(i + 1).padStart(3, "0")}`),
  `实际条数 ${KNOWLEDGE_BASE.length}`)

console.log("== 覆盖度: 症状映射与孤儿条目 ==")
const kbIds = new Set(KNOWLEDGE_BASE.map((k) => k.id))
const badTargets = []
for (const [sym, targets] of Object.entries(SYMPTOM_TO_KB)) {
  if (!String(sym).trim()) badTargets.push("<空 key>")
  if (!Array.isArray(targets) || !targets.length) badTargets.push(`${sym}: 空映射`)
  for (const id of targets || []) if (!kbIds.has(id)) badTargets.push(`${sym}->${id} 不存在`)
}
check("SYMPTOM_TO_KB 目标 id 全部存在", badTargets.length === 0, badTargets.slice(0, 6).join(" ;; "))

const reachable = new Set(Object.values(SYMPTOM_TO_KB).flat())
const orphans = KNOWLEDGE_BASE.map((k) => k.id).filter((id) => !reachable.has(id))
check("无孤儿条目（每条至少被一个症状线索映射）", orphans.length === 0, `孤儿 ${orphans.length}: ${orphans.join(",")}`)
const coverage = Math.round(((KNOWLEDGE_BASE.length - orphans.length) / KNOWLEDGE_BASE.length) * 1000) / 10

console.log("== 溯源等级棘轮（防「引用可溯源」口径退化）==")
const unlinked = KNOWLEDGE_BASE.filter((k) => !String(k.url || "").trim()).map((k) => k.id)
const portal = KNOWLEDGE_BASE.filter((k) => String(k.url || "").trim() && !deepLinkIds.has(k.id))
check(`未回链条目数 ≤ 基线 ${UNLINKED_MAX}`, unlinked.length <= UNLINKED_MAX, `实测 ${unlinked.length}`)
check(`深链条目数 ≥ 基线 ${DEEPLINK_MIN}`, deepLinkIds.size >= DEEPLINK_MIN, `实测 ${deepLinkIds.size}`)
check("非深链条目的 url 要么是空串要么是合法域名（不得填伪造路径）",
  portal.every((k) => {
    try { return new URL(k.url).protocol === "https:" } catch { return false }
  }))

console.log("== 同义词表 / 红旗词 ==")
const synErrs = []
for (const [canon2, syns] of Object.entries(SYNONYMS)) {
  if (!String(canon2).trim()) synErrs.push("<空规范词>")
  if (!Array.isArray(syns) || !syns.length) synErrs.push(`${canon2}: 空同义词组`)
  for (const s of syns || []) if (typeof s !== "string" || !s.trim()) synErrs.push(`${canon2}: 含非字符串/空同义词`)
}
check("SYNONYMS 组结构合规", synErrs.length === 0, synErrs.slice(0, 6).join(" ;; "))
check("RED_FLAG_KEYWORDS 非空且无重复",
  Array.isArray(RED_FLAG_KEYWORDS) && RED_FLAG_KEYWORDS.length > 0 && new Set(RED_FLAG_KEYWORDS).size === RED_FLAG_KEYWORDS.length,
  `条数 ${RED_FLAG_KEYWORDS?.length}`)
check("红旗词均可被检索层加权消费（长度≥2）",
  RED_FLAG_KEYWORDS.every((k) => String(k).trim().length >= 2),
  RED_FLAG_KEYWORDS.filter((k) => String(k).trim().length < 2).join(","))

console.log("== 双端数据零漂移（knowledge.js 权威源 vs knowledge.py 生成物）==")
const pyMirror = fileURLToPath(new URL("../../backend/app/knowledge.py", import.meta.url))
if (!existsSync(pyMirror)) {
  check("knowledge.py 存在", false, pyMirror)
} else {
  const py = `
import json, sys, os
sys.path.insert(0, os.path.join(${JSON.stringify(fileURLToPath(new URL("..", import.meta.url)))}, "..", "backend"))
from app import knowledge as k
print(json.dumps({
  "KNOWLEDGE_BASE": k.KNOWLEDGE_BASE,
  "SYNONYMS": k.SYNONYMS,
  "RED_FLAG_KEYWORDS": k.RED_FLAG_KEYWORDS,
  "SYMPTOM_TO_KB": k.SYMPTOM_TO_KB,
}, ensure_ascii=False))
`
  let parsed = null
  let err = ""
  try {
    const bin = process.env.PYTHON_BIN || "python"
    parsed = JSON.parse(execFileSync(bin, ["-c", py], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }))
  } catch (e) {
    err = String(e.message || e).slice(0, 200)
  }
  if (!parsed) {
    // fail-closed：解释器不可用不得当作通过（须显式 PYTHON_BIN 指向可用解释器）
    check("knowledge.py 可加载比对", false, `解释器不可用或被拒: ${err}（可用 PYTHON_BIN 指定）`)
  } else {
    const diffKeys = []
    for (const key of ["KNOWLEDGE_BASE", "SYNONYMS", "RED_FLAG_KEYWORDS", "SYMPTOM_TO_KB"]) {
      const jsSide = JSON.stringify(canon({ KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB }[key]))
      const pySide = JSON.stringify(canon(parsed[key]))
      if (jsSide !== pySide) diffKeys.push(key)
    }
    check("四组数据 JS/Py 深度相等（无手改漂移）", diffKeys.length === 0, `漂移字段: ${diffKeys.join(",")}`)
    check("条目数一致", parsed.KNOWLEDGE_BASE?.length === KNOWLEDGE_BASE.length,
      `js=${KNOWLEDGE_BASE.length} py=${parsed.KNOWLEDGE_BASE?.length}`)
  }
}

console.log("== 词表单一源（防探针清单与映射表再次分叉）==")
const deadProbes = Object.keys(SYMPTOM_TO_KB).filter((k) => evidenceForSymptoms([k]).length === 0)
check("每条症状线索都能召回到证据（无死线索）", deadProbes.length === 0, deadProbes.join(","))
for (const rel of ["../functions/lib/engine.js", "../../backend/app/services/engine.py"]) {
  const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
  const hasDupVocab = /"胸痛"\s*,\s*"胸闷"/.test(src)
  const singleSource = /Object\.keys\(SYMPTOM_TO_KB\)|list\(SYMPTOM_TO_KB\.keys\(\)\)/.test(src)
  check(`${rel} 探针单一源`, !hasDupVocab && singleSource, hasDupVocab ? "仍存在硬编码探针清单" : "未从 SYMPTOM_TO_KB 派生")
}

console.log(`\nKB GUARD SUMMARY: entries=${KNOWLEDGE_BASE.length} symptom_keys=${Object.keys(SYMPTOM_TO_KB).length} coverage=${coverage}% icd_mapped=${KNOWLEDGE_BASE.filter((k) => k.icd).length} 溯源[深链=${deepLinkIds.size} 门户=${portal.length} 未链=${unlinked.length}]`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
