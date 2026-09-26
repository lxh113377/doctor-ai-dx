// 知识库入库门禁：权威 JSON schema 强校验 + 引用完整性 + 孤儿条目检测 + 三方全等（权威 == JS == Py）。
// 目的：知识库扩容（60→200）期防脏数据进入引用白名单；防任何一端生成物被手改造成的静默漂移。
// 第三十二轮 #92 起权威是 data/knowledge.json：本守卫既校权威本体，也校「权威能否再生成出盘上两端」。
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { KNOWLEDGE_BASE, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB, SYNONYMS } from "../functions/lib/knowledge.js"
import { evidenceForSymptoms, reachableFlagTerms } from "../functions/lib/rag.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))
const AUTHORITY = REPO + "data/knowledge.json"

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

// 已核验域名白名单（离线判据，零网络）：防「拼错/不存在的官方域名」冒充回链。
// 根因（2026-09-25 round9 实测）：知识库曾有 16 条 url 指向 **DNS 根本不解析** 的 cmas.org.cn / www.nhoc.org.cn
// （正确域为 www.cma.org.cn 与 www.medjournals.cn，均实测 HTTP 200），属「假回链」——比空 url 更危险，
// 因为它让引用看起来可溯源而实际不可达。新增条目须先核验域名可达再登记进本表。
const VERIFIED_HOSTS = new Set(["www.nhc.gov.cn", "www.acc.org", "www.cma.org.cn", "www.medjournals.cn"])
const unverifiedHosts = KNOWLEDGE_BASE
  .filter((k) => String(k.url || "").trim())
  .map((k) => ({ id: k.id, host: new URL(k.url).host }))
  .filter((x) => !VERIFIED_HOSTS.has(x.host))

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

// ---- 判据本体写成纯函数：真实数据走一遍，变异数据走**同一条**（否则"变异测的是复制品"，等于没测）----
const FOUR = ["KNOWLEDGE_BASE", "SYNONYMS", "RED_FLAG_KEYWORDS", "SYMPTOM_TO_KB"]
const TOP = ["schema_version", "_editing", "_provenance", "entries", "synonyms", "symptom_to_kb", "red_flag_terms"]
const authorityView = (a) => ({
  KNOWLEDGE_BASE: a.entries, SYNONYMS: a.synonyms, RED_FLAG_KEYWORDS: a.red_flag_terms, SYMPTOM_TO_KB: a.symptom_to_kb,
})
const eq = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y))
const driftKeys = (a, jsData) => FOUR.filter((k) => !eq(authorityView(a)[k], jsData[k]))
const pyDriftKeys = (pyData, jsData) => FOUR.filter((k) => !eq(pyData[k], jsData[k]))
const unknownTopKeys = (a) => Object.keys(a).filter((k) => !TOP.includes(k))
// 死权重：加权分支要「词命中查询 且 词命中语料正文」才计分，所以在语料里一次都不出现的词永远加不了分。
const deadFlagTerms = (terms, entries) => {
  const blob = entries.map((k) => String(k.text || "").toLowerCase()).join("\n")
  return terms.filter((kw) => !blob.includes(String(kw).toLowerCase()))
}
// 条目级约束：一次遍历出三类问题（schema／重 id／跳号），真实数据与变异数据同一路径。
function kbSchemaIssues(entries) {
  const out = { schema: [], dup: [], seq: [] }
  const seen = new Set()
  entries.forEach((item, i) => {
    const errs = []
    if (!ID_RE.test(String(item.id))) errs.push(`id 非法: ${item.id}`)
    if (seen.has(item.id)) out.dup.push(item.id)
    seen.add(item.id)
    if (item.id !== `kb-${String(i + 1).padStart(3, "0")}`) out.seq.push(`第 ${i + 1} 位是 ${item.id}`)
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
    if (errs.length) out.schema.push(`${item.id}: ${errs.join(" | ")}`)
  })
  return out
}
console.log("== 权威源 data/knowledge.json（第三十二轮 #92 起数据权威在此，两端均为生成物）==")
const jsSide = { KNOWLEDGE_BASE, SYNONYMS, RED_FLAG_KEYWORDS, SYMPTOM_TO_KB }
let auth = null
let authErr = ""
if (!existsSync(AUTHORITY)) {
  check("data/knowledge.json 存在", false, AUTHORITY)
} else {
  try {
    auth = JSON.parse(readFileSync(AUTHORITY, "utf8"))
  } catch (e) {
    authErr = String(e.message).slice(0, 120)
    check("data/knowledge.json 是合法 JSON", false, authErr)
  }
}
if (auth) {
  const authDrift = driftKeys(auth, jsSide)
  check("权威 == knowledge.js 生成物（四组数据深度相等）", authDrift.length === 0, `漂移字段: ${authDrift.join(",")}`)
  check("权威 entries 数 == 生成物条目数", auth.entries.length === KNOWLEDGE_BASE.length,
    `权威 ${auth.entries.length} vs 生成物 ${KNOWLEDGE_BASE.length}`)
  const extra = unknownTopKeys(auth)
  check("权威不含未声明顶层键（防旁路数据绕过生成器进两端）", extra.length === 0, extra.join(","))
}

