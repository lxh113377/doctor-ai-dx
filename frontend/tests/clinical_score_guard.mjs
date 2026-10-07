#!/usr/bin/env node
// 第一百零四轮改造一的常驻判据：临床评分量表（qSOFA／休克指数 SI）。
// 为什么不是"跑一遍看看"：本仓第一条硬规矩是「改任何一面的行为 ⇒ 另一面同改」，而评分逻辑
// 恰好是双端各有一份实现的判定代码——只测 JS 侧，Py 侧可以带着不同的舍入/否定窗口发布出去。
// 架构照 error_parity 那一套：**期望只写在 fixtures/clinical_scores.json 一处**，JS 与 Py 各自读它、
// 各自比对自己的实现；本文件不再生成期望，也绝不允许为了让它绿而改期望数字。
// 三态退出（沿用 r97 peer 取证件与 load_probe 的纪律）：0=全过 / 1=有断言失败 / 2=取数面坏了（读不到权威或 fixture）。
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const FIXTURE_PATH = path.join(REPO, "tests", "fixtures", "clinical_scores.json")
const AUTHORITY = path.join(REPO, "..", "data", "clinical_scores.json")

const rows = []
const check = (name, pass, detail = "") => rows.push({ name, pass: !!pass, detail })

if (!existsSync(FIXTURE_PATH) || !existsSync(AUTHORITY)) {
  console.error(`[GATE:clinical-score:broken] 取数面缺失：fixture=${existsSync(FIXTURE_PATH)} authority=${existsSync(AUTHORITY)}`)
  process.exit(2)
}
let fixture, authority
try {
  fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
  authority = JSON.parse(readFileSync(AUTHORITY, "utf8"))
} catch (e) {
  console.error(`[GATE:clinical-score:broken] 取数面不可解析：${e.message}`)
  process.exit(2)
}
if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
  console.error("[GATE:clinical-score:broken] fixture.cases 为空（读空＝判据失效，不许当通过）")
  process.exit(2)
}

const mod = await import(pathToFileURL(path.join(REPO, "functions", "lib", "rules.js")).href)
const tableMod = await import(pathToFileURL(path.join(REPO, "functions", "lib", "clinical_scores.js")).href)
const { scoreClinicalSigns, scanFlagDetailsWithSigns } = mod

// ---------- ① 权威 ⇄ JS 生成物逐字段复算 ----------
// 比的是**字段值**不是 JSON 文本：生成器按 ITEM_FIELDS 顺序重排了键，而 JSON.stringify 连键序一起比，
// 于是「两端完全同值」也会判红（第一版就是这么红的）。无 op/value 的意识项两侧都归一成 null。
const normItem = (it) => JSON.stringify(["label", it.label, "need", it.need, "op", it.op ?? null, "value", it.value ?? null, "points", it.points])
const normBand = (b) => JSON.stringify(["min", b.min, "max", b.max, "level", b.level, "advice", b.advice])
const normScore = (s) => JSON.stringify(["id", s.id, "title", s.title, "source", s.source, "hint", s.hint])
  + "|" + s.items.map(normItem).sort().join(";") + "|" + s.bands.map(normBand).join(";")
const authRepr = authority.scores.map(normScore).join("\n")
const jsRepr = tableMod.SCORE_TABLES.map(normScore).join("\n")
const jsEqAuth = authRepr === jsRepr
check(`权威 data/clinical_scores.json ⇄ JS 生成物逐字段全等（scores=${tableMod.SCORE_TABLES.length}）`, jsEqAuth,
  jsEqAuth ? "" : `首个差异 ⇒ auth=${authority.scores.map(normScore).find((x, i) => x !== tableMod.SCORE_TABLES.map(normScore)[i])?.slice(0, 240)}`)
check("schema_version 两端同值", tableMod.CLINICAL_SCORE_SCHEMA === authority.schema_version)
check("plausible_ranges 生成物未丢档（5 项）", Object.keys(tableMod.PLAUSIBLE_RANGES).length === 5, JSON.stringify(Object.keys(tableMod.PLAUSIBLE_RANGES)))

// ---------- ② 双端共同期望：本文件跑 JS 侧 ----------
const missingByScore = (vitals, text) => Object.fromEntries(
  scoreClinicalSigns(vitals, text).map((r) => [r.id, r.missing.map((m) => m.need).sort()]))
