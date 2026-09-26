// 否定守卫的全表探针（第二十五轮 #50）。
// 为什么要有它：上一轮修红旗层否定词假阳性时，"阳性对照 8 条全命中、阴性 10 条全不命中"这份对照集
// 是**我手挑的**——挑出来的对照只能证明我挑的那几条没坏，不能证明守卫对整张规则表生效。
// 本件把分母交给规则表本身：所有关键词逐个生成"必须命中"与"必须被否定"两向用例，
// 表里加一个关键词，射程自动扩大一格，不需要有人记得补测试（同 r20 suite_guard 的反向枚举口径）。
// 镜像端 `backend/tests/smoke_engine.py` 有一份等价的派生探针：双端各自主张同一事实，
// 而两张规则表本身已由 engine_smoke 的「逐字全等」判据钉住 ⇒ 不必为此再加一次跨语言 spawn。
import { scanFlagDetails, RULE_TABLES } from "../functions/lib/rules.js"

const { DANGER, COMBO, POSITIVES } = RULE_TABLES
const positiveTerms = new Set(POSITIVES.map((p) => p.term))
const NEG_PREFIX = "没有" // 用于构造阴性样本（表内已登记的明确阴性表述之一）

const rows = []
const check = (name, cond, detail = "") => { rows.push({ name, cond, detail }) }

// —— DANGER 规则：任一关键词单独出现即须命中；该关键词被否定后须不命中 ——
for (const r of DANGER) {
  for (const k of r.keywords) {
    const pos = scanFlagDetails(k).some((h) => h.name === r.name)
    check(`DANGER「${r.name}」关键词 ${JSON.stringify(k)} 阳性出现即命中`, pos,
      `实测命中 ${scanFlagDetails(k).map((h) => h.name).join(",") || "无"}`)
    const negated = NEG_PREFIX + k
    const still = scanFlagDetails(negated).some((h) => h.name === r.name)
    // 阳性例外词（无尿＝尿闭）被否定前缀修饰时同样应判阴性，故不特判
    check(`DANGER「${r.name}」关键词 ${JSON.stringify(k)} 加否定前缀即不命中`, !still,
      `仍命中：${negated}`)
  }
}

// —— COMBO 规则：每组各取一个阳性线索才命中；任一组被否且该组无其它线索则不命中 ——
for (const r of COMBO) {
  const groups = r.all
  for (let gi = 0; gi < groups.length; gi++) {
    for (const k of groups[gi]) {
      const others = groups.filter((_, i) => i !== gi).map((g) => g[0])
      const posText = [...others, k].join("，")
      check(`COMBO「${r.name}」第${gi + 1}组关键词 ${JSON.stringify(k)} 齐线索即命中`,
        scanFlagDetails(posText).some((h) => h.name === r.name), `文本 ${posText}`)
      const negText = [...others, NEG_PREFIX + k].join("，")
      check(`COMBO「${r.name}」第${gi + 1}组关键词 ${JSON.stringify(k)} 被否即不命中`,
        !scanFlagDetails(negText).some((h) => h.name === r.name), `文本 ${negText}`)
    }
  }
}

const fails = rows.filter((r) => !r.cond)
console.log("=== 否定守卫全表探针 ===")
console.log(`规则表：DANGER ${DANGER.length} 条 / COMBO ${COMBO.length} 条 / `
  + `关键词 ${DANGER.reduce((n, r) => n + r.keywords.length, 0)}＋组合词 `
  + `${COMBO.reduce((n, r) => n + r.all.reduce((m, g) => m + g.length, 0), 0)} 个`)
console.log(`阳性例外词（形似否定实为体征）: ${[...positiveTerms].join(", ") || "无"}`)
console.log(`派生用例 ${rows.length} 条，逐条可定位；失败 ${fails.length} 条`)
for (const f of fails.slice(0, 10)) console.log(`  FAIL ${f.name} :: ${f.detail}`)
if (rows.length < 100) {
  console.log(`FAIL 派生用例仅 ${rows.length} 条（<100）⇒ 规则表读空或解析失效，判红而不是"没什么可测"`)
  process.exit(1)
}
if (fails.length) { console.log(`RESULT: ${rows.length - fails.length} pass / ${fails.length} fail`); process.exit(1) }
console.log(`RESULT: ${rows.length} pass / 0 fail  [GATE:negation-probe-pass]`)
process.exit(0)