// 生成器复算：权威重新生成后与盘上两端逐字节相同 ⇒ 「改权威不重跑」这类漂移当场点名。
// 与 scope/red_flag 两处守卫同一形态（子进程 rc 直读，不看 stdout 猜结论）。
console.log("== 生成器无漂移（export_knowledge.mjs --check）==")
try {
  execFileSync(process.execPath, [REPO + "scripts/export_knowledge.mjs", "--check"], { encoding: "utf8", stdio: "pipe" })
  check("两份生成物与权威逐字节一致", true)
} catch (e) {
  const out = String((e.stdout || "") + (e.stderr || "")).trim().split("\n").slice(-1)[0]
  check("两份生成物与权威逐字节一致", false, out || `rc=${e.status}`)
}

console.log("== schema: 逐条字段约束 ==")
const schemaIssues = kbSchemaIssues(KNOWLEDGE_BASE)
check(`${KNOWLEDGE_BASE.length} 条知识条目 schema 全部合规`, schemaIssues.schema.length === 0, schemaIssues.schema.slice(0, 6).join(" ;; "))
check("id 无重复", schemaIssues.dup.length === 0, schemaIssues.dup.join(","))
check("id 连续编号 kb-001..kb-N", schemaIssues.seq.length === 0, `实际条数 ${KNOWLEDGE_BASE.length}：${schemaIssues.seq.slice(0, 3).join(" | ")}`)

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
check("全部 url 域名 ∈ 已核验白名单（防假回链，新增须先实测可达）",
  unverifiedHosts.length === 0, unverifiedHosts.map((x) => `${x.id}->${x.host}`).slice(0, 6).join(" "))
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

// 死权重：加权分支要「词命中查询 && 词命中语料正文」才计分，所以在 60 条正文里
// 一次都不出现的词永远加不了分。第三十二轮实测基线 8 个并把棘轮定为「只降不升」；
// 第三十三轮把这 8 个词逐个改成语料真写的那个（出冷汗→出汗、胸痛放射→放射痛、
// 高热惊厥→抽搐、妊娠合并→妊娠、果酱样便→果酱样、鞍区麻木→鞍区、
// 大小便失禁→大小便、口唇肿胀→口唇），并重跑 50 例银标集与 20 例留出集：
// 逐例读数零变化、四项聚合读数与基线逐位相同。于是棘轮升级为**零豁免**。
// 故意保留 <= 形式而不写成 === 0：基线写在这里，谁把它扬回 8 就留下一行可审的改动。
const DEAD_FLAG_MAX = 0
const deadFlags = deadFlagTerms(RED_FLAG_KEYWORDS, KNOWLEDGE_BASE)
check(`红旗加权词全部能在语料正文命中（死权重 ≤ ${DEAD_FLAG_MAX}，第三十三轮由 8 收到 0）`,
  deadFlags.length <= DEAD_FLAG_MAX, `实测 ${deadFlags.length}: ${deadFlags.join(",") || "无"}`)

