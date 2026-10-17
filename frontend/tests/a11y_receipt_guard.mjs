#!/usr/bin/env node
// 前端可访问性／国际化／跨浏览器矩阵面收据（第九十四轮高-1，第一百一十二轮搬进本仓并接入 npm test）。
//
// 对标：axe-core（可访问性规则引擎）、react-spectrum（无障碍组件库）、js-lingui（i18n）、
// Playwright（跨浏览器矩阵）。前 93 轮没照过这一面，而它对本项目**不是装饰**：
// 使用者是基层医生（含年长者、诊室强光、触屏），而产品红线要求全界面常驻「辅助参考·医生终审」。
//
// 分工（不造第二把尺）：本件只做**静态可读的结构性事实**；运行期可访问性（真实 contrast、
// 焦点顺序、屏幕阅读器语义）要 axe 注入浏览器才测得到，那半登记为 #248，不在这里冒充结论。
// 只读：扫描对象是本仓，本件不写生产面任何字节。
//
// 【第一百一十二轮为什么搬进来并挂进 npm test】
//   一手：本件原住父仓 `work/bench-r94/`，实测 `git ls-files` 反查**零引用**——没有一条阻断链在跑它，
//   于是 r94 立它时抓出的 6 个 GAP 里，`high_contrast` 与 `scalable_type` 在一年内谁改都没人再核。
//   这正是「有判据 ≠ 判据在跑」的同族（r107-13／r110-1／r111-2）；搬到本仓 tests/ 并进 `npm test` 第 45 段，
//   判据才第一次进执行路径。外部 clone 的人现在也能跑：`node tests/a11y_receipt_guard.mjs`。
//
// 用法：node frontend/tests/a11y_receipt_guard.mjs [--json] [--root <内层仓路径>] [--selftest]
// 退出码：0=全部 MET｜1=有确证 GAP｜2=有 UNVERIFIED（取不到 ≠ 没有，也 ≠ 合格）。
import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
// 本件住 <仓根>/frontend/tests/ ⇒ 仓根 = 上两级（第九十四轮住在父仓 work/bench-r94/，路径形态随之变）
const DEFAULT_ROOT = resolve(HERE, "..", "..");
export const SCHEMA = "doctor-ai-dx/frontend-a11y-receipt/1";
const UN = "UNVERIFIED", MET = "MET", GAP = "GAP";

// 已知缺口名册（第一百一十二轮）：这两项是**产品决策**不是缺陷——
//   · i18n_surface：本项目只做中文单语种（参赛交付面），引入 i18n 抽象层是纯成本；
//   · browser_matrix：验收口径定义为「桌面 1440 + 移动 390 双视口」，不是跨浏览器矩阵（COMPATIBILITY §1）。
// 它们进名册的含义是「已如实登记在 docs/COMPATIBILITY.md」，不是「已解决」；
// 棘轮规则：名册只准收缩——某天真做了就把它从这里删掉（死豁免会被 selftest 那条腿抓出来）。
export const KNOWN_GAPS = new Set(["i18n_surface", "browser_matrix"]);

const item = (id, 问句, state, evidence, recompute_cmd) => ({ id, 问句, state, evidence, recompute_cmd });

/** 分母来自 git 结构枚举（不是 grep 命中数）；git 取不到 ⇒ 整个收据 UNVERIFIED。 */
function listSource(root) {
  const gitDir = join(root, ".git");
  if (existsSync(gitDir)) {
    try {
      const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "frontend/src", "frontend/index.html", "frontend/playwright.config.mjs"], { encoding: "utf8" });
      const files = out.split("\0").filter(Boolean).map((f) => f.split("/").join(sep));
      return { files: files.filter((f) => existsSync(join(root, f))), via: "git ls-files", ok: true };
    } catch (e) { return { files: [], via: null, ok: false, err: String(e.message).split("\n")[0].slice(0, 90) }; }
  }
  // 非 git 目录（夹具面）：按目录递归取，仍算「结构枚举」，但来源要在 evidence 里写清
  const acc = [];
  const walk = (d) => { if (!existsSync(d)) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(jsx?|tsx?|css|html|mjs)$/i.test(e.name)) acc.push(p.slice(root.length + 1)); } };
  walk(join(root, "frontend"));
  return { files: acc, via: "walk(frontend)", ok: acc.length > 0, err: acc.length ? undefined : "frontend 面为空" };
}

const read = (root, rel) => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };
const count = (src, re) => (src.match(re) || []).length;

