#!/usr/bin/env node
// 评测读数溯源绑定（台账 #218，r86 立项、r89/r90 因内层在途阻塞未做）。
//
// 治的假账：README 与答辩里那句「31/31、P95 4602ms」挂不到任何一次构建上。
// 分工（禁造第二套尺）：读数**新不新**由 `work/freeze_check.mjs` 第 20 检判（比报告时刻与代码提交时刻）；
// 本件只答另一件事——这份读数是**哪一组输入字节**产的，以及哪个输入在报告之后变过。
// 对标：openai/evals 的 record+registry 三元组、promptfoo 的配置哈希、ragas 的 run_config、
// OHDSI WebAPI 的 design_hash（校验和不符就拒绝复用旧值，而不是静默用）。
//
// 用法：
//   node scripts/eval_provenance.mjs                      # 打印当前输入集指纹
//   node scripts/eval_provenance.mjs --verify <report>    # 复算并与报告内 provenance 对账
//   node scripts/eval_provenance.mjs --selftest           # 变异体反例（不写盘到被审对象）
// 退出码：0=绑定一致 / 1=不一致（含被篡改）/ 2=不可归因（报告无 provenance 或输入取不到）。
// 2 是独立态，不得折成 0：取不到证据 ≠ 证据合格。
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve, posix, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA = "doctor-ai-dx/eval-provenance/1";
// 依赖闭包从引擎入口沿 import 走，不手抄文件清单——手抄的清单会随重构过期（#106 同族）。
export const CLOSURE_ROOTS = ["frontend/functions/lib/engine.js"];
export const DATA_SOURCES = ["data/knowledge.json", "data/red_flag_rules.json", "data/scope_rules.json"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const toPosix = (p) => String(p).split("\\").join("/");
/** 一律收敛成仓内相对 posix 路径：绝对/相对两种写法不得在指纹里留下两种形（同一文件两个键＝第二真值）。 */
export function toRel(p, root = ROOT) {
  const s = toPosix(p);
  if (/^[A-Za-z]:\//.test(s) || s.startsWith("/")) {
    const r = toPosix(relative(root, resolve(root, s)));
    return r.startsWith("..") ? s : r;
  }
  return s;
}
export function shaOfPath(prov, p, root = ROOT) {
  const k = toRel(p, root);
  const hit = (prov.inputs || []).find((i) => toRel(i.path, root) === k);
  return hit ? hit.sha256 : null;
}

/** 沿相对 import 走闭包；只认 from/import 后接相对路径（本仓 lib 内部全用 ./x.js）。 */
export function importClosure(roots, read) {
  const seen = new Set();
  const stack = [...roots];
  const unreadable = [];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let src;
    try { src = read(rel); } catch { unreadable.push(rel); continue; }
    for (const m of toPosix(src).matchAll(/(?:from|import)\s+["'](\.\/[^"']+)["']/g)) {
      const next = posix.normalize(posix.join(posix.dirname(rel), m[1]));
      if (!seen.has(next)) stack.push(next);
    }
  }
  return { files: [...seen].sort(), unreadable };
}

/**
 * 被评测输入集 = 引擎 import 闭包 ∪ 知识与规则的单一源 JSON ∪ 用例集 ∪ runner 自身。
 * 取不到的项记 read_error 且 sha 为 null，**不折成空串**（空串会和「真取了个空文件」同形）。
 */
export function buildProvenance({ casesPath, runnerPath, root = ROOT, at = new Date().toISOString() } = {}) {
  const read = (rel) => readFileSync(resolve(root, rel));
  const { files: closure, unreadable } = importClosure(CLOSURE_ROOTS, read);
  const paths = [...new Set([
    ...closure, ...DATA_SOURCES,
    casesPath ? toRel(casesPath, root) : null,
    runnerPath ? toRel(runnerPath, root) : null,
  ].filter(Boolean))].sort();
  const inputs = paths.map((p) => {
    try {
      const buf = read(p);
      return { path: p, sha256: sha256(buf), bytes: buf.length };
    } catch (e) {
      return { path: p, sha256: null, bytes: 0, read_error: String(e.message).slice(0, 120) };
    }
  });
  return {
    schema: SCHEMA,
    produced_at: at,
    inputs,
    // 归属锚点：读数是相对哪个提交产的、当时工作树还脏几件（脏件多到覆盖输入集时，这份读数只能算在途态）。
    git: gitInfo(root),
    // 聚合哈希按 path:sha 排序行拼接：与单个文件顺序无关，且任一项为 null 时整串标 UNBOUND。
    input_set_sha256: inputs.some((i) => i.sha256 === null)
      ? null
      : sha256(Buffer.from(inputs.map((i) => `${i.path}:${i.sha256}`).join("\n"), "utf8")),
    closure_unreadable: unreadable,
  };
}

