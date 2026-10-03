#!/usr/bin/env node
// load_probe.mjs — 本地并发/负载探针（第 98 轮 H-3）
//
// 为什么要有这个件（对标依据，非推演）
//   `work/bench-r98/peer-facts-20261003.json`：`samply/blaze` 有 `modules/load-test`、
//   `openemr/openemr` 有 `docker/container_benchmarking`，**都在仓内**。
//   我方并发读数（VU8 / 185 req/s，见 memory/AGENTS §05）来自
//   `work/load_probe_local.mjs` —— 而 `work/` 属于**项目根仓**，`doctor-ai-dx-mvp/`
//   是**独立 git 仓**（实测 `.git` 存在）。⇒ 外部 clone `doctor-ai-dx` 的人拿不到并发守门，
//   AGENTS 宣称的读数**不可由第三方复算**。这是「文档写了 ≠ 磁盘有/可取」的 R240 同族。
//   本件把探针搬进公开仓并给它三态退出码，使该读数可复算。
//
// 三条硬线
//   1. **三态不折叠**：PASS / WARN / FAIL / UNVERIFIED 四态，缺一不可。
//      base 不可达 ⇒ UNVERIFIED，**不得**折成「没测出问题 = 通过」。
//   2. **advisory 不成闸**：本件是独立命令，不进 release 阻断链；
//      但 CI 里跑它时 WARN 只打印、FAIL 才退 1（口径写在 --help 与本注释）。
//   3. **默认不联网**：`--selftest` 完全离线；实跑必须显式给 `--base`，否则退 2（用法错）。
//
// 用法：
//   node scripts/load_probe.mjs --selftest
//   node scripts/load_probe.mjs --base http://127.0.0.1:8788 --vu 8 --duration 20
//   node scripts/load_probe.mjs --base <线上地址> --vu 8 --duration 20 --json
// 退出码：0 PASS/WARN（advisory）｜1 FAIL 或 UNVERIFIED（结构失败）｜2 用法错误
// 末行 [GATE:load-pass|warn|fail] 是唯一权威读数

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 阈值单一出处。与 scripts/observe_slo_check.mjs 的 SLO 分工：
//   observe_slo_check ＝ **单请求时延**（对线上报告产物）
//   load_probe        ＝ **并发下的吞吐/错误率**（对活端点）
// 两者不共享阈值表，避免一处改动同时动两个语义。
export const LOAD_SLO = {
  min_rps: 20,            // 吞吐地板：低于此值判 FAIL（VU8 实测 185 req/s，余量充足）
  max_error_rate: 0.02,   // 错误率上限 2%
  max_p95_ms: 10000,      // 并发下 P95 不得超过项目约束的 10s
  warn_error_rate: 0.005, // 0.5% 起进 WARN 区间（早报警，不等撞线）
};

// 纯函数：探针结果 → 判定。离线可驱动，故能被变异测试双向断言。
export function judge(r, slo = LOAD_SLO) {
  const checks = [];
  const add = (n, state, got, want, msg) => checks.push({ name: n, state, got, want, msg });

  if (!r || typeof r !== 'object' || r.reachable !== true) {
    add('base 可达', 'UNVERIFIED', r && r.reachable ? true : (r ? 'false' : '无结果'),
      'true', 'base 不可达 ⇒ 无任何吞吐/时延读数，不折成「没问题」');
    return summarize(checks, r);
  }
  add('base 可达', 'PASS', r.base, 'reachable', '');
  if (!Number.isFinite(Number(r.requests)) || Number(r.requests) < 1) {
    add('请求数可读', 'UNVERIFIED', r.requests, '>=1', '没有成功发出的请求 ⇒ 无从判吞吐');
    return summarize(checks, r);
  }
  add('请求数可读', 'PASS', r.requests, '>=1', '');
  if (!Number.isFinite(Number(r.vu)) || Number(r.vu) < 1) {
    add('VU 可读', 'UNVERIFIED', r.vu, '>=1', '并发度不可读 ⇒ 不得声称任何吞吐数');
    return summarize(checks, r);
  }

  const rps = Number(r.rps), err = Number(r.error_rate), p95 = Number(r.p95_ms);
  if (![rps, err, p95].every(Number.isFinite)) {
    add('指标可读', 'UNVERIFIED', JSON.stringify({ rps: r.rps, error_rate: r.error_rate, p95_ms: r.p95_ms }),
      'number', '任一指标缺失/非数 ⇒ 三态不折叠，判 UNVERIFIED');
    return summarize(checks, r);
  }
  add('指标可读', 'PASS', true, true, '');

  // 吞吐不能先于错误率判：全部请求失败时会获得一个很大的“拒绝/s”，
  // 若先报了它，读者会当成“吞吐很高”（实为 100% 错误）。故不可达与高错误率一律先判不可达。
  if (err >= 1) {
    add('吞吐读数可否声称', 'FAIL', `${rps.toFixed(1)} req/s`, '不否认',
      `错误率 100% ⇒ 这个“${rps.toFixed(1)} req/s”是拒绝数而非吞吐，禁当吞吐读数引用`);
    add('吞吐 ≥ 地板', 'FAIL', `${rps.toFixed(1)} req/s`, `>= ${slo.min_rps}`, '全部失败时不可声称吞吐');
  } else {
    add('吞吐 ≥ 地板', rps >= slo.min_rps ? 'PASS' : 'FAIL', +rps.toFixed(1), `>= ${slo.min_rps}`,
      `${rps.toFixed(1)} req/s（VU=${r.vu}，时长 ${r.duration_s}s，样本 ${r.requests}）`);
  }
  if (err > slo.max_error_rate) add('错误率 ≤ 上限', 'FAIL', +(err * 100).toFixed(2) + '%', `<= ${slo.max_error_rate * 100}%`, '');
  else if (err > slo.warn_error_rate) add('错误率 ≤ 上限', 'WARN', +(err * 100).toFixed(2) + '%', `<= ${slo.max_error_rate * 100}%`, `进 WARN 区间（>${slo.warn_error_rate * 100}%，早报警）`);
  else add('错误率 ≤ 上限', 'PASS', +(err * 100).toFixed(2) + '%', `<= ${slo.max_error_rate * 100}%`, '');
  add('并发 P95 ≤ 预算', p95 <= slo.max_p95_ms ? 'PASS' : 'FAIL', +p95.toFixed(0), `<= ${slo.max_p95_ms}`,
    `并发下 P95 ${p95.toFixed(0)}ms 对项目约束 ${slo.max_p95_ms}ms`);
  return summarize(checks, r);
}

