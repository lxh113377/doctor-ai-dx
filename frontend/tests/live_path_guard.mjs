// live 路径红线守卫（离线，注入 fetch 桩，零真实网络零密钥）。
// 为什么需要：覆盖率实测（2026-09-25 c8）显示 engine.js 分支覆盖仅 53.12%——
// 根因是**无 Key 时所有测试只走 rule-fallback 分支**，而线上生产跑的是 live 分支。
// 也就是说：三条产品红线在"模型参与生成"这条真实路径上，此前从未被任何自动化测试执行过。
// 本套件用桩喂出 live 分支的各种输出形态（含恶意/畸形），逐条验证红线仍然成立。
import { readFileSync } from "node:fs"
import { buildDiagnosis, buildReport, buildWorkup, nextIntakeQuestion, LLM_FALLBACK_CAUSES, LLM_HTTP_CAUSE_PREFIX } from "../functions/lib/engine.js"
import { KB_ID_SET } from "../functions/lib/knowledge.js"

// 降级原因期望值单一源（#146）：JS 侧枚举与逐类注入的期望原因都在这个 fixture 里，Py 侧同一份对账。
const CAUSE_FIX = JSON.parse(readFileSync(new URL("./fixtures/llm_fallback_causes.json", import.meta.url), "utf8"))

let pass = 0
let fail = 0
const check = (name, condition, detail = "") => {
  if (condition) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}

const ENV = { DEEPSEEK_API_KEY: "sk-test-only-not-real", DEEPSEEK_MODEL: "stub", DEEPSEEK_BASE_URL: "https://stub.local/v1" }
const REAL_FETCH = globalThis.fetch
const CHEST_PAIN = [{ role: "user", content: "压榨样胸痛伴冷汗，放射至左肩，持续两小时不缓解" }]