for (const c of fixture.cases) {
  const base = scanFlagDetailsWithSigns(c.text, c.vitals)
    .filter((d) => /评分 \d+\/\d+/.test(d.name))
  const gotNames = base.map((d) => d.name)
  const wantNames = c.expect_flags.map((f) => f.name)
  check(`[${c.id}] 触发的评分条目`, JSON.stringify(gotNames) === JSON.stringify(wantNames), `实得 ${JSON.stringify(gotNames)} / 期望 ${JSON.stringify(wantNames)}`)
  const gotSev = base.map((d) => d.severity)
  const wantSev = c.expect_flags.map((f) => f.severity)
  check(`[${c.id}] 严重度`, JSON.stringify(gotSev) === JSON.stringify(wantSev), `实得 ${JSON.stringify(gotSev)} / 期望 ${JSON.stringify(wantSev)}`)
  const gotMissing = missingByScore(c.vitals, c.text)
  const wantMissing = Object.fromEntries(Object.entries(c.expect_missing).map(([k, v]) => [k, [...v].sort()]))
  // 分母双向：既要求「实现多报的表」被抓，也要求「fixture 没列的表」不允许静默缺席——
  // 只比 fixture 里出现过的键，等于新加一张量表后这条腿永绿。
  const tables = tableMod.SCORE_TABLES.map((t) => t.id).sort().join(",")
  const fixtureTables = Object.keys(c.expect_missing).sort().join(",")
  check(`[${c.id}] fixture 覆盖全部量表（分母不漏不重）`, tables === fixtureTables, `表名册 ${tables} / fixture ${fixtureTables}`)
  check(`[${c.id}] 逐表 missing 具名（含脏读越界项）`,
    JSON.stringify(gotMissing) === JSON.stringify(wantMissing),
    `实得 ${JSON.stringify(gotMissing)} / 期望 ${JSON.stringify(wantMissing)}`)
}