// 语料缺口名册：同义词表的规范词是「指南侧」名，它在语料正文里一次都不出现，
// 就意味着这个临床概念在我们的指南语料里**真的没有内容**（不是写错了词形）。
// 第二十七轮 kb_gap 扩库的前置测量就是这个口径；本轮把它从一次性测量变成常驻台账：
// 基线 6（冷汗/心悸/关节痛/牙痛/排尿困难/咽异物感）只降不升，且逐条点名。
const CORPUS_GAP_MAX = 6
const canonList = Object.keys(SYNONYMS)
const corpusGaps = deadFlagTerms(canonList, KNOWLEDGE_BASE)
check(`同义词规范词的语料缺口 ≤ 基线 ${CORPUS_GAP_MAX}（第三十三轮实测，补条目即下降）`,
  corpusGaps.length <= CORPUS_GAP_MAX,
  `实测 ${corpusGaps.length}/${canonList.length} 个规范词在整库正文零命中: ${corpusGaps.join(",")}`)

// 口语侧→指南侧的桥：加权词表改成指南侧词形后，医生输入里写的是口语侧，
// 必须由同义词表把它桥到加权词上，否则「词表修好了但永远不触发」。
// 反例实测：把 rag 的匹配面改回只扫原始 q，下面两条立刻红（第三十三轮本地演练过）。
const bridgeOne = reachableFlagTerms("冒冷汗伴胸痛")
const bridgeTwo = reachableFlagTerms("孩子高热惊厥")
check(`口语查询「冒冷汗伴胸痛」经同义词表桥到指南侧加权词`, bridgeOne.includes("出汗"),
  `实测够得着的加权词: ${bridgeOne.join(",") || "无"}`)
check(`口语查询「高热惊厥」桥到「抽搐」`, bridgeTwo.includes("抽搐"),
  `实测够得着的加权词: ${bridgeTwo.join(",") || "无"}`)
// 桥也得有反向对照：无临床符号的查询必须一个都加不上，否则上面两条恒真。
const bridgeNeg = reachableFlagTerms("今天天气不错适合出门")
check("桥反向对照：无症状查询加权词零命中（否则上面两条恒真）", bridgeNeg.length === 0,
  `实测命中: ${bridgeNeg.join(",")}`)
check("桥边界：空查询与 null 不得虚构加权词",
  reachableFlagTerms("").length === 0 && reachableFlagTerms(null).length === 0, "")

console.log("== 双端数据零漂移（knowledge.js 与 knowledge.py 均为 data/knowledge.json 的生成物）==")
const pyMirror = fileURLToPath(new URL("../../backend/app/knowledge.py", import.meta.url))
let pyData = null
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
    pyData = parsed
    const diffKeys = pyDriftKeys(parsed, jsSide)
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