function summarize(checks, r) {
  const fail = checks.filter((c) => c.state === 'FAIL');
  const warn = checks.filter((c) => c.state === 'WARN');
  const unver = checks.filter((c) => c.state === 'UNVERIFIED');
  const state = fail.length ? 'FAIL' : (unver.length ? 'UNVERIFIED' : (warn.length ? 'WARN' : 'PASS'));
  return { state, rc: (fail.length || unver.length) ? 1 : 0, checks, raw: r || null };
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

// 可达性必须**单独探**，不能从 VU 循环里推。
// 一手实测（2026-10-04）：第一版没单探，对 `http://127.0.0.1:9`（无服务）跑出了
// 「速名 43939 req/s｜P95 0ms｜100% 错误率」——传递循环完成了，所以 reachable=true。
// 那个“吞吐”数字是每次立即失败的拒绝数，**不是吞吐读数**，却被写成了吞吐读数。
async function preflight(base, path) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(base.replace(/\/$/, '') + path, { signal: ctl.signal });
    clearTimeout(to);
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: String(e.message).slice(0, 160) };
  }
}

async function probe(base, vu, durationS, path) {
  const t0 = Date.now();
  const lat = [];
  let ok = 0, err = 0;
  const stop = t0 + durationS * 1000;
  const worker = async () => {
    while (Date.now() < stop) {
      const s = Date.now();
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 15000);
        const res = await fetch(base.replace(/\/$/, '') + path, { signal: ctl.signal });
        clearTimeout(to);
        await res.arrayBuffer();
        if (res.ok) ok += 1; else err += 1;
      } catch { err += 1; }
      lat.push(Date.now() - s);
    }
  };
  await Promise.all(Array.from({ length: vu }, worker));
  const dur = (Date.now() - t0) / 1000;
  const total = ok + err;
  return {
    base, vu, duration_s: +dur.toFixed(2), requests: total,
    rps: dur > 0 ? +(total / dur).toFixed(2) : 0,
    error_rate: total ? +(err / total).toFixed(4) : 1,
    p50_ms: pct(lat, 0.5), p95_ms: pct(lat, 0.95), max_ms: lat.length ? Math.max(...lat) : NaN,
    ok, err, path,
  };
}