export function buildReceipt(root) {
  const l = listSource(root);
  if (!l.ok) return { schema: SCHEMA, generated_at: new Date().toISOString(), scanned_root: root, state: UN, counts: { MET: 0, GAP: 0, UNVERIFIED: 1 }, items: [item("source_face", "取数面是否可枚举", UN, `分母取不到：${l.err || l.via || "无文件"} ⇒ 全单不可判`, `git -C ${root} ls-files -- frontend/src`)], recompute_cmd: `node frontend/tests/a11y_receipt_guard.mjs --root ${root}` };

  // UI 源面只算 `frontend/src/**`：playwright.config 是配置件，混进来会把「界面里的中文串」
  // 数成「含配置文案」，分母与被扫对象不同形。
  const js = l.files.filter((f) => /^frontend[\\/]src[\\/]/.test(f) && /\.(jsx?|tsx?|mjs)$/i.test(f));
  const css = l.files.filter((f) => /^frontend[\\/]src[\\/]/.test(f) && /\.css$/i.test(f));
  const html = l.files.filter((f) => /index\.html$/i.test(f));
  const body = (files) => files.map((f) => read(root, f) || "").join("\n");
  const srcJs = body(js), srcCss = body(css), srcHtml = body(html);
  const pkgRaw = read(root, "frontend/package.json");
  const pkg = pkgRaw ? (() => { try { return JSON.parse(pkgRaw); } catch { return null; } })() : null;
  const deps = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }) : [];
  const items = [];

  items.push(item("html_lang", "文档根是否声明 lang",
    srcHtml.length === 0 ? UN : /<html[^>]*\slang=/i.test(srcHtml) ? MET : GAP,
    `index.html 取到 ${html.length} 个；lang 声明 ${count(srcHtml, /<html[^>]*\slang=/gi)} 处`,
    `grep -n "<html" ${join(root, "frontend/index.html")}`));

  const motion = count(srcCss, /prefers-reduced-motion/gi);
  items.push(item("reduced_motion", "是否尊重系统「减少动效」偏好",
    css.length === 0 ? UN : motion > 0 ? MET : GAP,
    `CSS ${css.length} 个｜prefers-reduced-motion ${motion} 处`,
    `grep -rn "prefers-reduced-motion" ${join(root, "frontend/src")}`));

  const contrast = count(srcCss, /prefers-contrast|forced-colors/gi);
  items.push(item("high_contrast", "是否有高对比度／强制颜色档",
    css.length === 0 ? UN : contrast > 0 ? MET : GAP,
    `prefers-contrast 或 forced-colors ${contrast} 处`,
    `grep -rnE "prefers-contrast|forced-colors" ${join(root, "frontend/src")}`));

  const remish = count(srcCss, /font-size:\s*[0-9.]+(rem|em|clamp|vw)|clamp\(/gi);
  const pxish = count(srcCss, /font-size:\s*[0-9.]+px/gi);
  items.push(item("scalable_type", "字号是否可随用户设置缩放（rem/clamp 而非纯 px）",
    css.length === 0 ? UN : remish > 0 ? MET : GAP,
    `font-size px 写法 ${pxish} 处｜rem/em/clamp 写法 ${remish} 处`,
    `grep -rnE "font-size:\\s*[0-9.]+(px|rem)" ${join(root, "frontend/src")}`));

  const imgAll = count(srcJs, /<img\b/gi);
  const imgAlt = count(srcJs, /<img\b[^>]*\salt=/gis);
  items.push(item("img_alt", "图标/图片是否有可访问名（alt）",
    imgAlt >= imgAll ? MET : GAP, // 0 个 img ⇒ 无缺项，判 MET 并在证据里写「不适用」（不得把「没有该面」报成缺陷）
    `<img> ${imgAll} 处｜带 alt ${imgAlt} 处${imgAll === 0 ? "（不适用：界面无 img）" : imgAll > imgAlt ? ` ⇒ 缺 ${imgAll - imgAlt} 处` : "（全覆盖）"}`,
    `grep -rn "<img" ${join(root, "frontend/src")}`));

  // 【第一百一十二轮修方向缺陷】旧写法是两条方向相反的正则：
  //   clickNoRole   = /<(div|span|p|li)\b[^>]*\sonClick/          —— onClick 在任意位置都算
  //   clickWithRole = /<(div|span|p|li)\b[^>]*\sonClick[^>]*\srole=/ —— role 必须在 onClick **之后**
  // 于是 `role="button" ... onClick=`（role 在前）被算成「无 role」⇒ 真按规范写的元素被判 GAP。
  // 一手实测：CaseSelect.jsx 的病例卡本来就是 `role="button" tabIndex={0} onClick`，收据却一直印「带 role 0 处」。
  // 改成**按标签整体取属性**：同一标签内出现 onClick 与 role 即配对，与书写顺序无关（顺序不是语义）。
  // 这是「判据方向错了比没有判据更坏」的第三例（前两例：r111 并发加速比 3×、r107 照抄处方造恒红）。
  const tagAttrs = [...srcJs.matchAll(/<(div|span|p|li)\b([^>]*)>/gi)].map((m) => m[2]);
  const clickTags = tagAttrs.filter((a) => /\sonClick\b/i.test(a));
  const clickNoRole = clickTags.length;
  const clickWithRole = clickTags.filter((a) => /\srole=/i.test(a)).length;
  items.push(item("noninteractive_click", "可点击元素是否用了有语义的控件（div/span 带 onClick 是反例）",
    clickNoRole === 0 ? MET : (clickNoRole > clickWithRole ? GAP : MET),
    `div/span/p/li 带 onClick ${clickNoRole} 处｜其中带 role ${clickWithRole} 处`,
    `grep -rnE "<(div|span)[^>]*onClick" ${join(root, "frontend/src")}`));

  const landmarks = count(srcJs, /<(main|nav|header|footer|section)\b/gi) + count(srcJs, /role="(main|navigation|banner|contentinfo)"/gi);
  items.push(item("landmarks", "是否有地标语义（main/nav/header 或等价 role）",
    srcJs.length === 0 ? UN : landmarks > 0 ? MET : GAP,
    `地标元素或等价 role ${landmarks} 处`,
    `grep -rnE "<(main|nav|header|footer)|role=(main|navigation)" ${join(root, "frontend/src")}`));

  const a11yDep = deps.filter((d) => /axe-core|jsx-a11y|react-aria|@adobe\/react-spectrum|eslint-plugin-jsx-a11y/i.test(d));
  items.push(item("a11y_toolchain", "是否接入可访问性工具链（axe / jsx-a11y / react-aria 任一）",
    pkg === null ? UN : a11yDep.length > 0 ? MET : GAP,
    `依赖清单 ${deps.length} 项｜可访问性相关 ${a11yDep.length} 项${a11yDep.length ? `（${a11yDep.join(",")}）` : " ⇒ 无自动可访问性检查面"}`,
    `grep -nE "axe-core|jsx-a11y|react-aria" ${join(root, "frontend/package.json")}`));

  const i18nDep = deps.filter((d) => /i18next|react-i18next|intl|lingui|formatjs|react-intl/i.test(d));
  const cjk = count(srcJs, /["'`][^"'`\n]*[一-龥][^"'`\n]*["'`]/g);
  items.push(item("i18n_surface", "界面文案是否走 i18n 抽象层",
    pkg === null ? UN : i18nDep.length > 0 ? MET : GAP,
    `i18n 依赖 ${i18nDep.length} 项；源码内联中文串 ${cjk} 处（无抽象层时全部是硬编码）`,
    `grep -rnE "i18n|intl|lingui" ${join(root, "frontend/package.json")}`));

  const pw = read(root, "frontend/playwright.config.mjs") || "";
  const projects = count(pw, /name:\s*["'][^"']+["']/g);
  const browsers = count(pw, /chromium|firefox|webkit/gi);
  items.push(item("browser_matrix", "E2E 是否覆盖多浏览器（projects 矩阵）",
    // 只认 projects 矩阵：chromium/firefox/webkit 三个词可能只出现在 devices 或注释里，
    // 拿它当「跨浏览器已覆盖」就是一张假绿（第九十四轮真面实测正是这个形状）。
    pw.length === 0 ? UN : projects >= 2 ? MET : GAP,
    `playwright.config 内 projects name 条目 ${projects} 个（矩阵判据）｜浏览器关键字 ${browsers} 处（只作旁证，不算覆盖）`,
    `grep -nE "projects|chromium|firefox|webkit|name:" ${join(root, "frontend/playwright.config.mjs")}`));

  const counts = { MET: 0, GAP: 0, UNVERIFIED: 0 };
  items.forEach((i) => { counts[i.state] += 1; });
  const state = counts[UN] > 0 ? UN : counts[GAP] > 0 ? GAP : MET;
  return { schema: SCHEMA, generated_at: new Date().toISOString(), scanned_root: root, via: l.via, denominator: { js: js.length, css: css.length, html: html.length }, state, counts, items, recompute_cmd: `node frontend/tests/a11y_receipt_guard.mjs --root ${root}` };
}

