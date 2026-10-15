#!/usr/bin/env node
// 决策指纹守卫（trace version guard）——第一百零九轮改进3。
//
// 为什么：改进前的 dx.trace 只有 evidence_ids/rounds/symptoms——出问题时知道"用了哪些证据"，
// 却不知道"当时的语料是哪一版、规则表是哪一版、跑的哪个版本"。复盘要靠翻 git log 对时间，
// 而 trace 里恰恰没有时间（零时钟是故意的，见 fhir_guard）⇒ 「任一份报告可复盘完整生成链」缺一个机器可验的锚。
//
// 判据（四条，全为现算）：
//   T1  结构：JS 侧 buildDiagnosis 的 dx.trace.versions 在场，五键齐全、形合（sha256 是 64 位十六进制）。
//   T2  同值：JS 侧指纹与 backend Py 侧指纹逐字段全等（跨端复盘的前提）。
//   T3  现算：kb_corpus_sha256 == 对构建期产物现算的 canonical sha；手抄或过期缓存立刻失配。
//   T4  敏感：变异语料（改一个关键词的语料面常量）→ 指纹必须变（证指纹真挂在内容上，不是摆设）。
//
// 用法：node tests/trace_version_guard.mjs
// 退出码：0 全过｜1 违例｜2 取数面坏
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { canon, kbCorpusSha256, rulesTableSha256 } from "../functions/lib/trace_version.js"
import { KNOWLEDGE_BASE, SYNONYMS, SYMPTOM_TO_KB } from "../functions/lib/knowledge.js"

let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? " :: " + detail : "")) }
}

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3")

// —— T1 结构 ——
const dx = await (async () => {
  const { buildDiagnosis } = await import("../functions/lib/engine.js")
  return buildDiagnosis("c1", [{ role: "user", content: "压榨样胸痛向左肩放射" }], {})
})()
const v = dx?.trace?.versions
const KEYS = ["app_version", "engine_schema", "kb_corpus_sha256", "retriever", "rules_table_sha256"]
check("T1 trace.versions 在场且五键齐全", !!v && KEYS.every((k) => v[k] !== undefined),
  "缺: " + KEYS.filter((k) => !v || v[k] === undefined).join("/"))
const SHA_RE = /^[0-9a-f]{64}$/
check("T1 形合（sha256 十六进制 64 位／schema 为正整数／retriever 非空）",
  !!v && SHA_RE.test(v.kb_corpus_sha256 || "") && SHA_RE.test(v.rules_table_sha256 || "")
  && Number.isInteger(v.engine_schema) && v.engine_schema >= 1 && typeof v.retriever === "string" && !!v.retriever)

// —— T2 双端同值 ——
const dump = spawnSync(PY, ["-c", "import sys, json; sys.path.insert(0, 'backend'); from app.services.trace_version import trace_versions; print(json.dumps(trace_versions(), sort_keys=True))"], { encoding: "utf8", cwd: fileURLToPath(new URL("../..", import.meta.url)) })
let pv = null
try { pv = JSON.parse(dump.stdout) } catch { /* 取数面坏走 BROKEN */ }
check("T2 Py 侧指纹可取", pv !== null, String(dump.stderr || "").slice(0, 160))
check("T2 五字段逐值全等（跨端同值）", !!v && !!pv && KEYS.every((k) => JSON.stringify(v[k]) === JSON.stringify(pv[k])),
  "diff: " + KEYS.filter((k) => JSON.stringify(v?.[k]) !== JSON.stringify(pv?.[k])).join("/"))

// —— T3 现算 ——
const expectedKb = createHash("sha256").update(canon({ KNOWLEDGE_BASE, SYMPTOM_TO_KB, SYNONYMS })).digest("hex")
check("T3 kb 指纹＝语料面现算（缓存≠过期）", v && v.kb_corpus_sha256 === expectedKb && expectedKb === kbCorpusSha256())
check("T3 规则表指纹＝规则面现算", v && v.rules_table_sha256 === rulesTableSha256())

// —— T4 敏感（变异语料指纹必变）——
const mutated = canon({ KNOWLEDGE_BASE: KNOWLEDGE_BASE.map((k) => k.id === KNOWLEDGE_BASE[0].id ? { ...k, title: k.title + "！" } : k), SYMPTOM_TO_KB, SYNONYMS })
const mutatedSha = createHash("sha256").update(mutated).digest("hex")
check("T4 变异语料 ⇒ 指纹必变（指纹挂在内容上）", mutatedSha !== expectedKb)
check("T4 自检：现算函数与直算一致", kbCorpusSha256() === createHash("sha256").update(canon({ KNOWLEDGE_BASE, SYMPTOM_TO_KB, SYNONYMS })).digest("hex"))

console.log(`[GATE:trace-version:${fail === 0 ? "pass" : "fail"}] matched=${pass} mismatched=${fail}｜kb=${(expectedKb || "").slice(0, 12)} rules=${(v?.rules_table_sha256 || "").slice(0, 12)}｜rc=${fail === 0 ? 0 : 1}`)
process.exit(fail === 0 ? 0 : 1)