/** 与报告里已记录的 provenance 对账：逐项比，缺项/多项/改字节各有各的形。 */
export function verifyProvenance(recorded, current) {
  const out = { fail: false, state: "BOUND", bad: [], missing_in_report: [], new_since_report: [] };
  if (!recorded || !Array.isArray(recorded.inputs)) {
    // UNBOUND 也必须带齐展示层要读的四个键：上一版这里只返回 bad，门面行取 new_since_report.length
    // 直接 TypeError，判据在**自己最该说话的那条路**上崩掉，退出码还从 2 被改写成一串栈轨迹后的 1。
    return { fail: true, state: "UNBOUND", bad: ["报告不含 provenance.inputs ⇒ 该读数不可归因到任何一组输入字节"], new_since_report: [], missing_in_report: [] };
  }
  const cur = new Map(current.inputs.map((i) => [i.path, i]));
  const rec = new Map(recorded.inputs.map((i) => [i.path, i]));
  for (const [p, c] of cur) {
    const r = rec.get(p);
    if (!r) { out.new_since_report.push(p); continue; }
    if (c.sha256 === null || r.sha256 === null) { out.bad.push(`${p}：取数字节失败（${c.read_error || r.sha256 === null ? "sha 缺失" : ""}），不得判绿`); continue; }
    if (c.sha256 !== r.sha256) out.bad.push(`${p}：报告记 ${String(r.sha256).slice(0, 12)} 现算 ${String(c.sha256).slice(0, 12)}`);
  }
  for (const p of rec.keys()) if (!cur.has(p)) out.missing_in_report.push(p);
  if (recorded.input_set_sha256 && current.input_set_sha256
    && recorded.input_set_sha256 !== current.input_set_sha256) {
    out.bad.push(`input_set_sha256 不等：报告 ${String(recorded.input_set_sha256).slice(0, 12)} 现算 ${String(current.input_set_sha256).slice(0, 12)}`);
  }
  // 刻意不设「只新增项」这种中间档：聚合哈希按整个输入集算，集合一变它必变，
  // 留一个永远进不去的状态等于留一处永久失明（Declared-never-filled 反例）。增删都算不符，只是理由不同。
  if (out.new_since_report.length) out.bad.push(`现算输入集有报告里没有的新项（新增依赖或换了产数人）：${out.new_since_report.join(", ")}`);
  if (out.missing_in_report.length) out.bad.push(`报告里有而现算输入集取不到（被删或口径变了）：${out.missing_in_report.join(", ")}`);
  out.fail = out.bad.length > 0;
  if (out.fail) out.state = "MISMATCH";
  return out;
}

function gitInfo(root = ROOT) {
  const errs = [];
  const run = (args) => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
    // 失败原因必须留下：git 不在 PATH（工具缺失）与「这里不是 git 仓」是两件事，
    // 都吞成 head=null 的话，取数面坏了和没归属会被读成同一个值。
    catch (e) { errs.push(`${e.name}: ${String(e.message).split("\n")[0].slice(0, 70)}`); return null; }
  };
  const head = run(["rev-parse", "HEAD"]);
  const dirty = head === null ? null
    : run(["status", "--porcelain", "--untracked-files=no"])?.split("\n").filter(Boolean)
      .map((l) => toPosix(l.slice(1).trim())).filter(Boolean) ?? [];
  return { head, dirty_count: dirty === null ? null : dirty.length, dirty, ...(head === null ? { unavailable_reason: errs[0] || "unknown" } : {}) };
}

