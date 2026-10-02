#!/usr/bin/env node
// docs 面承诺守卫（第八十九轮）
//
// 为什么立这条（一手实测，不是"peer 有所以我也要有"）：
//  本轮写 `docs/DEPLOY_RUNBOOK.md` 时，**先写了一个想当然的回滚命令**
//  `wrangler pages deployment rollback`，随后实测 `--help` 才发现该子命令**根本不存在**
//  （真实命令集只有 list / create / tail / delete）。若照原样发版，读者第一次回滚就会 wasted 一次真实事故。
//  ⇒ 反 R240「文档写了 ≠ 磁盘有」的**命令面**版本：路径存在性由 `scripts/docs_path_guard.py` 管，
//    本守卫管**可执行面**——文档里出现的「命令 token」必须在盘上真实可解析（文件存在 / npm script 存在 /
//    wrangler 子命令真实存在），否则判红。
//
// 三条口径（缺一即误报或漏报）：
//  1. **零输入即红**：一份 docs 面都没读到 ⇒ 取数面坏，绝不记"全部通过"。
//  2. **只认"声称可执行"的 token**：反引号里含路径且带已知扩展名的（path 形），
//     或以已知命令前缀开头的（cmd 形）。散文里的词、glob、带参数的模板不算。
//  3. **判定基准＝仓根**（相对本文件所在仓）。不接受"换个基目录再试"——那是把判据写成自比。
//
// 用法：node tests/docs_surface_guard.mjs [--selftest] [--json] [--faces docs]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FACES_DEFAULT = ['docs', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md'];
const EXTS = ['py', 'mjs', 'js', 'json', 'md', 'yml', 'yaml', 'toml', 'sh', 'ps1', 'txt'];
//: 命令前缀白名单：只查这些，避免把散文误判成命令
const CMD_PREFIX = ['npm run', 'npm test', 'node ', 'python ', 'pip ', 'git ', 'docker ', 'bash ', 'powershell ', 'curl ', 'npx ', 'wrangler '];