// ---------- ③ 反例腿：每条都必须"该红的红" ----------
const anti = []
// 反例 1：把脏读值当成正常值（越界读数若被静默读成 0，SI 会算出 0 并落进「正常」档）
const dirty = scoreClinicalSigns([{ key: "BP", value: "999/999" }], "腹痛")
const siDirty = dirty.find((r) => r.id === "shock_index")
anti.push(["越界血压不进 SI 计算（不返回 0 冒充正常）", siDirty.items.every((i) => i.hit === null) && siDirty.band === null])
// 反例 2：全空输入不许抛错、也不许报"正常"
const empty = scoreClinicalSigns(undefined, undefined)
anti.push(["体征与文本双空仍返回名册条数、不抛错", Array.isArray(empty) && empty.length === tableMod.SCORE_TABLES.length && empty.every((r) => r.band === null)])
// 反例 3：文本含"无意识障碍"时意识项必须为阴性而非缺失（第二十四轮否定纪律的延伸）
// items 里只带 label/hit（need 是表内字段，不回流到结果），所以按 label 取——
// 上一版按 `i.need` 找，取到 undefined 后读 .hit 直接把判据自己带崩：失败路径也会崩，同族第二次。
const neg = scoreClinicalSigns([{ key: "RR", value: "24" }, { key: "BP", value: "90/60" }], "高热，无意识障碍")
const negItem = neg.find((r) => r.id === "qsofa")?.items.find((i) => /意识/.test(String(i.label)))
anti.push(["否定词形「无意识障碍」判阴性且不落 missing", negItem ? negItem.hit === false : false, `实得 ${JSON.stringify(negItem)}`])
// 反例 4：name 必须唯一（同名会被去重分支静默合并＝少报一条危险信号，红旗层同族）
const dup = scanFlagDetailsWithSigns("高热寒战，意识模糊，呼吸急促", [{ key: "RR", value: "30" }, { key: "BP", value: "80/50" }])
anti.push(["去重后 name 无重复", new Set(dup.map((d) => d.name)).size === dup.length])
// 反例 5：评分条目必须带非空 advice（医生看不到处置＝等于没提示）
anti.push(["每条评分红旗都带 ≥10 字 advice", dup.filter((d) => /评分/.test(d.name)).every((d) => String(d.advice).trim().length >= 10)])
// 反例 6：真变异体腿——把生成器与权威件复制进临时树（生成器按自身 URL 解析仓根，所以副本可独立跑），
// 注入一处坏档后必须 rc=2 点名，且**零写盘**。不碰仓内 data/，也不靠"注入没生效"来凑通过。
const { spawnSync } = await import("node:child_process")
const { cpSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs")
const { tmpdir } = await import("node:os")
const sandbox = path.join(tmpdir(), `clinical-score-mutant-${Date.now()}`)
try {
  mkdirSync(path.join(sandbox, "scripts"), { recursive: true })
  mkdirSync(path.join(sandbox, "data"), { recursive: true })
  mkdirSync(path.join(sandbox, "frontend/functions/lib"), { recursive: true })
  mkdirSync(path.join(sandbox, "backend/app"), { recursive: true })
  cpSync(path.join(REPO, "..", "scripts", "export_clinical_scores.mjs"), path.join(sandbox, "scripts", "export_clinical_scores.mjs"))
  const gen = path.join(sandbox, "scripts", "export_clinical_scores.mjs")
  const authCopy = path.join(sandbox, "data", "clinical_scores.json")
  const JS_COPY = path.join(sandbox, "frontend/functions/lib/clinical_scores.js")
  const PY_COPY = path.join(sandbox, "backend/app/clinical_scores.py")
  // 导出脚本为了「档位是否真有转诊去向」要去读红旗权威里的 referral_departments（名册不另起一份）。
  // ⇒ 沙箱必须把它也放进去：**变异腿的红必须是变异造成的，不是沙箱缺件造成的**。
  // 一手（第一百零六轮入场核验抓到）：本件首版只拷了导出件与 clinical_scores.json，
  // 于是对照腿连同五条变异腿全部 ENOENT 而挂在一起 ⇒ `[GATE:clinical-score:fail] 40/46`，
  // 而那六条腿长得和「生成器真的拦住了」一模一样（rc≠0 且零写盘）——判据看着很严，牙齿从未被验过。
  // 整件复制而非在守卫里重写一份科室名册：子仓硬规矩「不要新增第二份真值」。
  cpSync(path.join(REPO, "..", "data", "red_flag_rules.json"), path.join(sandbox, "data", "red_flag_rules.json"))
  // 对照腿会真写出两份生成物；不清场，后面每条变异腿的「零写盘」断言读到的都是对照腿留下的文件，
  // 于是「生成器拦住了」和「生成器写出了半件」两种结果长得一模一样。
  const clearOut = () => { try { rmSync(JS_COPY, { force: true }); rmSync(PY_COPY, { force: true }) } catch { /* 沙箱件，删不掉即记入该腿的 detail */ } }

  // 对照腿：未变异的权威在副本里应当生成成功（证明下面的红是变异造成的，不是沙箱坏了）
  writeFileSync(authCopy, JSON.stringify(authority, null, 2))
  clearOut()
  const ctrl = spawnSync(process.execPath, [gen], { encoding: "utf8" })
  anti.push(["沙箱对照腿：未变异权威生成成功（rc=0）且两份生成物在场",
    ctrl.status === 0 && existsSync(JS_COPY) && existsSync(PY_COPY), `rc=${ctrl.status} ${ctrl.stdout}${ctrl.stderr}`])

  const mutations = [
    ["bands.min 超过满分 ⇒ 死档被拦", (m) => { m.scores[0].bands[0].min = 99 }, "永不可触发"],
    ["阈值写成字符串 ⇒ 两端形状分叉被拦", (m) => { m.scores[0].items[0].value = "22" }, "必须是数值"],
    // 注入点要撞**目标那条**检查，而不是先撞上更靠前的检查：上一版把 bands[1].min 改成 2，
    // 于是先触发 min>max（原 max 是 1）就退出了，重叠检查根本没被执行——红因对了但腿测错了对象。
    ["两个 band 区间重叠 ⇒ 双端可各取一档被拦", (m) => { m.scores[1].bands[1].max = 3 }, "区间重叠"],
    ["scores 清空 ⇒ 读空拒写被拦", (m) => { m.scores = [] }, "低于下限"],
    ["未声明顶层键 ⇒ 哑字段被拦", (m) => { m.oops = 1 }, "顶层未声明键"],
  ]
  for (const [name, mutate, needle] of mutations) {
    const m = JSON.parse(JSON.stringify(authority))
    mutate(m)
    writeFileSync(authCopy, JSON.stringify(m, null, 2))
    clearOut()
    const r = spawnSync(process.execPath, [gen], { encoding: "utf8" })
    const msg = `${r.stdout || ""}${r.stderr || ""}`
    // 三个断言：非零退出 + 点名原因 + **没写出任何生成物**（半件比红更坏）
    const noArtifact = !existsSync(JS_COPY) && !existsSync(PY_COPY)
    anti.push([`变异腿「${name}」rc≠0 且点名「${needle}」且零写盘`, r.status !== 0 && msg.includes(needle) && noArtifact, `rc=${r.status} 写盘=${!noArtifact} ⟵ ${msg.slice(0, 160)}`])
  }
} catch (e) {
  anti.push(["变异腿可执行", false, e.message])
} finally {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* 沙箱在 tmpdir，删不掉也不该把判据带崩 */ }
}
for (const [name, pass, detail] of anti) check(name, pass, detail || "")


const failed = rows.filter((r) => !r.pass)
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}${r.pass ? "" : `  ⟵ ${r.detail}`}`)
console.log(`[GATE:clinical-score:${failed.length ? "fail" : "pass"}] ${rows.length - failed.length}/${rows.length}｜权威 scores=${tableMod.SCORE_TABLES.length}｜fixture 用例=${fixture.cases.length}｜反例腿=${anti.length}`)
process.exit(failed.length ? 1 : 0)