// ---------------- selftest ----------------
function selftest() {
  const t = [];
  const ck = (n, c) => t.push([n, c === true]);
  const at = "2026-10-03T00:00:00.000Z";
  const fake = { "a.js": 'import { b } from "./dir/b.js"\nimport "./c.js"', "dir/b.js": "export const b=1", "c.js": "" };
  const read = (rel) => { if (!(rel in fake)) throw new Error("ENOENT " + rel); return fake[rel]; };
  const cl = importClosure(["a.js"], read);
  ck("闭包沿相对 import 走全（含子目录，排序按字节序 c.js < dir/b.js）", cl.files.join(",") === "a.js,c.js,dir/b.js" && cl.unreadable.length === 0);
  ck("闭包去重且顺序稳定（同一输入集必得同一聚合哈希）", JSON.stringify(importClosure(["a.js"], read).files) === JSON.stringify(cl.files));
  const cyc = { "x.js": 'import "./y.js"', "y.js": 'import "./x.js"' };
  ck("循环 import 不死循环", importClosure(["x.js"], (r) => { if (!(r in cyc)) throw new Error("no"); return cyc[r]; }).files.length === 2);

  const tmp = join(os.tmpdir(), `evalprov-selftest-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "frontend/functions/lib"), { recursive: true });
  mkdirSync(join(tmp, "data"), { recursive: true });
  const w = (p, s) => writeFileSync(join(tmp, p), s, "utf8");
  w("frontend/functions/lib/engine.js", 'import { r } from "./rules.js"\n');
  w("frontend/functions/lib/rules.js", "export const r=1\n");
  w("data/knowledge.json", "{}\n");
  w("data/red_flag_rules.json", "{}\n");
  w("data/scope_rules.json", "{}\n");
  w("cases.json", "[]\n");
  w("runner.mjs", "// runner\n");
  const base = buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at });
  ck("真面：输入集＝引擎闭包2＋数据源3＋用例＋runner＝7 且聚合哈希可算", base.inputs.length === 7 && /^[0-9a-f]{64}$/.test(String(base.input_set_sha256)));
  ck("非 git 目录下 head/dirty 记 null（取不到归属锚点不得折成「干净」）", base.git.head === null && base.git.dirty_count === null);
  // 正向腿：在真仓里 head 必须是 40 位提交号。第九十一轮实测漏 import execFileSync 时，
  // git 块整片 null 而判据一声不响——只有正向断言能抓住「工具没接到」这种形态。
  const real = buildProvenance({ casesPath: "frontend/tests/fixtures/eval_cases.json", runnerPath: "scripts/run_eval.mjs" });
  ck("真仓面：head 取到 40 位提交号、闭包≥5 件、聚合哈希可算", /^[0-9a-f]{40}$/.test(String(real.git.head)) && real.inputs.length >= 5 && /^[0-9a-f]{64}$/.test(String(real.input_set_sha256)));
  ck("真仓面：引擎闭包真的走通了（rules.js 与 knowledge.js 都在输入集里）", real.inputs.some((i) => i.path.endsWith("lib/rules.js")) && real.inputs.some((i) => i.path.endsWith("lib/knowledge.js")));
  const again = buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at });
  ck("同一组字节复算必得同一聚合哈希（幂等）", again.input_set_sha256 === base.input_set_sha256);
  const v0 = verifyProvenance(base, again);
  ck("未改动 ⇒ BOUND 且零不符", v0.fail === false && v0.state === "BOUND" && v0.bad.length === 0);
  // 同一文件的绝对/相对两种写法必须收敛成一个键，否则 provenance 里会出现两条同字节的假项
  const abs = buildProvenance({ casesPath: join(tmp, "cases.json"), runnerPath: join(tmp, "runner.mjs"), root: tmp, at });
  ck("绝对路径与相对路径入集同形（指纹与聚合值都不变）", abs.input_set_sha256 === base.input_set_sha256 && abs.inputs.length === base.inputs.length);
  ck("shaOfPath 两种写法取到同一个值", shaOfPath(base, join(tmp, "cases.json"), tmp) === shaOfPath(base, "cases.json", tmp) && shaOfPath(base, "cases.json", tmp) !== null);
  ck("shaOfPath 查不存在的项返回 null（不折成空串）", shaOfPath(base, "nope.json", tmp) === null);
  // 变异体 M1：改被评测代码一个字节 ⇒ 该项必须被点名，聚合哈希必须变
  w("frontend/functions/lib/rules.js", "export const r=2\n");
  const mut = buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at });
  const v1 = verifyProvenance(base, mut);
  ck("M1 篡改引擎依赖字节 ⇒ 判红并点名该文件", v1.fail === true && v1.bad.some((s) => s.includes("rules.js")));
  // 变异体 M2：用例集被换（条数可以不变）⇒ 只有哈希抓得到
  w("cases.json", '[{"id":"ev-01"}]\n');
  const v2 = verifyProvenance(base, buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at }));
  ck("M2 换用例内容 ⇒ 判红并点名 cases", v2.fail === true && v2.bad.some((s) => s.includes("cases.json")));
  // 变异体 M3：报告根本没有 provenance ⇒ UNBOUND，且不得与「一致」同形
  const v3 = verifyProvenance(undefined, base);
  ck("M3 报告无 provenance ⇒ UNBOUND（不是 BOUND、也不是 0）", v3.fail === true && v3.state === "UNBOUND");
  // 变异体 M4：换了产数人（runner）而字节没动 ⇒ 新增项＋缺项都要具名，且不许判绿
  w("runner2.mjs", "// other producer\n");
  const m4 = verifyProvenance(base, buildProvenance({ casesPath: "cases.json", runnerPath: "runner2.mjs", root: tmp, at }));
  ck("M4 换 runner ⇒ 判红且新项与缺项双向具名", m4.fail === true && m4.new_since_report.includes("runner2.mjs") && m4.missing_in_report.includes("runner.mjs"));
  // 变异体 M4b：新增依赖同时改动了入口 ⇒ 篡改项与新项都要出现（缺项档不得掩盖字节改动）
  w("frontend/functions/lib/newdep.js", "export const n=1\n");
  w("frontend/functions/lib/engine.js", 'import { r } from "./rules.js"\nimport { n } from "./newdep.js"\n');
  const v4 = verifyProvenance(base, buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at }));
  ck("M4b 新依赖同时改了入口 ⇒ 判红、新项具名、入口字节也被点名", v4.fail === true && v4.new_since_report.includes("frontend/functions/lib/newdep.js") && v4.bad.some((s) => s.includes("engine.js")));
  // 变异体 M5：文件被删 ⇒ sha 取不到，必须是 read_error 形态而不是空哈希
  rmSync(join(tmp, "data/knowledge.json"), { force: true });
  const m5 = buildProvenance({ casesPath: "cases.json", runnerPath: "runner.mjs", root: tmp, at });
  const gone = m5.inputs.find((i) => i.path === "data/knowledge.json");
  ck("M5 输入文件缺失 ⇒ sha=null 且聚合哈希判 UNBOUND", gone.sha256 === null && m5.input_set_sha256 === null);
  rmSync(tmp, { recursive: true, force: true });
  ck("夹具不在被审对象测量面上（临时目录已回收）", existsSync(tmp) === false);
  // 反例腿 M6：本件被 import 时不得执行 CLI。第九十一轮实测——顶层裸 `await main()` 让导入方
  // 在 import 的一刻被 process.exit(0) 带走，runner 只吐一段 provenance JSON 就结束且退出码为 0，
  // 比崩溃更难发现（判据自己造出一个假绿）。子进程实跑才算证到接线，不是只证函数。
  let importAlive = false;
  try {
    const out = execFileSync(process.execPath, ["-e",
      `import(${JSON.stringify(pathToFileURL(resolve(ROOT, "scripts/eval_provenance.mjs")).href)}).then(() => console.log("IMPORT-ALIVE"));`],
      { encoding: "utf8", timeout: 30000 });
    importAlive = out.includes("IMPORT-ALIVE") && !out.includes('"input_set_sha256"');
  } catch { importAlive = false; }
  ck("M6 被 import 时不跑 CLI、不把导入方 exit 掉（子进程实跑）", importAlive);
  // M7：接线面（CLI 子进程）也要过一遍——M3 只喂纯函数时全绿，真 CLI 却在 UNBOUND 那条路上
  // TypeError 崩掉、rc 被写成 1（第九十一轮实测）。函数对 ≠ 接线对，两向都得量。
  const cliDir = join(os.tmpdir(), `evalprov-cli-${process.pid}`);
  mkdirSync(cliDir, { recursive: true });
  const spawnCli = (args) => {
    try { return { rc: 0, out: execFileSync(process.execPath, [resolve(ROOT, "scripts/eval_provenance.mjs"), ...args], { encoding: "utf8" }) }; }
    catch (e) { return { rc: e.status == null ? 9 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  const unboundRep = join(cliDir, "unbound.json");
  writeFileSync(unboundRep, JSON.stringify({ total_cases: 1 }), "utf8");
  const u = spawnCli(["--verify", unboundRep]);
  ck("M7 CLI 面：报告无 provenance ⇒ 印 unbound 且 rc=2（不崩、不折成 1）", u.rc === 2 && u.out.includes("[GATE:evalprov-unbound]") && !u.out.includes("TypeError"));
  rmSync(cliDir, { recursive: true, force: true });

  const pass = t.filter(([, ok]) => ok).length;
  for (const [n, ok] of t) console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
  console.log(`\n[GATE:evalprov-${pass === t.length ? "pass" : "fail"}] EVALPROV SELFTEST ${pass}/${t.length}`);
  process.exit(pass === t.length ? 0 : 1);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();
  const casesRel = "frontend/tests/fixtures/eval_cases.json";
  const runnerIdx = argv.findIndex((a) => a === "--runner");
  const runnerRel = runnerIdx >= 0 ? toPosix(argv[runnerIdx + 1]) : "scripts/run_eval.mjs";
  const prov = buildProvenance({ casesPath: casesRel, runnerPath: runnerRel, root: ROOT });
  const verifyIdx = argv.findIndex((a) => a === "--verify");
  if (verifyIdx < 0) {
    console.log(JSON.stringify(prov, null, 2));
    process.exit(prov.input_set_sha256 ? 0 : 2);
  }
  const reportPath = argv[verifyIdx + 1];
  let rep = null;
  try { rep = JSON.parse(readFileSync(resolve(reportPath), "utf8")); } catch (e) {
    console.log(`[GATE:evalprov-unbound] 报告取不到或解析失败：${e.message.slice(0, 100)} ⇒ 不判绿`);
    process.exit(2);
  }
  const res = verifyProvenance(rep.provenance, prov);
  // 三态各归各位：一致=0／被篡改或不符=1／不可归因=2。**不可归因不得折成 1**（那是"抓到造假"），
  // 也不得折成 0（那是"证据合格"）。
  const tag = res.state === "UNBOUND" ? "unbound" : res.fail ? "red" : "pass";
  console.log(`[GATE:evalprov-${tag}] state=${res.state}｜核 ${prov.inputs.length} 项｜不符 ${res.bad.length}｜新增 ${res.new_since_report.length}｜报告缺项 ${res.missing_in_report.length}｜input_set=${String(prov.input_set_sha256 ?? "UNBOUND").slice(0, 12)}｜git_head=${prov.git.head ? prov.git.head.slice(0, 7) : "不可测"}｜工作树相对 HEAD 已改 ${prov.git.dirty_count === null ? "不可测" : prov.git.dirty_count} 件`);
  for (const b of res.bad) console.log(`  FAIL ${b}`);
  process.exit(res.state === "UNBOUND" ? 2 : res.fail ? 1 : 0);
}
// 只在**被直接执行**时跑 CLI。本件同时是被 run_eval/live_eval import 的库：模块顶层无条件执行 main
// 会让导入方在 import 那一刻被 process.exit(0) 带走（第九十一轮实测踩过——现象是 runner 只吐出
// 一段 provenance JSON 就结束，评测一行没跑，退出码还是 0，比崩了更难发现）。
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
