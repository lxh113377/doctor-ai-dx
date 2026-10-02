// CDS Hooks 行为守卫（第八十五轮对标落地；npm test 第 29 件套的后半）。
// 分工：cds_guard.mjs 管目录本体，本件管**对外行为**——而且两端都比：
//   权威面直接调用 functions/cds-services/*.js 的 onRequest（同 route_guard 口径，零网络零部署）；
//   镜像面由 backend/tests/cds_dump.py 经 TestClient 走真 HTTP 栈给出事实。
// 为什么必须双端比：同一份 JSON 数据两端各渲染一遍，若只测权威面，镜像面挂错前缀/套了信封/字段序不同
//   都不会被发现——而集成方按 discovery 拿到的 URL 会打到任意一端。
// 负例优先：每条拒绝腿都配一个真实坏样本；每条通过腿都配一个"如果实现坏了它必须变红"的变异体。
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { onRequest as cdsDiscovery } from "../functions/cds-services/index.js"
import { onRequest as cdsInvoke } from "../functions/cds-services/[service].js"
import { BAD_JSON_MESSAGE, BAD_SHAPE_MESSAGE, MAX_BODY_BYTES, TOO_LARGE_MESSAGE } from "../functions/lib/limits.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
let pass = 0
let fail = 0
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  PASS", name) }
  else { fail++; console.log("  FAIL", name + (detail ? ` :: ${detail}` : "")) }
}
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v)
const sameJSON = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
const ctx = (path, init, env = {}) => ({ request: new Request(`https://dx.test${path}`, init), env })
const readJson = async (res) => JSON.parse(await res.text())
const LEAK_RE = /(at\s+\S+\s+\(|file:\/\/|[A-Za-z]:\\|Traceback|DEEPSEEK_API_KEY|sk-[A-Za-z0-9]{8,})/

const spec = JSON.parse(readFileSync(new URL("./fixtures/cds_cases.json", import.meta.url), "utf8"))
const pyRaw = execFileSync(process.env.PYTHON_BIN || "python", ["tests/cds_dump.py"],
  { cwd: `${ROOT}backend`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const py = JSON.parse(pyRaw.trim().split("\n").pop())

console.log("== 0. 输入非空证明（夹具空了，下面所有断言都会空转）==")
check(`探针输入非空（cases=${spec.cases.length} rejects=${spec.rejects.length}）`,
  spec.cases.length >= 9 && spec.rejects.length >= 9, "低于下限＝夹具被裁剪，本件的判定力不成立")
check(`Py 侧真跑到了这些输入（cards=${Object.keys(py.cards).length} rejects=${Object.keys(py.rejects).length}）`,
  Object.keys(py.cards).length === spec.cases.length && Object.keys(py.rejects).length === spec.rejects.length,
  `Py cards=${Object.keys(py.cards).join(",")}`)
check("Py 侧 dump 是在无密钥环境下跑的（llm_key_present=false）", py.llm_key_present === false)

console.log("== 1. GET /cds-services：裸对象、不套信封、带请求编号 ==")
const disc = await cdsDiscovery(ctx("/cds-services"))
const discBody = await readJson(disc)
check("discovery 200 且 Content-Type 是 JSON", disc.status === 200 && /application\/json/.test(disc.headers.get("content-type") || ""))
check("discovery 带 X-Request-Id（可观测性契约覆盖到 hooks 面）", /^[0-9a-f]{4,12}$/.test(disc.headers.get("x-request-id") || ""))
check("discovery 是规范裸对象：顶层键恰为 services（实测 " + Object.keys(discBody).join(",") + "）",
  Object.keys(discBody).join(",") === "services")
check("discovery 未被 {code,data} 信封污染", !("code" in discBody) && !("data" in discBody))
check(`services 条数与目录全等（${discBody.services.length} == ${spec.services.length} 声明 + 目录实际）`,
  discBody.services.length === 2)
check("每个 service 的字段集恰为规范 discovery 五字段",
  discBody.services.every((s) => ["description", "hook", "id", "title", "usageRequirements"].sort().join(",") === Object.keys(s).sort().join(",")),
  `实测 ${JSON.stringify(Object.keys(discBody.services[0]))}`)
check("discovery 双端全等（含顺序）", JSON.stringify(discBody) === JSON.stringify(py.discovery.body),
  `Py=${JSON.stringify(py.discovery.body).slice(0, 120)}`)
check("Py discovery 也是裸对象且状态一致", py.discovery.status === 200 && Object.keys(py.discovery.body).join(",") === "services")
const wrongMethod = await cdsDiscovery(ctx("/cds-services", { method: "POST", body: "{}" }))
const wrongMethodBody = await readJson(wrongMethod)
check("POST /cds-services → 404（与 /api 面同口径，不新增 405 这个第四码）",
  wrongMethod.status === 404 && wrongMethodBody.code === 404 && wrongMethodBody.message === "not found: /cds-services",
  JSON.stringify(wrongMethodBody).slice(0, 120))
check("同一条方法分流双端一致（Py 实测 " + py.probe.post_discovery + "）", py.probe.post_discovery === 404)
const getOnInvocation = await cdsInvoke(ctx("/cds-services/red-flag-screen"))
check("GET /cds-services/{id} → 404", getOnInvocation.status === 404)
check("GET 调用端点双端一致（Py 实测 " + py.probe.get_invocation + "）", py.probe.get_invocation === 404)

console.log("== 2. 卡片形状：规范允许集内、summary<140、红线二常驻位在场 ==")
// 本件自带的卡片校验器：既判现役输出，也拿来判变异体（判据本身必须可被证伪）
const CARD_ALLOWED = ["summary", "indicator", "detail", "source", "overrideReasons"]
function cardErrors(card, urgencies) {
  const errs = []
  const keys = Object.keys(card)
  if (keys.some((k) => !CARD_ALLOWED.includes(k))) errs.push(`出现规范未列或未实现的字段 ${keys.filter((k) => !CARD_ALLOWED.includes(k)).join(",")}`)
  if (keys.join(",") !== CARD_ALLOWED.join(",")) errs.push(`字段顺序 ${keys.join(",")} 与实现约定不一致（双端按序渲染，乱序即第二形态漂移）`)
  if (typeof card.summary !== "string" || !card.summary.trim()) errs.push("summary 缺失或为空（规范 REQUIRED）")
  if (typeof card.summary === "string" && card.summary.length >= 140) errs.push(`summary ${card.summary.length} 字符，规范要求 <140`)
  if (!urgencies.includes(card.indicator)) errs.push(`indicator=${card.indicator} 不在允许集 ${urgencies.join("/")}`)
  if (!String(card.source?.label || "").includes("医生终审")) errs.push("source.label 不含「医生终审」＝红线二的常驻位丢了")
  if (!/^https:\/\//.test(String(card.source?.url || ""))) errs.push("source.url 不是 https")
  if (!Array.isArray(card.overrideReasons) || !card.overrideReasons.length) errs.push("overrideReasons 缺失＝这张卡变成不可驳回的医嘱")
  for (const r of card.overrideReasons || []) if (!String(r.display || "").trim()) errs.push(`overrideReason ${r.code} display 为空`)
  if ("uuid" in card) errs.push("出现 uuid 字段：本仓判据禁止卡内带时钟/随机量（与 fhir_guard 零时钟字段同口径）")
  return errs
}

const urg = py.catalog.urgencies
let shapeBad = 0
let countBad = 0
for (const c of spec.cases) {
  const res = await cdsInvoke(ctx(`/cds-services/${c.service}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hook: "patient-view", hookInstance: `probe-${c.id}`, context: c.context }),
  }))
  const body = await readJson(res)
  const okStatus = res.status === 200
  const cardCount = okStatus ? body.cards.length : -1
  const shapeErrs = okStatus ? body.cards.flatMap((cd) => cardErrors(cd, urg)) : [`状态 ${res.status}`]
  const topKeys = Object.keys(body).join(",")
  const nameHit = okStatus && (c.expect.name_contains === null || cardCount === 0)
    ? true
    : okStatus && body.cards.some((cd) => `${cd.summary}${cd.detail}`.includes(c.expect.name_contains))
  const indOk = okStatus && sameJSON(body.cards.map((cd) => cd.indicator), c.expect.indicators)
  const pyRes = py.cards[c.id]
  const parity = okStatus && pyRes.status === 200 && JSON.stringify(body) === JSON.stringify(pyRes.body)
  if (shapeErrs.length) shapeBad++
  if (cardCount !== c.expect.card_count) countBad++
  check(`${c.id}：状态200/顶层键=cards/条数=${cardCount}(期望${c.expect.card_count})/指示档${JSON.stringify(okStatus ? body.cards.map((cd) => cd.indicator) : [])}/形状${shapeErrs.length ? "坏" : "净"}`,
    okStatus && topKeys === "cards" && cardCount === c.expect.card_count && shapeErrs.length === 0 && nameHit && indOk,
    shapeErrs.join(" | ") || `顶层键=${topKeys} name命中=${nameHit} 档位=${indOk}`)
  check(`${c.id}：Py 侧同输入同输出`, parity,
    `Py 状态=${pyRes.status} Py体=${JSON.stringify(pyRes.body).slice(0, 160)}`)
}
check(`九个探针的形状判定没有一例被放行成假绿（坏例数=${shapeBad}，期望 0）`, shapeBad === 0)
check(`条数断言不是空转（不符例数=${countBad}，期望 0）`, countBad === 0)

console.log("== 3. 拒绝腿：4xx 定码、文案不泄漏、双端同码 ==")
for (const r of spec.rejects) {
  const res = await cdsInvoke(ctx(`/cds-services/${r.service}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r.body),
  }))
  const body = await readJson(res)
  const pyRes = py.rejects[r.id]
  const jsMsg = String(body.message || "")
  const pyMsg = String(pyRes.body?.message || "")
  const strip = (m) => m.replace(/（故障编号 [0-9a-f]+）$/, "")
  check(`${r.id} → ${r.status}（实测 ${res.status}，Py ${pyRes.status}）`,
    res.status === r.status && body.code === r.status && pyRes.status === r.status
    && !LEAK_RE.test(jsMsg) && strip(jsMsg) === strip(pyMsg),
    `JS="${jsMsg}" Py="${pyMsg}"`)
  if (r.status === 422) {
    check(`${r.id}：422 文案逐字等于 limits 常量且带故障编号`,
      jsMsg.startsWith(BAD_SHAPE_MESSAGE) && /（故障编号 [0-9a-f]+）$/.test(jsMsg), jsMsg)
  }
}
check("坏 JSON → 400 且文案等于常量（双端）",
  py.probe.malformed_json === 400 && BAD_JSON_MESSAGE.length > 0)
const emptyRes = await cdsInvoke(ctx("/cds-services/red-flag-screen", { method: "POST", body: "" }))
check("空体 POST → 422（缺规范 REQUIRED，而不是 200 空卡冒充已评估）",
  emptyRes.status === 422 && py.probe.empty_body === 422, `JS=${emptyRes.status} Py=${py.probe.empty_body}`)
const hugeBody = JSON.stringify({ hook: "patient-view", hookInstance: "h", context: { symptoms: ["x".repeat(MAX_BODY_BYTES + 10)] } })
const hugeRes = await cdsInvoke(ctx("/cds-services/red-flag-screen", {
  method: "POST", headers: { "Content-Type": "application/json", "content-length": String(hugeBody.length) }, body: hugeBody,
}))
check("超字节上界 → 413 且不进规则层", hugeRes.status === 413, `实测 ${hugeRes.status}`)
const hugeJson = await readJson(hugeRes)
check("413 文案等于 limits 常量、不含内部阈值数字",
  hugeJson.message === TOO_LARGE_MESSAGE && !/\d{4,}/.test(hugeJson.message), JSON.stringify(hugeJson))

console.log("== 4. 红线一的行为回执：模型在与不在，卡片一字不变 ==")
const acsReq = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hook: "patient-view", hookInstance: "rl-1", context: { symptoms: ["压榨样胸痛向左肩放射", "出冷汗"] } }) }
const noKeyRes = await cdsInvoke(ctx("/cds-services/red-flag-screen", acsReq))
const noKeyText = await noKeyRes.text()
const withKeyRes = await cdsInvoke(ctx("/cds-services/red-flag-screen", { ...acsReq, body: acsReq.body }, { DEEPSEEK_API_KEY: "sk-should-not-matter-abcdef0123456789" }))
const withKeyText = await withKeyRes.text()
check("同输入带密钥/不带密钥两次调用逐字节相同（红旗面不经模型）", noKeyText === withKeyText)
check("重复调用逐字节相同（无时钟字段、无随机 uuid、可复算）",
  noKeyText === await (await cdsInvoke(ctx("/cds-services/red-flag-screen", acsReq))).text())

