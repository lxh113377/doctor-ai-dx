// EVAL_CARD 线上读数「现役行」单一生成面（第七十轮）
//
// 一手起因：2026-09-29T00:13 重跑 `npm run eval:live` 得 live=0/31、rule_fallback=31/31、
// p95=1717ms，而 `docs/EVAL_CARD.md` §2 的现役行仍写「mode=live 31/31 / p95 4.890s（2026-09-26）」。
// 那句不是编造的数，是**上一轮手工抄进来的真读数**——手抄的数一轮就过期（台账 #106 同族），
// 而且过期方向危险：回落链路的 1.7s 看着比 live 的 4.9s「更快」，两条链路会被混成一条。
//
// 根治形态取自 peer `pre-commit/pre-commit` `install_uninstall.py:31-32/94-95/104-108` 的标记区替换
// （`TEMPLATE_START/END` 定义 → 按标记切 → 重写该区）：重复执行不产生重复内容。
// 于是把「现役线上行」改成**由 `.eval/eval_report_live.json` 单向渲染的标记区**，
// 人手只留历史行（历史留痕不改写），现役读数在文档里不再有第二份拷贝。
//
// 用法：
//   node tests/eval_card_guard.mjs            # 只核不写盘（CI / npm test 走这条）
//   node tests/eval_card_guard.mjs --write    # 按当前报告重写标记区（自愈路径）
//   node tests/eval_card_guard.mjs --selftest # 双向自证：正例过 + 反例必须会红
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const HERE = dirname(fileURLToPath(import.meta.url))
export const DOC_PATH = resolve(HERE, "../../docs/EVAL_CARD.md")
export const REPORT_PATH = resolve(HERE, "../../.eval/eval_report_live.json")

export const MARKER_START = "<!-- >>> eval-card-live v1 (由 tests/eval_card_guard.mjs 单向生成，禁手改) >>> -->"
export const MARKER_END = "<!-- <<< eval-card-live v1 <<< -->"
// 区外线上行必须带这个标签才算「已声明为历史读数」。标签只在本文定义一处，文档里另造同义写法不算。
export const HISTORY_TAG = "【历史读数】"

const ONLINE_CELL = "线上"
const BT = "`"

/** 读报告并校验输入面形状。缺件＝absent（另档），形状不对＝红，一律显式报，绝不读成「没有现役读数」。 */
export function loadReport(p = REPORT_PATH) {
  if (!existsSync(p)) {
    return { ok: false, absent: true, report: null, errs: [`取数面缺失：${p} 不存在（.eval/ 不入库，须先跑 npm run eval:live）`] }
  }
  let j = null
  let parseErr = ""
  try {
    j = JSON.parse(readFileSync(p, "utf8"))
  } catch (e) {
    parseErr = String(e.message).slice(0, 120)
  }
  const errs = reportErrs(j, parseErr)
  return { ok: errs.length === 0 && !parseErr, absent: false, report: parseErr ? null : j, errs }
}

/** 报告形状判据——独立成函数，好让 --selftest 能喂合成读数而不必改盘。 */
export function reportErrs(j, parseErr) {
  const errs = []
  if (parseErr) return [`取数面不是合法 JSON：${parseErr}`]
  if (!j || typeof j !== "object") return ["取数面解析结果不是对象"]
  const d = j.mode_distribution
  if (!d || typeof d !== "object") {
    errs.push("报告缺 mode_distribution（不得把 undefined 当 0）")
  } else {
    for (const k of ["live", "rule_fallback"]) {
      if (!Number.isInteger(d[k])) errs.push(`mode_distribution.${k} 不是整数（实得 ${String(d[k])}）`)
    }
    if (Number.isInteger(d.live) && Number.isInteger(d.rule_fallback) && d.live + d.rule_fallback <= 0) {
      errs.push("mode_distribution 分母为 0（零输入不得记 PASS）")
    }
  }
  if (typeof j.date !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(j.date)) errs.push(`报告 date 形态不对：${String(j.date)}`)
  if (typeof j.p95_within_10s !== "boolean") errs.push("报告缺 p95_within_10s 布尔位")
  if (typeof j.red_flag_recall_live !== "string") errs.push("报告缺 red_flag_recall_live")
  return errs
}