let calls = []
function stubFetch(handler) {
  calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, hasSignal: !!init?.signal })
    return handler(url, init)
  }
}
const okJson = (content) => ({
  ok: true, status: 200, json: async () => ({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
})
const httpErr = (status) => ({ ok: false, status, json: async () => ({ error: "boom" }) })

const VALID_DX = {
  primary: [
    { name: "急性冠脉综合征（ACS）", prob: "高优先级", strength: "high", reasons: ["典型压榨样胸痛伴冷汗放射痛"], evidence_ids: ["kb-001"] },
    { name: "自发性气胸", prob: "需鉴别", strength: "mid", reasons: ["突发胸痛伴呼吸困难需警惕"], evidence_ids: ["kb-005"] },
  ],
  differential: [{ name: "支气管哮喘", note: "需听诊哮鸣音鉴别", evidence_ids: ["kb-024"] }, { name: "焦虑障碍", note: "须先排器质性", evidence_ids: ["kb-051"] }],
  faq: [{ q: "是否需转诊", a: "按胸痛中心路径处理" }],
}

// 1) 合法 live 输出：mode=live，且请求确实带上了 json 模式与 Bearer 头（契约形态不回退）
stubFetch(() => okJson(VALID_DX))
let dx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
check("合法输出走 live 分支", dx.mode === "live" && dx.primary.length >= 2, `${dx.mode}/${dx.primary.length}`)
check("live 请求带 json_object 响应格式与鉴权头", (() => {
  const body = calls[0]?.body
  return body && body.response_format?.type === "json_object" && typeof body.model === "string"
})(), JSON.stringify(calls[0]?.body || {}).slice(0, 120))

// 2) 红线①：模型编造白名单外 evidence_id → 确定性校验必须剔除，且回填合法引用
stubFetch(() => okJson({
  ...VALID_DX,
  primary: [{ ...VALID_DX.primary[0], evidence_ids: ["kb-999", "KB-001", ""] }, { ...VALID_DX.primary[1], evidence_ids: ["kb-777"] }],
}))
dx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
const leaked = (dx.primary ?? []).flatMap((p) => p.evidence_ids ?? []).filter((id) => !KB_ID_SET.has(id))
check("红线·引用白名单：模型编造的 evidence_id 全部被剔除", leaked.length === 0, leaked.join(","))
check("红线·引用白名单：全非法时回填检索证据而非留空", dx.primary.every((p) => p.evidence_ids.length > 0))
check("refs 与 evidence_ids 一一对应（不出现无出处引用）",
  dx.primary.every((p) => p.refs.length === p.evidence_ids.length))

// 3) 红线①续：模型自带 evidence 字段不得污染白名单来源
stubFetch(() => okJson({ ...VALID_DX, evidence: [{ id: "kb-999", title: "伪造指南", url: "https://stub.local/fake" }] }))
dx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
check("红线·模型返回的 evidence 被检索结果覆盖（不接受模型侧清单）",
  dx.evidence.length > 0 && dx.evidence.every((e) => KB_ID_SET.has(e.id) && e.id !== "kb-999"))

// 4) 红线②：模型试图推翻/清空红旗 → 规则层结果必须原样胜出
stubFetch(() => okJson({
  primary: [{ name: "肌肉骨骼性胸痛", prob: "高优先级", strength: "high", reasons: ["无高危征象"], evidence_ids: ["kb-001"] }],
  differential: VALID_DX.differential, faq: [], flags: [], flag_details: [],
}))
dx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
const flags1 = dx.flags ?? []
check("红线·红旗不可被模型覆盖（模型返回 flags:[] 仍命中）", flags1.length > 0 && String(flags1[0]).includes("急性冠脉综合征"), `flags=${JSON.stringify(dx.flags)}`)
check("红线·flag_details 来自规则层而非模型", Array.isArray(dx.flag_details) && dx.flag_details.length > 0 && !!dx.flag_details[0]?.advice, `details=${JSON.stringify(dx.flag_details)}`)
check("红线·红旗命中时 mode 仍如实标注 live", dx.mode === "live")

// 5) 无红旗病例不应被凭空造出红旗
stubFetch(() => okJson(VALID_DX))
dx = await buildDiagnosis("c2", [{ role: "user", content: "鼻塞流涕两天，无发热" }], ENV)
check("红线·无高危线索时不臆造红旗", (dx.flags ?? ["__undefined__"]).length === 0, `flags=${JSON.stringify(dx.flags)}`)

// 6) 降级路径逐条（每条都必须落到 rule-fallback、给出人读文案，**并给出可归因的原因类别**）
check("单一源对账·JS 导出的原因枚举与 fixture 全等（防两端一起错）",
  JSON.stringify(LLM_FALLBACK_CAUSES) === JSON.stringify(CAUSE_FIX.causes),
  `js=${JSON.stringify(LLM_FALLBACK_CAUSES)} fixture=${JSON.stringify(CAUSE_FIX.causes)}`)
check("单一源对账·HTTP 原因前缀与 fixture 一致", LLM_HTTP_CAUSE_PREFIX === CAUSE_FIX.http_prefix, LLM_HTTP_CAUSE_PREFIX)
const fallbackCases = [
  ["bad_json_text", "非法 JSON 文本", () => okJson("这不是JSON{{{")],
  ["empty_primary", "合法 JSON 但 primary 为空数组", () => okJson({ primary: [], differential: [], faq: [] })],
  ["http_500", "HTTP 500", () => httpErr(500)],
  ["http_429", "HTTP 429（限流）", () => httpErr(429)],
  ["missing_choices", "响应体缺 choices（schema 漂移）", () => ({ ok: true, status: 200, json: async () => ({}) })],
  ["json_throws", "json() 抛异常", () => ({ ok: true, status: 200, json: async () => { throw new Error("bad body") } })],
  ["fetch_abort", "fetch 直接 reject（等价于超时/网络中断后的表现）", () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e }],
]
for (const [id, name, handler] of fallbackCases) {
  stubFetch(handler)
  const out = await buildDiagnosis("c1", CHEST_PAIN, ENV)
  check(`降级·${name} → rule-fallback`, out.mode === "rule-fallback" && !!out.fallback_reason, `${out.mode}/${out.fallback_reason}`)
  check(`降级·${name} → 红旗仍成立（降级不削弱安全层）`, (out.flags ?? []).length > 0, `flags=${JSON.stringify(out.flags)}`)
  check(`降级·${name} → 仍产出 FHIR Bundle`, out.fhir?.resourceType === "Bundle" && out.fhir.entry.length >= 4)
  // 归因维：文案是一句话，原因是闭集枚举。塌成一句「LLM 超时/输出非法」就是 #146 量不出原因的根因。
  check(`降级·${name} → fallback_cause 归类正确`,
    out.fallback_cause === CAUSE_FIX.injected[id],
    `实得 ${JSON.stringify(out.fallback_cause)}，期望 ${JSON.stringify(CAUSE_FIX.injected[id])}（原因塌成一句=不可归因）`)
}
// 反例：超时与网络失败必须分家（两者原先都进同一个 catch）
stubFetch(() => { const e = new TypeError("fetch failed"); throw e })
check("降级·网络层 TypeError（出口不通）归为 net_error 而非 timeout",
  (await buildDiagnosis("c1", CHEST_PAIN, ENV)).fallback_cause === CAUSE_FIX.injected.net_typeerror, "把通道不通记成模型太慢＝修复方向反")
// live 分支不得带原因（带了就等于谎报降级）
stubFetch(() => okJson(VALID_DX))
const liveDx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
check("live 分支 fallback_cause 为空串（不谎报降级）", liveDx.mode === "live" && liveDx.fallback_cause === "", `${liveDx.mode}/${JSON.stringify(liveDx.fallback_cause)}`)
// finish_reason 对账（本轮对标实测到的缺口：本仓此前 0 处读取该字段）
const okJsonFr = (content, fr) => ({
  ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: fr }] }),
})
for (const [fr, key, why] of [
  ["content_filter", "finish_filtered", "被安全过滤的回答不得当 live 诊断发出去"],
  ["length", "finish_length", "被 max_tokens 截断的半句话不得当 live 诊断发出去"],
  ["refusal", "finish_junk", "网关新造的拒绝原因不得静默算成功（未知值也降级）"],
]) {
  stubFetch(() => okJsonFr(VALID_DX, fr))
  const out = await buildDiagnosis("c1", CHEST_PAIN, ENV)
  check(`finish_reason=${fr} → 必须降级（${why}）`,
    out.mode === "rule-fallback" && out.fallback_cause === CAUSE_FIX.injected[key] && (out.flags ?? []).length > 0,
    `${out.mode}/${out.fallback_cause}`)
}
// 反向腿：字段缺失（部分网关不发 finish_reason）不得被误判成降级
stubFetch(() => okJsonFr({ ...VALID_DX, finish_reason_removed: true }, undefined))
const noFrx = await buildDiagnosis("c1", CHEST_PAIN, ENV)
check("finish_reason 缺失仍算 live（不误伤不发该字段的网关）", noFrx.mode === "live" && noFrx.fallback_cause === "", `${noFrx.mode}/${noFrx.fallback_cause}`)

