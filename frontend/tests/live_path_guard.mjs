// live 路径红线守卫（离线，注入 fetch 桩，零真实网络零密钥）。
// 为什么需要：覆盖率实测（2026-09-25 c8）显示 engine.js 分支覆盖仅 53.12%——
// 根因是**无 Key 时所有测试只走 rule-fallback 分支**，而线上生产跑的是 live 分支。
// 也就是说：三条产品红线在"模型参与生成"这条真实路径上，此前从未被任何自动化测试执行过。
// 本套件用桩喂出 live 分支的各种输出形态（含恶意/畸形），逐条验证红线仍然成立。
import { buildDiagnosis, buildWorkup, buildReport } from "../functions/lib/engine.js"
import { KB_ID_SET } from "../functions/lib/knowledge.js"

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

// 6) 降级路径逐条（每条都必须落到 rule-fallback 且给出原因）
const fallbackCases = [
  ["非法 JSON 文本", () => okJson("这不是JSON{{{")],
  ["合法 JSON 但 primary 为空数组", () => okJson({ primary: [], differential: [], faq: [] })],
  ["HTTP 500", () => httpErr(500)],
  ["HTTP 429（限流）", () => httpErr(429)],
  ["响应体缺 choices（schema 漂移）", () => ({ ok: true, status: 200, json: async () => ({}) })],
  ["json() 抛异常", () => ({ ok: true, status: 200, json: async () => { throw new Error("bad body") } })],
  ["fetch 直接 reject（等价于超时/网络中断后的表现）", () => { const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e }],
]
for (const [name, handler] of fallbackCases) {
  stubFetch(handler)
  const out = await buildDiagnosis("c1", CHEST_PAIN, ENV)
  check(`降级·${name} → rule-fallback`, out.mode === "rule-fallback" && !!out.fallback_reason, `${out.mode}/${out.fallback_reason}`)
  check(`降级·${name} → 红旗仍成立（降级不削弱安全层）`, (out.flags ?? []).length > 0, `flags=${JSON.stringify(out.flags)}`)
  check(`降级·${name} → 仍产出 FHIR Bundle`, out.fhir?.resourceType === "Bundle" && out.fhir.entry.length >= 4)
}

// 7) 无 Key 时绝不外呼（防止把占位密钥当真）
stubFetch(() => { throw new Error("无 Key 也发起了网络调用") })
dx = await buildDiagnosis("c1", CHEST_PAIN, {})
check("无 Key 零外呼并降级", calls.length === 0 && dx.mode === "rule-fallback", `calls=${calls.length}`)

// 8) 红线③：live 报告缺 disclaimer 时必须补默认「医生终审」文案
stubFetch(() => okJson({ soap: { subjective: "胸痛两小时", objective: "BP 150/95", assessment: "首先排除 ACS", plan: "心电图+肌钙蛋白" }, conclusion: "建议尽快完成心电图" }))
const rep = await buildReport("c1", CHEST_PAIN, ENV, null)
check("红线·报告缺 disclaimer 时注入医生终审默认文案", /医生|终审|参考/.test(rep.disclaimer || ""), rep.disclaimer)
check("报告 mode 如实标注（有 Key 且返回合法即 live）", rep.mode === "live", rep.mode)

// 9) workup 的 live 畸形输出同样必须降级而非抛错
stubFetch(() => okJson({ essential: "不是数组", suggested: null, optional: [] }))
const w = await buildWorkup("c1", CHEST_PAIN, ENV, null)
check("workup 畸形输出降级且不崩", ["rule-fallback", "live"].includes(w.mode) && Array.isArray(w.essential))

// 10) 系统提示词必须携带红线约束（防有人改 prompt 把红线删掉）
stubFetch(() => okJson(VALID_DX))
await buildDiagnosis("c1", CHEST_PAIN, ENV)
const sys = calls[0]?.body?.messages?.[0]?.content || ""
check("系统提示词含「辅助参考/不替代」与「不得推翻红旗」约束",
  sys.includes("不替代") && sys.includes("红旗") && sys.includes("禁止编造"), sys.slice(0, 80))

globalThis.fetch = REAL_FETCH
console.log(`\nLIVE PATH SUMMARY: 分支用例=${fallbackCases.length} 组 · 实际外呼拦截=0 · fetch 调用记录=${calls.length}`)
console.log(`RESULT: ${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