/** 现役标记区内容——只从报告字段渲染，不接受任何手写字面量。渲染成**一条三列表行**，与 §2 表同形。 */
export function renderRegion(r) {
  const d = r.mode_distribution
  const total = d.live + d.rule_fallback
  const lat = r.dx_latency_ms && typeof r.dx_latency_ms === "object" ? r.dx_latency_ms : {}
  const causeField = Number(r.fallback_cause_field_cases)
  const causeLine = causeField > 0
    ? `降级归因在场：${causeField} 例带 ${BT}fallback_cause${BT}，分布 ${JSON.stringify(r.fallback_cause_distribution || {})}`
    : `降级归因**线上不可见**：${BT}fallback_cause_field_cases${BT}=0，线上跑的仍是未带该字段的已发版本（属未到期，不是回归）`
  const cell1 = `线上链路读数（**现役**·本行由脚本从报告生成，手改必被判红）`
  const cell2 = `live **${d.live}/${total}** ｜ rule-fallback **${d.rule_fallback}/${total}** ｜ 红旗 **${String(r.red_flag_recall_live)}** ｜ `
    + `P95 ${lat.p95 == null ? "无读数" : `${lat.p95}ms`}${r.p95_within_10s ? "（≤10s 达标）" : "（超 10s 约束）"} ｜ `
    + `结构 **${String(r.structure_pass)}** ｜ 引用 **${String(r.citation_valid)}** ｜ 弃权 **${String(r.abstain_cases)}** ｜ `
    + `非设计内回落 **${String(r.unexpected_fallback)}/${total}**`
  const cell3 = `取数=当日线上评测报告（date=${r.date}, base=${String(r.base)}）；该面不入库（干净检出里没有它，缺席时判据记 UNVERIFIED 不记绿），`
    + `生产方 ${BT}npm run eval:live${BT} 与 ${BT}.github/workflows/live-smoke.yml${BT} online-eval 同一套。**P95 只在同 mode 内可比**：本行是 ${d.live > 0 ? "live 主导" : "回落主导"}链路读数，`
    + `禁止与另一 mode 的历史行横比。${causeLine}`
  return [MARKER_START, `| ${cell1} | ${cell2} | ${cell3} |`, MARKER_END].join("\n")
}

/** 按标记切→重写该区。区不在场或哨兵成对异常一律拒绝写盘——绝不追加出第二块。 */
export function replaceRegion(doc, region) {
  const s = doc.indexOf(MARKER_START)
  const e = doc.indexOf(MARKER_END)
  if (s < 0 || e < 0 || e < s) return { ok: false, out: doc, err: "标记区哨兵不成对或顺序不对 ⇒ 拒绝写盘（不追加第二块）" }
  if (doc.indexOf(MARKER_START, s + MARKER_START.length) >= 0) return { ok: false, out: doc, err: "起始哨兵出现多次 ⇒ 拒绝写盘" }
  return { ok: true, out: doc.slice(0, s) + region + doc.slice(e + MARKER_END.length) }
}

/**
 * 取数面：表格里「维度列（第一个单元格）含『线上』」的行 = 对外声称的线上量化行。
 * 按数据流划面而非全文扫，是为了不误伤「分支保护强制性…修后线上 contexts=[…]」这类只在说明列
 * 出现『线上』的行（实测它们会凭空造出待办）。
 */
export function onlineClaimRows(doc) {
  const rows = []
  doc.split("\n").forEach((line, i) => {
    if (!line.startsWith("|")) return
    const cells = line.split("|")
    const head = cells.length > 1 ? cells[1].trim() : ""
    if (head.includes(ONLINE_CELL)) rows.push({ no: i + 1, line, head })
  })
  return rows
}