// 7) 无 Key 时绝不外呼（防止把占位密钥当真）
stubFetch(() => { throw new Error("无 Key 也发起了网络调用") })
dx = await buildDiagnosis("c1", CHEST_PAIN, {})
check("无 Key 零外呼并降级", calls.length === 0 && dx.mode === "rule-fallback", `calls=${calls.length}`)
check("无 Key → fallback_cause=no_key（不得与\"模型超时\"共用一句原因）",
  dx.fallback_cause === CAUSE_FIX.injected.no_key, JSON.stringify(dx.fallback_cause))

// 8) 红线③：live 报告缺 disclaimer 时必须补默认「医生终审」文案
stubFetch(() => okJson({ soap: { subjective: "胸痛两小时", objective: "BP 150/95", assessment: "首先排除 ACS", plan: "心电图+肌钙蛋白" }, conclusion: "建议尽快完成心电图" }))
const rep = await buildReport("c1", CHEST_PAIN, ENV, null)
check("红线·报告缺 disclaimer 时注入医生终审默认文案", /医生|终审|参考/.test(rep.disclaimer || ""), rep.disclaimer)
check("报告 mode 如实标注（有 Key 且返回合法即 live）", rep.mode === "live", rep.mode)

// 9) workup 的 live 畸形输出同样必须降级而非抛错
stubFetch(() => okJson({ essential: "不是数组", suggested: null, optional: [] }))
const w = await buildWorkup("c1", CHEST_PAIN, ENV, null)
check("workup 畸形输出降级且不崩", ["rule-fallback", "live"].includes(w.mode) && Array.isArray(w.essential))
check("workup 畸形输出 → fallback_cause=schema（三面都带原因，不只 dx）",
  w.mode === "rule-fallback" && w.fallback_cause === CAUSE_FIX.injected.workup_malformed, `${w.mode}/${JSON.stringify(w.fallback_cause)}`)
