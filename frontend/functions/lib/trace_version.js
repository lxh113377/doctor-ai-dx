// trace_version.js — 决策指纹（第一百零九轮改进3）。把「任一份报告能复盘完整生成链」落成机器可验。
// trace.versions 三元组：app_version（版本面）+ kb_corpus_sha256（语料面）+ rules_table_sha256（规则面），
// 外加 retriever（检索档名）与 engine_schema（本结构的版本号，v1 起）。
// 取数纪律：指纹**现算**（对构建期产物的 canonical JSON 做 sha256），不手抄、不入库快照——
// 语料或规则表一改，下一条 trace 立即换指纹；同输入同指纹（确定性），跨端同值（canonical 序列化见 _canon）。
// 双端同值由 tests/contract_parity.mjs（逐字段）与本文件自检（指纹面）双向兜底。
import { createHash } from "node:crypto"
import { APP_VERSION } from "./version.js"
import { KNOWLEDGE_BASE, SYNONYMS, SYMPTOM_TO_KB } from "./knowledge.js"
import { RED_FLAG_SCHEMA, REFERRAL_DEPARTMENTS, BP_THRESHOLDS, NEGATION, POSITIVE_TERMS, DANGER_RULES, COMBO_RULES } from "./red_flag_rules.js"
import { DEFAULT_RETRIEVER } from "./retriever.js"

/** 递归 canonical 序列化（键全排序、零空白、紧凑分隔符）——与 backend/app/trace_version.py 的 _canon 同形。 */
export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  return JSON.stringify(v)
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex")

export const ENGINE_SCHEMA = 1

/** 指纹面（带缓存：构建期产物进程内不变，重算无意义；测试可 invalidate）。 */
let _kbSha = null, _rulesSha = null
export function kbCorpusSha256() {
  if (_kbSha === null) _kbSha = sha256(canon({ KNOWLEDGE_BASE, SYMPTOM_TO_KB, SYNONYMS }))
  return _kbSha
}
export function rulesTableSha256() {
  if (_rulesSha === null) _rulesSha = sha256(canon({ BP_THRESHOLDS, COMBO_RULES, DANGER_RULES, NEGATION, POSITIVE_TERMS, RED_FLAG_SCHEMA, REFERRAL_DEPARTMENTS }))
  return _rulesSha
}

/** trace.versions 本体（每次调用现读 APP_VERSION，缓存只挡构建期产物）。 */
export function traceVersions() {
  return {
    app_version: APP_VERSION,
    engine_schema: ENGINE_SCHEMA,
    kb_corpus_sha256: kbCorpusSha256(),
    retriever: DEFAULT_RETRIEVER,
    rules_table_sha256: rulesTableSha256(),
  }
}