/** 核心核对：哨兵恰好一对；区内容==再生值；区外每条线上声称行都带历史标签。 */
export function check({ doc, report, region }) {
  const errs = []
  const starts = doc.split(MARKER_START).length - 1
  const ends = doc.split(MARKER_END).length - 1
  const s = starts === 1 ? doc.indexOf(MARKER_START) : -1
  const e = ends === 1 ? doc.indexOf(MARKER_END) + MARKER_END.length : -1
  // 哨兵坏了不提前 return：后面的声称行照数、照报（否则「标记区还没建」这种第一轮必现的红
  // 会把真正要改的哪几行全部吞掉，只剩一句笼统的「不成对」）。
  if (starts !== 1 || ends !== 1) {
    errs.push(`标记区哨兵不成对：起始 ${starts} 处／结束 ${ends} 处（各须恰好 1）⇒ 跑 ${BT}node tests/eval_card_guard.mjs --write${BT} 建区（区内内容全部由报告生成）`)
  }
  const hasRegion = starts === 1 && ends === 1 && s >= 0 && e > s
  const inside = hasRegion ? doc.slice(s, e) : ""
  const outside = hasRegion ? doc.slice(0, s) + "\n" + doc.slice(e) : doc

  if (report && hasRegion && inside !== region) {
    errs.push(`标记区内容与按当前报告再生成的不等 ⇒ 现役行被手改过，或写回后报告又更新了；跑 ${BT}node tests/eval_card_guard.mjs --write${BT} 复原`)
  }

  const claims = onlineClaimRows(outside)
  const mismatched = claims.filter((r) => !r.line.includes(HISTORY_TAG))
  mismatched.forEach((r) => errs.push(
    `线上声称行未标历史（第 ${r.no} 行，维度列「${r.head}」）：要么更新为现役（--write），要么补 ${HISTORY_TAG} 并指向标记区`))

  const liveRows = report && hasRegion ? 1 : 0
  const declared = claims.length + liveRows
  const matched = (claims.length - mismatched.length) + liveRows
  return { errs, declared, matched, mismatched: mismatched.length, hasRegion }
}