const BACKTICK = /`([^`\n]{2,200})`/g;
const TRAILING = /[，。；：、)）:;,.\s]+$/;

function strip(tok) { return String(tok).trim().replace(TRAILING, ''); }
/** path 形：含 /、以已知扩展名结尾、不含占位符与参数、不以绝对/相对引导符开头 */
function isPathish(tok) {
  if (!tok || /[*<>${}]/.test(tok) || / /.test(tok)) return false;
  // ⚠️ 不得写成 tok.startsWith('/', '~', './', '../')——JS 的 startsWith 只吃第一个参数，
  //    第二个起被静默忽略 ⇒ 整条越界防护形同虚设（自比恒等族：写了但永不生效）。
  if (['/', '~', './', '../'].some((p) => tok.startsWith(p))) return false;
  if (!tok.includes('/')) return false;
  return EXTS.includes(tok.slice(tok.lastIndexOf('.') + 1).toLowerCase());
}
/** cmd 形：以命令前缀开头且不是 path 形 */
function isCmdish(tok) {
  if (!tok || isPathish(tok)) return false;
  return CMD_PREFIX.some((p) => tok.startsWith(p));
}
/** 从 cmd token 里抽出「可执行面」候选：npm script 名 / wrangler 子命令 */
function cmdClaims(tok) {
  const out = [];
  const npm = tok.match(/^npm run ([\w:-]+)/);
  if (npm) out.push({ kind: 'npm-script', name: npm[1] });
  // 多空格容忍：`wrangler pages deploy  dist --project-name=x` 里 dist 是**位置参数**不是子命令，
  // 所以只认第一段；第二段仅在第一段是 deployment 时才作子命令核对（见 WRANGLER_SUBS2）。
  const pages = tok.match(/wrangler(?:\.js)?\s+pages\s+([\w-]+)(?:\s+([\w-]+))?/);
  if (pages) {
    out.push({ kind: 'wrangler-sub', name: `pages ${pages[1]}` });
    if (pages[1] === 'deployment' && pages[2]) {
      out.push({ kind: 'wrangler-sub2', name: `pages deployment ${pages[2]}` });
    }
  }
  return out;
}

function readFaces(faces) {
  const files = [];
  for (const f of faces) {
    const p = join(REPO, f);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p)) if (e.endsWith('.md')) files.push(join(p, e));
    } else files.push(p);
  }
  return files;
}

function npmScripts() {
  try { return Object.keys(JSON.parse(readFileSync(join(REPO, 'frontend/package.json'), 'utf8')).scripts || {}); }
  catch { return null; }
}
//: 实测命令集（`wrangler pages deployment --help` + `pages --help` 的输出口径）。
//: 一级：`pages deploy` / `pages dev` / `pages secret` / `pages deployment`；二级只在 deployment 下再核一次。
const WRANGLER_SUBS = new Set(['pages deploy', 'pages dev', 'pages secret', 'pages deployment',
  'secret put', 'secret list', 'pages secret put', 'pages secret list']);
//: 二级实测集：只有这四个（本轮一手证据：`rollback` **不在其中** ⇒ 写进文档会被本守卫判红）
const WRANGLER_SUBS2 = new Set(['pages deployment list', 'pages deployment create',
  'pages deployment tail', 'pages deployment delete']);

export function check(faces = FACES_DEFAULT) {
  const files = readFaces(faces);
  const scripts = npmScripts();
  const deadPaths = [];
  const deadCmds = [];
  let tokens = 0;
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const rel = relative(REPO, f).split('\\').join('/');
    for (const m of text.matchAll(BACKTICK)) {
      const tok = strip(m[1]);
      if (!tok) continue;
      if (isPathish(tok)) {
        tokens++;
        if (!existsSync(join(REPO, tok))) deadPaths.push(`${rel} -> ${tok}`);
      } else if (isCmdish(tok)) {
        for (const c of cmdClaims(tok)) {
          tokens++;
          if (c.kind === 'npm-script') {
            if (scripts === null) deadCmds.push(`${rel} -> npm run ${c.name}（读不到 frontend/package.json，取数面坏）`);
            else if (!scripts.includes(c.name)) deadCmds.push(`${rel} -> npm run ${c.name}（package.json 无此 script）`);
          } else if (c.kind === 'wrangler-sub' && !WRANGLER_SUBS.has(c.name)) {
            deadCmds.push(`${rel} -> wrangler ${c.name}（实测命令集里无此子命令）`);
          } else if (c.kind === 'wrangler-sub2' && !WRANGLER_SUBS2.has(c.name)) {
            deadCmds.push(`${rel} -> wrangler ${c.name}（实测命令集里无此子命令）`);
          }
        }
      }
    }
  }
  const empty = files.length ? [] : [`一个 docs 面都没读到：${faces.join(', ')}`];
  return { files: files.length, tokens, deadPaths: [...new Set(deadPaths)].sort(), deadCmds: [...new Set(deadCmds)].sort(), empty };
}

export function selftest() {
  const t = [];
  const ck = (n, ok, d = '') => t.push([n, !!ok, d]);
  // 解析层独立腿（不依赖盘）——把反例钉在函数上，而不是钉在注释里
  ck('isPathish：docs/DEPLOY_RUNBOOK.md 真路径形态为真', isPathish('docs/DEPLOY_RUNBOOK.md'));
  ck('isPathish：裸文件名不算（无斜杠）', !isPathish('README.md'));
  ck('isPathish：glob / 带参数 / 带占位符不算', !isPathish('docs/*.md') && !isPathish('npm run test') && !isPathish('a/${b}.md'));
  ck('isCmdish：npm run / node / git / 裸 wrangler 开头都算命令',
    isCmdish('npm run test') && isCmdish('git --no-pager tag') && isCmdish('node --version') && isCmdish('wrangler pages deploy dist'));
  ck('cmdClaims：裸 wrangler 形态也抽得到（本轮补的漏检面）',
    cmdClaims('wrangler pages deployment rollback').some((c) => c.kind === 'wrangler-sub2' && c.name === 'pages deployment rollback'));
  ck('isCmdish：path 形不算命令', !isCmdish('docs/PITFALLS.md'));
  ck('cmdClaims：抽出 npm-script', cmdClaims('npm run redflags:export')[0]?.name === 'redflags:export');
  ck('cmdClaims：抽出 wrangler 一级子命令（pages deployment）',
    cmdClaims('node node_modules/wrangler/bin/wrangler.js pages deployment list --project-name=x')
      .some((c) => c.kind === 'wrangler-sub' && c.name === 'pages deployment'));
  ck('cmdClaims：deployment 下再抽二级（list）',
    cmdClaims('node node_modules/wrangler/bin/wrangler.js pages deployment list')
      .some((c) => c.kind === 'wrangler-sub2' && c.name === 'pages deployment list'));
  ck('cmdClaims：`pages deploy  dist` 的 dist 是位置参数、不得升级成子命令',
    !cmdClaims('node node_modules/wrangler/bin/wrangler.js pages deploy  dist --project-name=x')
      .some((c) => c.kind === 'wrangler-sub2'));
  // 实测集反向腿：本轮真实踩到的不存在的子命令必须不在集合里
  ck('WRANGLER_SUBS2 不含 rollback（本轮一手踩坑点）', !WRANGLER_SUBS2.has('pages deployment rollback'));
  ck('WRANGLER_SUBS2 只含实测存在的四个', WRANGLER_SUBS2.size === 4 && WRANGLER_SUBS2.has('pages deployment list'));
  ck('isPathish：越界形态（./ ../ ~ /）一律不算（startsWith 多参陷阱的钉死腿）',
    !isPathish('./backend.cdx.json') && !isPathish('../x/y.md') && !isPathish('/abs/path.md') && !isPathish('~/a.md'));

  // 真实面
  const r = check();
  ck(`真实面：扫到 ${r.files} 个 docs 面、${r.tokens} 个可执行面 token`, r.files > 0 && r.tokens > 0, `files=${r.files} tokens=${r.tokens}`);
  ck('真实面：零死路径', r.deadPaths.length === 0, r.deadPaths.slice(0, 3).join(' | '));
  ck('真实面：零死命令（npm script / wrangler 子命令都在盘）', r.deadCmds.length === 0, r.deadCmds.slice(0, 3).join(' | '));
  // 零输入腿
  const z = check(['__no_such_face__']);
  ck('零输入：一个面都没读到 ⇒ 判取数面坏（不许记绿）', z.empty.length === 1 && z.tokens === 0, JSON.stringify(z.empty));

  const bad = t.filter(([, ok]) => !ok).length;
  for (const [n, ok, d] of t) console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' :: ' + String(d).slice(0, 80) : ''}`);
  console.log(`SELFTEST: ${t.length - bad}/${t.length}`);
  console.log(bad === 0 ? '[GATE:docs-surface-guard-selftest-pass]' : '[GATE:docs-surface-guard-selftest-fail]');
  return bad === 0 ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argSelftest = process.argv.includes('--selftest');
  const asJson = process.argv.includes('--json');
  const fi = process.argv.indexOf('--faces');
  const faces = fi >= 0 ? process.argv.slice(fi + 1) : FACES_DEFAULT;
  if (argSelftest) process.exit(selftest());
  const r = check(faces);
  if (asJson) {
    console.log(JSON.stringify({ files: r.files, tokens: r.tokens, deadPaths: r.deadPaths, deadCmds: r.deadCmds, empty: r.empty }));
  } else {
    console.log(`取数面＝${faces.join(', ')}｜读到 ${r.files} 个面｜可执行面 token ${r.tokens} 个`);
    for (const d of r.deadPaths) console.log(`  DEAD-PATH :: ${d}`);
    for (const d of r.deadCmds) console.log(`  DEAD-CMD  :: ${d}`);
    for (const e of r.empty) console.log(`  EMPTY     :: ${e}`);
  }
  if (r.empty.length || r.tokens === 0) { console.log('[GATE:docs-surface-guard-empty]'); process.exit(2); }
  const red = r.deadPaths.length + r.deadCmds.length;
  console.log(red === 0 ? '[GATE:docs-surface-guard-pass]' : '[GATE:docs-surface-guard-fail]');
  process.exit(red === 0 ? 0 : 1);
}