// ---- 变异自证（常驻，**纯内存**）：本轮新增的四条判据必须各自点名 ----
// 为什么刻意不落盘：上一版这里把变异写进三份文件、再 fork 子进程复跑自身，结果 c8 报
// `lib/knowledge.js` 函数覆盖从 100% 掉到 33.33%（子进程 raw record 与主进程合并后按索引错位）——
// **判据自己把被测对象改了**，这种"红"与"绿"都不可信。改为在内存里造变异数据、驱动同一批纯函数
// （driftKeys / pyDriftKeys / kbSchemaIssues / deadFlagTerms / unknownTopKeys），
// 零写入、且测的确实是真判据本体而不是它的复制品。
if (auth) {
  console.log("== 变异自证（内存内改数据，驱动同一批判据函数）==")
  const clone = (x) => JSON.parse(JSON.stringify(x))

  const mutTitle = clone(auth)
  mutTitle.entries[0].title = "被改掉的标题"
  const m1 = driftKeys(mutTitle, jsSide)
  check("M1 改权威不重跑生成器 → 三方全等点名 KNOWLEDGE_BASE", m1.includes("KNOWLEDGE_BASE"), m1.join(",") || "没点名＝判据恒真")

  const jsCut = clone(jsSide)
  jsCut.KNOWLEDGE_BASE.splice(1, 1)
  const m2a = driftKeys(auth, jsCut)
  const m2b = pyDriftKeys(pyData || {}, jsCut)
  const m2c = kbSchemaIssues(jsCut.KNOWLEDGE_BASE)
  check("M2 手改生成物摘掉一条 → 权威侧＋镜像侧全等与跳号同时点名",
    m2a.includes("KNOWLEDGE_BASE") && m2b.includes("KNOWLEDGE_BASE") && m2c.seq.length > 0,
    `auth=${m2a.join(",") || "-"} py=${m2b.join(",") || "-"} seq=${m2c.seq.length}`)

  const DEAD_PROBE = "整库不存在的加权词样例"
  const m3 = deadFlagTerms([...RED_FLAG_KEYWORDS, DEAD_PROBE], KNOWLEDGE_BASE)
  check("M3 加一个语料正文里不存在的加权词 → 零豁免判据点名（数据本身三方自洽，证明它不是三方全等的影子）",
    m3.length === deadFlags.length + 1 && m3[m3.length - 1] === DEAD_PROBE, `实测 ${m3.length} vs 基线 ${deadFlags.length}`)
  // 反向对照（第三十三轮重写）：旧写法拿 deadFlags[0] 当换换对象，基线收到 0 后它变成
  // undefined，于是"恰好少一个"永远不成立——零基线时它自己就是一条必红的判据（本轮实测撞到）。
  // 现在先注入再换回：注入后 1 → 把注入的死词换成语料真出现的词 → 回到 0。
  // 这样无论基线是多少，此判据都在量"是否在语料出现"而不是"词表是否非空"。
  const m3b = deadFlagTerms(m3.map((t) => (t === DEAD_PROBE ? "胸痛" : t)), KNOWLEDGE_BASE)
  check("M3 反向对照：把注入的死词换成语料里确实存在的词，死权重数必须回到基线",
    m3b.length === deadFlags.length && !m3b.includes(DEAD_PROBE),
    `注入后 ${m3.length} → 换词后 ${m3b.length}，基线 ${deadFlags.length}`)
  // 语料缺口名册同样双向：注入一个不存在的规范词 → 缺口数 +1；换成真出现的词 → 回到基线。
  const gapProbe = "整库不存在的临床概念样例"
  const gapPlus = deadFlagTerms([...canonList, gapProbe], KNOWLEDGE_BASE)
  const gapSwap = deadFlagTerms(gapPlus.map((t) => (t === gapProbe ? "胸痛" : t)), KNOWLEDGE_BASE)
  check("M5 语料缺口名册可注入可注销（不是抄一个数字当判据）",
    gapPlus.length === corpusGaps.length + 1 && gapSwap.length === corpusGaps.length,
    `+1=${gapPlus.length} 换回=${gapSwap.length} 基线=${corpusGaps.length}`)

  const mutTop = clone(auth)
  mutTop.extra_table = [{ id: "kb-900" }]
  check("M4 权威塞未声明顶层键 → 未声明键判据点名", unknownTopKeys(mutTop).includes("extra_table"),
    unknownTopKeys(mutTop).join(",") || "没点名＝判据恒真")
  check("M4 反向对照：当前权威确实没有未声明键（否则上一条恒真）", unknownTopKeys(auth).length === 0,
    unknownTopKeys(auth).join(","))
}

console.log(`\nKB GUARD SUMMARY: entries=${KNOWLEDGE_BASE.length} symptom_keys=${Object.keys(SYMPTOM_TO_KB).length} coverage=${coverage}% icd_mapped=${KNOWLEDGE_BASE.filter((k) => k.icd).length} 溯源[深链=${deepLinkIds.size} 门户=${portal.length} 未链=${unlinked.length}]`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