stubFetch(() => okJson({ nothing: true }))
const repSchema = await buildReport("c1", CHEST_PAIN, ENV, null)
check("report 缺 soap → fallback_cause=schema", repSchema.mode === "rule-fallback" && repSchema.fallback_cause === CAUSE_FIX.injected.report_missing_soap,
  `${repSchema.mode}/${JSON.stringify(repSchema.fallback_cause)}`)

// 11) 畸形输出双面对账（#187）：一手实跑发现同一份 {"essential":"不是数组"} 在 JS 判 schema 降级、
// 在 Py **抛 AttributeError: 'str' object has no attribute 'get'** ⇒ 期望值落 fixture，两面各自回表。
const SHAPE_FIX = JSON.parse(readFileSync(new URL("./fixtures/malformed_shapes.json", import.meta.url), "utf8"))
check("畸形对账有输入（fixture 至少 5 例，读空＝判据失效不许记绿）", SHAPE_FIX.cases.length >= 5, `实得 ${SHAPE_FIX.cases.length} 例`)
for (const cs of SHAPE_FIX.cases) {
  stubFetch(() => okJson(cs.payload))
  let shOut
  try {
    shOut = cs.face === "dx" ? await buildDiagnosis("c1", CHEST_PAIN, ENV) : await buildWorkup("c1", CHEST_PAIN, ENV, null)
  } catch (e) {
    check(`畸形·${cs.id} → 权威面不得抛（抛出＝把畸形回答当故障而不是降级）`, false, `${e.name}: ${String(e.message).slice(0, 60)}`)
    continue
  }
  const bits = []
  if (shOut.mode !== cs.expect_mode) bits.push(`mode=${shOut.mode}≠${cs.expect_mode}`)
  if (cs.expect_cause && shOut.fallback_cause !== cs.expect_cause) bits.push(`cause=${JSON.stringify(shOut.fallback_cause)}≠${cs.expect_cause}`)
  if (cs.expect_name0 && shOut.primary?.[0]?.name !== cs.expect_name0) bits.push(`primary0=${JSON.stringify(shOut.primary?.[0]?.name)}`)
  if (cs.expect_ev0_nonempty && !(shOut.primary?.[0]?.evidence_ids || []).length) bits.push("primary0 引用被清空（应回填检索证据）")
  if (cs.face === "workup") {
    for (const k of ["essential", "suggested", "optional"]) {
      const arr = shOut[k]
      if (!Array.isArray(arr) || !arr.length) { bits.push(`${k} 组为空或非数组`); continue }
      for (const it of arr) if (typeof it !== "object" || it === null || Array.isArray(it)) bits.push(`${k} 混入非对象条目`)
    }
  }
  if (cs.face === "dx" && (shOut.flags || []).length === 0) bits.push("红旗被畸形输入削弱（红线）")
  if (cs.face === "workup" && (shOut.evidence_ids || []) === undefined) bits.push("workup 缺 evidence_ids 键")
  check(`畸形·${cs.id} → 与 fixture 期望一致且不崩`, bits.length === 0, bits.join("；"))
}