function selftest() {
  const t = [];
  const ck = (n, ok) => t.push([n, ok === true]);
  const tmp = join(os.tmpdir(), `a11y-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "frontend", "src"), { recursive: true });
  const w = (p, s) => writeFileSync(join(tmp, p), s, "utf8");
  w("frontend/index.html", '<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');
  w("frontend/src/App.jsx", 'export default function A(){return (<main><img src="a.png" alt="示例"/><div onClick={()=>{}}>点</div></main>)}');
  w("frontend/src/a.css", ".x{font-size:1rem}@media (prefers-reduced-motion: reduce){.x{animation:none}}@media (prefers-contrast: more){.x{color:#000}}");
  w("frontend/package.json", JSON.stringify({ dependencies: { "@axe-core/playwright": "^4" }, devDependencies: { "eslint-plugin-jsx-a11y": "^6" } }));
  w("frontend/playwright.config.mjs", 'export default { projects: [{ name: "chromium" }, { name: "firefox" }, { name: "webkit" }] };');
  w("frontend/src/Bad.jsx", 'export default function B(){return (<span onClick={()=>{}}>x</span>)}');

  const r = buildReceipt(tmp);
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  ck("分母由结构枚举（2 个 jsx 都进分母，不是一句话概括）", r.denominator.js === 2 && r.via === "walk(frontend)");
  ck("lang 在场 ⇒ MET", by.html_lang.state === MET);
  ck("reduced-motion／高对比度／rem 字号三项 MET（真在场的项不得被误报）", by.reduced_motion.state === MET && by.high_contrast.state === MET && by.scalable_type.state === MET);
  ck("div/span 带 onClick 且无 role ⇒ GAP 并给出处数", by.noninteractive_click.state === GAP && /2 处/.test(by.noninteractive_click.evidence));
  ck("i18n 面：无依赖但有内联中文 ⇒ GAP 且报内联串数", by.i18n_surface.state === GAP && /内联中文串 \d+ 处/.test(by.i18n_surface.evidence));
  ck("三浏览器矩阵 ⇒ MET", by.browser_matrix.state === MET);
  ck("M1 把 lang 去掉 ⇒ 该项必转 GAP（判据不是写死的绿）", (() => { w("frontend/index.html", "<html><body></body></html>"); const x = buildReceipt(tmp); return Object.fromEntries(x.items.map((i) => [i.id, i])).html_lang.state === GAP; })());
  ck("M2 img 缺 alt ⇒ 该项转 GAP", (() => { w("frontend/src/App.jsx", 'export default function A(){return (<main><img src="a.png"/><span onClick={()=>{}}>x</span></main>)}'); const x = buildReceipt(tmp); return Object.fromEntries(x.items.map((i) => [i.id, i])).img_alt.state === GAP; })());
  ck("M3 取数面为空 ⇒ UNVERIFIED 且聚合不判绿", (() => { const e = join(tmp, "empty"); mkdirSync(join(e, "frontend", "src"), { recursive: true }); const x = buildReceipt(e); return x.state === UN && x.items.length === 1 && x.items[0].id === "source_face"; })());
  ck("M4 依赖清单缺失 ⇒ 相关项 UNVERIFIED 而不是「没装＝GAP」", (() => { rmSync(join(tmp, "frontend", "package.json"), { force: true }); const x = buildReceipt(tmp); const b = Object.fromEntries(x.items.map((i) => [i.id, i])); return b.a11y_toolchain.state === UN && b.i18n_surface.state === UN; })());
  rmSync(tmp, { recursive: true, force: true });
  ck("夹具建在 OS 临时目录、不在被扫对象上动手，且已回收", existsSync(tmp) === false);
  const real = buildReceipt(DEFAULT_ROOT);
  ck("真仓面：10 项、每项带 recompute_cmd、state 落在三态闭集内", real.items.length === 10 && real.items.every((i) => !!i.recompute_cmd && [MET, GAP, UN].includes(i.state)));
  ck("真仓面：走的是 git ls-files（分母口径与被提交面一致）", real.via === "git ls-files");
  // 【第一百一十二轮】方向缺陷的回归腿：role 写在 onClick **之前** 必须被算作「有 role」。
  //   旧正则要求 role 在 onClick 之后 ⇒ 这条腿在旧实现上会 FAIL（反例腿，防止方向被改回去）。
  ck("role 在前 onClick 在后 ⇒ 仍算有 role（方向缺陷回归腿）", (() => {
    const d2 = join(os.tmpdir(), `a11y-dir-${process.pid}`);
    rmSync(d2, { recursive: true, force: true });
    mkdirSync(join(d2, "frontend", "src"), { recursive: true });
    writeFileSync(join(d2, "frontend/index.html"), "<html lang=\"zh\"></html>");
    writeFileSync(join(d2, "frontend/src/A.jsx"), 'export default function A(){return (<main><div role="button" tabIndex={0} onClick={()=>{}}>x</div></main>)}');
    writeFileSync(join(d2, "frontend/package.json"), JSON.stringify({ dependencies: {}, devDependencies: { "eslint-plugin-jsx-a11y": "^6" } }));
    const x = buildReceipt(d2);
    const b = Object.fromEntries(x.items.map((i) => [i.id, i]));
    rmSync(d2, { recursive: true, force: true });
    return b.noninteractive_click.state === MET && /带 role 1 处/.test(b.noninteractive_click.evidence);
  })());
  // 【第一百一十二轮】棘轮：known_gaps 只准收缩，不许新增 —— 判据一挂进 npm test 就会有人
  //   用「把 GAP 加进白名单」的方式让它变绿；白名单本身要受管（新增条目即红）。
  ck(`已知缺口棘轮：GAP 集合 ⊆ known_gaps（当前 ${real.counts.GAP} 项）`,
    real.items.filter((i) => i.state === GAP).map((i) => i.id).every((id) => KNOWN_GAPS.has(id)));
  ck("known_gaps 名册非空且每条仍在 GAP 态（死豁免会被抓出来）",
    KNOWN_GAPS.size > 0 && [...KNOWN_GAPS].every((id) => real.items.some((i) => i.id === id && i.state === GAP)));

  const pass = t.filter(([, ok]) => ok).length;
  for (const [n, ok] of t) console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
  console.log(`\n[GATE:a11yrec-${pass === t.length ? "pass" : "fail"}] SELFTEST ${pass}/${t.length}`);
  process.exit(pass === t.length ? 0 : 1);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return selftest();
  const ri = argv.findIndex((a) => a === "--root");
  const r = buildReceipt(ri >= 0 ? resolve(argv[ri + 1]) : DEFAULT_ROOT);
  const openIds = r.items.filter((i) => i.state === GAP).map((i) => i.id);
  const newly = openIds.filter((id) => !KNOWN_GAPS.has(id));
  // 末行闸名必须如实反映「是新增缺口还是已登记缺口」：把已知 GAP 印成 pass 是假绿，
  // 把已知 GAP 印成 gap 又会让每次提交都红（= 恒红噪声，判据失去意义）。故分四态命名。
  const gate = r.state === UN ? "unverified" : newly.length ? "newgap" : r.state === GAP ? "ratchet" : "pass";
  console.log(`[GATE:a11yrec-${gate}] state=${r.state}｜MET ${r.counts.MET}｜GAP ${r.counts.GAP}（已知 ${openIds.length - newly.length}／新增 ${newly.length}）｜UNVERIFIED ${r.counts.UNVERIFIED}｜分母=${JSON.stringify(r.denominator || {})}｜取数=${r.via || "n/a"}`);
  for (const i of r.items) console.log(`  ${i.state === MET ? "OK  " : i.state === GAP ? "GAP " : "UNK "} ${i.id}｜${i.问句}｜${i.evidence}`);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  // 退出码四态（不折叠）：0=全 MET 或 GAP 全部落在 known_gaps 内｜1=出现**新增** GAP（棘轮被撞破）｜2=UNVERIFIED（取不到 ≠ 没有）
  const openGaps = r.items.filter((i) => i.state === GAP).map((i) => i.id);
  const newGaps = openGaps.filter((id) => !KNOWN_GAPS.has(id));
  const dead = [...KNOWN_GAPS].filter((id) => !openGaps.includes(id));
  console.log(`[a11y] 已知缺口 ${openGaps.length} 项（named: ${openGaps.join(",") || "无"}）｜新增 ${newGaps.length}${newGaps.length ? "：" + newGaps.join(",") : ""}｜死豁免 ${dead.length}${dead.length ? "：" + dead.join(",") : ""}`);
  if (r.state === UN) process.exit(2);
  process.exit(newGaps.length || dead.length ? 1 : 0);
}
main();