console.log("== 5. 变异自证：卡片校验器必须拒掉五种坏卡 ==")
const goodCard = JSON.parse(noKeyText).cards[0]
const CARD_MUTS = [
  ["source.label 去掉医生终审", (cd) => { cd.source.label = "基层AI辅助诊断" }],
  ["summary 撑到 140 字符", (cd) => { cd.summary = "x".repeat(140) }],
  ["indicator 写成 urgent（规范没有这档）", (cd) => { cd.indicator = "urgent" }],
  ["删掉 overrideReasons", (cd) => { delete cd.overrideReasons }],
  ["加一个 uuid 字段（引入时钟/随机量）", (cd) => { cd.uuid = "1" }],
]
let cardCaught = 0
for (const [name, mutate] of CARD_MUTS) {
  const bad = JSON.parse(JSON.stringify(goodCard))
  mutate(bad)
  const errs = cardErrors(bad, urg)
  if (errs.length) { cardCaught++; console.log("  PASS 坏卡被拒：", name, `→ ${errs[0].slice(0, 52)}`) }
  else console.log("  FAIL 坏卡被放行：", name)
}
check(`五种坏卡全部被拒（实测 ${cardCaught}/${CARD_MUTS.length}）`, cardCaught === CARD_MUTS.length)
check("现役卡本身通过校验（否则上面五条是在拒一切）", cardErrors(goodCard, urg).length === 0,
  cardErrors(goodCard, urg).join(" | "))

console.log(`CDS Hooks 行为守卫: ${fail === 0 ? `ALL PASS(${pass})` : `FAIL(${fail})`}（discovery+${spec.cases.length} 例双端+${spec.rejects.length} 拒绝腿+红线一行为回执+${CARD_MUTS.length} 变异）`)
process.exit(fail === 0 ? 0 : 1)