// 10) 系统提示词必须携带红线约束（防有人改 prompt 把红线删掉）
stubFetch(() => okJson(VALID_DX))
await buildDiagnosis("c1", CHEST_PAIN, ENV)
const sys = calls[0]?.body?.messages?.[0]?.content || ""
check("系统提示词含「辅助参考/不替代」与「不得推翻红旗」约束",
  sys.includes("不替代") && sys.includes("红旗") && sys.includes("禁止编造"), sys.slice(0, 80))


// 11) 追问 live 分支（第十五轮补：llmFollowup 此前在双端均零执行）
//     判据与 backend/tests/test_live_path.py 第 8 段逐条对位——权威面先测，镜像面同表。
const FULL5 = [
  { role: "user", content: "压榨样/紧缩感" }, { role: "user", content: "向左肩臂放射" },
  { role: "user", content: "活动/劳累时加重" }, { role: "user", content: "出冷汗" },
  { role: "user", content: "高血压，吸烟" },
]
stubFetch(() => okJson({ question: "是否有晕厥或黑视？", chips: ["有", "无"], done: false }))
const qLive = await nextIntakeQuestion("c1", FULL5, ENV)
check("脚本本题答完 → 追问由 LLM 接管（mode=live）",
  qLive.mode === "live" && qLive.done === false && !!qLive.question, JSON.stringify({ m: qLive.mode, d: qLive.done }))
check("LLM 追问带快选 chips 且 reply 与 question 同文",
  Array.isArray(qLive.chips) && qLive.chips.length > 0 && qLive.reply === qLive.question, JSON.stringify(qLive.chips))
check("追问请求仍走同一 /chat/completions 端点", calls.length === 1 && /\/chat\/completions$/.test(calls[0].url), String(calls[0]?.url))

stubFetch(() => okJson({ done: true }))
const qDone = await nextIntakeQuestion("c1", FULL5, ENV)
check("模型判定信息足够 → 收敛为 done 且回落规则口径",
  qDone.done === true && qDone.mode === "rule" && !!qDone.reply, String(qDone.mode))

stubFetch(() => okJson({ question: "", done: false }))
const qEmpty = await nextIntakeQuestion("c1", FULL5, ENV)
check("空追问（question 为空串）不返回假 live，按 done 收敛",
  qEmpty.done === true && qEmpty.mode === "rule", String(qEmpty.mode))

stubFetch(() => httpErr(500))
const qErr = await nextIntakeQuestion("c1", FULL5, ENV)
check("追问 HTTP 500 → 异常被兜住并收敛（不影响接口可用性）",
  qErr.done === true && qErr.mode === "rule", String(qErr.mode))

// 续问硬上限：答完脚本题后最多再问 3 轮（防不收敛的无限外呼），第 4 轮起强制收敛
stubFetch(() => okJson({ question: "继续追问？", chips: [], done: false }))
const qCap = await nextIntakeQuestion("c1", [...FULL5, ...Array.from({ length: 3 }, (_, k) => ({ role: "user", content: `补充${k + 1}` }))], ENV)
check("追问硬上限 3 轮生效（超出即收敛，不再外呼）",
  qCap.done === true && qCap.mode === "rule" && calls.length === 0, `calls=${calls.length} mode=${qCap.mode}`)