function selftest() {
  const t = [];
  const ck = (n, c) => t.push([n, !!c]);
  const good = { reachable: true, base: 'http://x', vu: 8, duration_s: 20, requests: 3700, rps: 185, error_rate: 0, p95_ms: 900, path: '/' };
  ck('基线（VU8/185 req/s/0 错）判过', judge(good).state === 'PASS', judge(good).state);
  ck('基线 rc=0', judge(good).rc === 0);

  // 腿1：base 不可达 ⇒ UNVERIFIED（**不得**折成 PASS）
  const down = judge({ reachable: false, base: 'http://x' });
  ck('base 不可达 ⇒ UNVERIFIED', down.state === 'UNVERIFIED', down.state);
  ck('base 不可达 ⇒ rc=1', down.rc === 1);
  ck('无结果对象 ⇒ UNVERIFIED', judge(null).state === 'UNVERIFIED');
  // 腿2：请求数为 0 ⇒ UNVERIFIED（不是「零错误所以好」）
  ck('requests=0 ⇒ UNVERIFIED', judge({ ...good, requests: 0 }).state === 'UNVERIFIED');
  // 腿3：吞吐低于地板 ⇒ FAIL
  ck('rps=5 ⇒ FAIL', judge({ ...good, rps: 5 }).state === 'FAIL');
  // 腿4：错误率分层：0.2% PASS / 1% WARN / 5% FAIL
  ck('err=0.2% ⇒ PASS', judge({ ...good, error_rate: 0.002 }).state === 'PASS');
  ck('err=1% ⇒ WARN', judge({ ...good, error_rate: 0.01 }).state === 'WARN', judge({ ...good, error_rate: 0.01 }).state);
  ck('err=5% ⇒ FAIL', judge({ ...good, error_rate: 0.05 }).state === 'FAIL');
  ck('WARN 的 rc 仍为 0（advisory 不成闸）', judge({ ...good, error_rate: 0.01 }).rc === 0);
  // 腿5：并发 P95 超预算 ⇒ FAIL
  ck('p95=12s ⇒ FAIL', judge({ ...good, p95_ms: 12000 }).state === 'FAIL');
  // 腿6：指标缺失 ⇒ UNVERIFIED（不折成 0）
  ck('rps 缺失 ⇒ UNVERIFIED', judge({ ...good, rps: undefined }).state === 'UNVERIFIED');
  // 腿7：阈值可注入（阈值必须在判据侧，不在被测体里）
  ck('放宽阈值后基线仍过', judge(good, { ...LOAD_SLO, min_rps: 0, max_p95_ms: 999999 }).state === 'PASS');
  ck('收紧阈值后基线转红', judge(good, { ...LOAD_SLO, min_rps: 999999 }).state === 'FAIL');
  // 腿8：VU 不可读 ⇒ UNVERIFIED
  ck('vu=0 ⇒ UNVERIFIED', judge({ ...good, vu: 0 }).state === 'UNVERIFIED');
  // 腿9（本轮一手实测追加）：全失败时不得声称吞吐，否则会印出「拒绝/s」假读数
  const allFail = judge({ ...good, rps: 43939, error_rate: 1, requests: 40000, p95_ms: 0 });
  ck('全失败时 ≨䎓9 req/s 不被声称为吞吐', allFail.state === 'FAIL', allFail.state);
  ck('全失败时有「禁当吞吐读数引用」的具名红因',
    allFail.checks.some((c) => c.msg && c.msg.includes('禁当吞吐读数引用')));

  const pass = t.filter(([, ok]) => ok).length;
  for (const [n, ok] of t) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  console.log(`\nLOAD-SELFTEST ${pass === t.length ? 'PASS' : 'FAIL'} (${pass}/${t.length})`);
  process.exit(pass === t.length ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else {
  const a = process.argv.slice(2);
  const get = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const base = get('--base', null);
  if (!base) {
    console.error('[load] 未给 --base ⇒ 用法错误（默认不联网）。离线自检用 --selftest。');
    process.exit(2);
  }
  const vu = Number(get('--vu', '8'));
  const duration = Number(get('--duration', '20'));
  const path = get('--path', '/api/health');
  const asJson = a.includes('--json');

  const pf = await preflight(base, path);
  let raw;
  if (!pf.reachable) {
    raw = { base, vu, reachable: false, error: pf.error };
  } else {
    raw = await probe(base, vu, duration, path);
    raw.reachable = true;
    raw.preflight_status = pf.status;
  }
  const v = judge(raw);
  if (asJson) { console.log(JSON.stringify(v, null, 1)); process.exit(v.rc); }
  if (!raw.reachable) {
    console.log(`🔌 负载探针 ｜ base=${base} **不可达**（${raw.error || '连接失败'}）`);
    console.log(`[GATE:load-fail] UNVERIFIED｜无可用读数 ⇒ 不折成「没问题」｜rc=1`);
    process.exit(1);
  }
  console.log(`🔌 负载探针 ｜ base=${base}${path} ｜ VU=${raw.vu} ｜ 时长 ${raw.duration_s}s`);
  const claimed = raw.error_rate < 1;
  console.log(`   请求 ${raw.requests}（ok ${raw.ok} / err ${raw.err}）｜${claimed ? `吞吐 ${raw.rps} req/s` : '吞吐 **不可声称**（全部失败）'}｜P50 ${raw.p50_ms}ms P95 ${raw.p95_ms}ms max ${raw.max_ms}ms`);
  for (const c of v.checks) {
    const mark = { PASS: '✅', FAIL: '❌', WARN: '⚠️', UNVERIFIED: '⚠' }[c.state] || '·';
    console.log(`   ${mark} ${c.name}: 实得 ${c.got}｜要求 ${c.want}${c.msg ? ' — ' + c.msg : ''}`);
  }
  const tag = v.state === 'PASS' ? 'pass' : (v.state === 'WARN' ? 'warn' : 'fail');
  console.log(`[GATE:load-${tag}] ${v.state}｜rc=${v.rc}｜${claimed ? `${raw.rps} req/s` : '吞吐不可声称'}｜错误率 ${(raw.error_rate * 100).toFixed(2)}%｜P95 ${raw.p95_ms}ms`);
  process.exit(v.rc);
}