function selftest() {
  const goodReport = () => ({
    mode_distribution: { live: 0, rule_fallback: 31 },
    date: "2026-09-29T00:13:49.399Z",
    p95_within_10s: true,
    red_flag_recall_live: "14/14",
    structure_pass: "31/31",
    citation_valid: "31/31",
    abstain_cases: "3/31",
    unexpected_fallback: 28,
    fallback_cause_field_cases: 0,
    fallback_cause_distribution: { unattributed: 31 },
    dx_latency_ms: { p95: 1717 },
    base: "https://doctor-ai-dx.pages.dev",
  })
  const region = renderRegion(goodReport())
  const docGood = [
    "# t",
    "| 维度 | 结果 | 口径 |",
    "|---|---|---|",
    `| ${HISTORY_TAG} 线上红旗（pages.dev live） | 14/14 | 2026-09-16 线上评测 |`,
    region,
    "",
    "| 分支保护强制性（v1.17.0） | 聚合 required check | 修后线上 contexts=[all-checks-passed] |",
  ].join("\n")

  const cases = []
  const push = (name, wantRed, got) => cases.push([name, got === wantRed, `${got ? "红" : "绿"}`, wantRed ? "应红" : "应绿"])

  push("正例：标记区一致 + 区外线上行已标历史", false, check({ doc: docGood, report: goodReport(), region }).errs.length > 0)

  push("反例1：手改现役行（区内容 != 再生值）", true,
    check({ doc: docGood.replace("live **0/31**", "live **31/31**"), report: goodReport(), region }).errs.length > 0)

  push("反例2：区外线上行漏标历史", true,
    check({ doc: docGood.replace(`| ${HISTORY_TAG} 线上红旗`, "| 线上红旗"), report: goodReport(), region }).errs.length > 0)

  push("反例3：标记区被复制成两块", true,
    check({ doc: `${docGood}\n${region}`, report: goodReport(), region }).errs.length > 0)

  const noLive = goodReport()
  delete noLive.mode_distribution.live
  push("反例4：报告缺 mode_distribution.live（不得当 0）", true, reportErrs(noLive, "").length > 0)

  const zero = goodReport()
  zero.mode_distribution = { live: 0, rule_fallback: 0 }
  push("反例5：分母为 0 的报告（零输入不得记 PASS）", true, reportErrs(zero, "").length > 0)

  push("反例6：报告不是合法 JSON", true, reportErrs(null, "Unexpected token") .length > 0)

  // 「说明列含线上、维度列不含」的行不得进分母——否则判据会凭空造出待办（本函数第 7 行即该形态）
  const counted = onlineClaimRows(docGood)
  push("分母自证：说明列的『线上』不被计入（应恰好 1 条声称行）", true,
    !(counted.length === 1 && counted[0].line.includes(HISTORY_TAG)))

  const bad = cases.filter((c) => !c[1])
  cases.forEach((c) => console.log(`${c[1] ? "OK  " : "FAIL"} ${c[0]}（实得 ${c[2]}／${c[3]}）`))
  console.log(bad.length === 0
    ? `eval_card_guard selftest: ${cases.length}/${cases.length} [GATE:evalcard-pass]`
    : `eval_card_guard selftest: ${cases.length - bad.length}/${cases.length} [GATE:evalcard-fail]`)
  process.exit(bad.length === 0 ? 0 : 1)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes("--selftest")) selftest()
  if (!existsSync(DOC_PATH)) {
    console.error(`EVALCARD ERROR: 文档面不存在 ${DOC_PATH}`)
    process.exit(2)
  }
  const doc = readFileSync(DOC_PATH, "utf8")
  const loaded = loadReport()

  if (!loaded.ok && !loaded.absent) {
    loaded.errs.forEach((m) => console.error(`EVALCARD FAIL: ${m}`))
    process.exit(1)
  }

  if (args.includes("--write")) {
    if (!loaded.ok) {
      console.error("EVALCARD FAIL: 报告面不可用 ⇒ 拒绝写盘（宁可留着旧区，也不把『取不到』写成新读数）")
      loaded.errs.forEach((m) => console.error(`  ${m}`))
      process.exit(1)
    }
    const rep = replaceRegion(doc, renderRegion(loaded.report))
    if (!rep.ok) {
      console.error(`EVALCARD FAIL: ${rep.err}`)
      process.exit(1)
    }
    writeFileSync(DOC_PATH, rep.out, "utf8")
    const re = check({ doc: readFileSync(DOC_PATH, "utf8"), report: loaded.report, region: renderRegion(loaded.report) })
    if (re.errs.length > 0) {
      console.error("EVALCARD FAIL: 写盘后复核仍红（不采信『写完就算过』）")
      re.errs.forEach((m) => console.error(`  ${m}`))
      process.exit(1)
    }
    console.log(`EVALCARD WRITE OK: 标记区已按 date=${loaded.report.date} 复原｜复核 matched=${re.matched} mismatched=${re.mismatched} declared=${re.declared}`)
    process.exit(0)
  }

  if (!loaded.ok) {
    const claims = onlineClaimRows(doc)
    console.log(`EVALCARD STATE=ABSENT（取数面不在，本条只报不红）｜未对账线上声称行 ${claims.length} 条｜未对账不等于已对账`)
    loaded.errs.forEach((m) => console.log(`  注记: ${m}`))
    process.exit(0)
  }

  const res = check({ doc, report: loaded.report, region: renderRegion(loaded.report) })
  if (res.declared === 0) {
    console.error("EVALCARD FAIL: 取数面内一条线上声称行都没有 ⇒ 判据失去分母，不得记绿（先核取数面是否被改形）")
    process.exit(1)
  }
  if (res.matched + res.mismatched !== res.declared) {
    console.error(`EVALCARD FAIL: 分母不自洽 matched=${res.matched} + mismatched=${res.mismatched} != declared=${res.declared}`)
    process.exit(1)
  }
  if (res.errs.length > 0) {
    res.errs.forEach((m) => console.error(`EVALCARD FAIL: ${m}`))
    console.error(`EVALCARD 结论: 核 ${res.declared} 条，不合规 ${res.mismatched}`)
    process.exit(1)
  }
  console.log(`EVALCARD PASS: 现役标记区与报告逐字一致｜核 ${res.declared} 条（matched=${res.matched}, mismatched=${res.mismatched}）｜报告 date=${loaded.report.date}`)
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