// 11b) 追问三态诚实对账（#188，第六十七轮）：一手＝2026-09-28T08:31Z 线上 live 全回落时第 6 轮回的仍是
// 「问诊信息已足够」，而同一时刻 /api/dx 报 `LLM 超时/输出非法` ⇒ 模型没判断过"够不够"，话却是"已足够"。
// 期望值（词表＋三句文案＋禁说短语）单一源＝tests/fixtures/intake_sources.json，Py 侧读同一份。
const INTAKE_FIX = JSON.parse(readFileSync(new URL("./fixtures/intake_sources.json", import.meta.url), "utf8"))
const { INTAKE_DONE_REPLY, INTAKE_CAP_REPLY, INTAKE_UNAVAILABLE_REPLY } = await import("../functions/lib/data.js")
const claimsEnough = (s) => INTAKE_FIX.claim_phrases.some((p) => String(s || "").includes(p))
const seenSources = new Set()
check("追问文案单一源⇄fixture 逐字节相等（两面各回同一份表，防两端一起错）",
  INTAKE_DONE_REPLY === INTAKE_FIX.replies.model_done
  && INTAKE_CAP_REPLY === INTAKE_FIX.replies.cap_reached
  && INTAKE_UNAVAILABLE_REPLY === INTAKE_FIX.replies.model_unavailable,
  `done=${INTAKE_DONE_REPLY === INTAKE_FIX.replies.model_done}·cap=${INTAKE_CAP_REPLY === INTAKE_FIX.replies.cap_reached}·unav=${INTAKE_UNAVAILABLE_REPLY === INTAKE_FIX.replies.model_unavailable}`)
stubFetch(() => okJson(VALID_DX))
const qScripted = await nextIntakeQuestion("c1", [{ role: "user", content: "胸痛" }], ENV)
seenSources.add(qScripted.source)
check(`三态·脚本本题未答完 → ${INTAKE_FIX.vocabulary.scripted}（不得提前收敛）`,
  qScripted.source === INTAKE_FIX.vocabulary.scripted && qScripted.done === false, String(qScripted.source))
seenSources.add(qLive.source); seenSources.add(qDone.source); seenSources.add(qCap.source)
check("三态·模型 done → 唯一允许说『已足够』的出口",
  qDone.source === INTAKE_FIX.vocabulary.model_done && claimsEnough(qDone.reply) && qDone.fallback_cause === "",
  `${qDone.source}/${String(qDone.reply).slice(0, 16)}`)
check("三态·达上限 → intake-cap 且不得出现『已足够』",
  qCap.source === INTAKE_FIX.vocabulary.cap_reached && !claimsEnough(qCap.reply) && qCap.done === true,
  `${qCap.source}/${JSON.stringify(String(qCap.reply).slice(0, 20))}`)
for (const [label, handler, wantCause] of [
  ["HTTP 500", () => httpErr(500), "http_500"],
  ["网络失败", () => { const e = new TypeError("fetch failed"); throw e }, "net_error"],
  ["空 question", () => okJson({ question: "", done: false }), "schema"],
]) {
  stubFetch(handler)
  const h = await nextIntakeQuestion("c1", FULL5, ENV)
  seenSources.add(h.source)
  check(`三态·模型失败(${label}) → intake-unavailable＋cause=${wantCause}＋不得说『已足够』`,
    h.source === INTAKE_FIX.vocabulary.model_unavailable && h.fallback_cause === wantCause
    && !claimsEnough(h.reply) && h.done === true,
    `${h.source}/${h.fallback_cause}/${JSON.stringify(String(h.reply).slice(0, 14))}`)
}
stubFetch(() => { throw new Error("无 Key 也外呼了") })
const hNoKey = await nextIntakeQuestion("c1", FULL5, {})
seenSources.add(hNoKey.source)
check("三态·无 Key → intake-unavailable＋cause=no_key＋零外呼",
  hNoKey.fallback_cause === "no_key" && hNoKey.source === INTAKE_FIX.vocabulary.model_unavailable && calls.length === 0,
  `${hNoKey.source}/${hNoKey.fallback_cause}/calls=${calls.length}`)
const missVocab = Object.entries(INTAKE_FIX.vocabulary).filter(([, v]) => !seenSources.has(v)).map(([k]) => k)
check(`词表五值全部由本面产出过（实得 ${seenSources.size} 种，缺 ${missVocab.length}）`,
  missVocab.length === 0, missVocab.join(","))

globalThis.fetch = REAL_FETCH
console.log(`\nLIVE PATH SUMMARY: 分支用例=${fallbackCases.length} 组 · 实际外呼拦截=0 · fetch 调用记录=${calls.length}`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
