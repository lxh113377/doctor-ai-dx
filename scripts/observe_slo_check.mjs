#!/usr/bin/env node
// observe_slo_check.mjs — 性能/可观测 SLO 判据（第 98 轮 H-2）
//
// 为什么要有这个件（对标依据，非推演）
//   `work/bench-r98/self-facts-20261003.json` 的十面痕迹里我方 `observability` 命中的 2 条
//   **全是假阳性**（`.github/workflows/dep-audit.yml` 是依赖审计、CHANGELOG.md 含 "audit"）；
//   代码级复核：真实只有 `frontend/functions/lib/observe.js`（3,420B），**没有 metrics/SLO 面**。
//   对照 `samply/blaze` 有 11 条：`modules/monitoring`、`modules/metrics`、
//   `modules/jvm-metrics-logger`、`modules/db-tx-log`、`modules/terminology-service`…
//   而我方 P95=4,602ms 目前只是 `eval_report_live.json` 里的一个数，**不是判据**：
//   改坏了没人知道，等线上出事才知道。这是对标 blaze「指标闭环」形态的最小补齐。
//
// 三条硬线（每条都有方向相反的反例腿，见 --selftest）
//   1. **样本不足判 UNVERIFIED，不判过**。n<10 ⇒ 结论无效（unavailable ≠ zero，同 r89 补条 A）
//   2. **缺字段判 UNVERIFIED，不折成 0**。0ms 会让所有阈值都"通过"，是最危险的假绿
//   3. **只读已入库产物**。本件不跑线上、不改报告；它只是让那个数变成会红的判据
//
// 用法：node scripts/observe_slo_check.mjs [--report <path>] [--json] [--selftest]
// 退出码：0 通过 / 1 判红或 UNVERIFIED（结构失败）/ 2 用法错误
// 末行 [GATE:slo-pass|fail] 是唯一权威读数
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MVP = resolve(HERE, '..');

// 阈值单一出处。项目约束出处：memory/06-constraints.md「单次模型硬超时 8 秒；
// 线上正常链路 P95 ≤10 秒」。改这里必须同时改那份记忆，否则就是两把尺。
export const SLO = {
  min_sample_n: 10,          // 低于此样本量只报 UNVERIFIED
  p95_budget_ms: 10000,      // 项目约束：线上正常链路 P95 ≤10s
  model_hard_timeout_ms: 8000, // 项目约束：单次模型硬超时 8s
  min_margin_ratio: 0.25,    // P95 距硬超时至少留 25% 余量
  require_live_purity: true, // 报告须为 live 模式（rule_fallback=0）才声称线上读数
};

// 纯函数：报告对象 → 判定。**不碰盘、不联网**，所以能被离线变异测试驱动。
export function judge(report, slo = SLO) {
  const checks = [];
  const add = (name, state, got, want, msg) => checks.push({ name, state, got, want, msg });

  if (!report || typeof report !== 'object') {
    add('输入可读', 'UNVERIFIED', typeof report, 'object', '报告不是对象或为空 ⇒ 不猜阈值');
    return summarize(checks);
  }
  const dx = report.dx_latency_ms;
  if (!dx || typeof dx !== 'object') {
    add('dx_latency_ms 存在', 'UNVERIFIED', dx === undefined ? '缺失' : '形状异常', 'object',
      '缺该字段 ⇒ 不折成 0ms（0 会让所有阈值都通过，是最危险的假绿）');
    return summarize(checks);
  }
  add('dx_latency_ms 存在', 'PASS', true, true, '');

  const n = Number(dx.n);
  if (!Number.isFinite(n)) {
    add('样本量可读', 'UNVERIFIED', dx.n, 'number', 'n 不可读 ⇒ 不得声称任何分位数');
    return summarize(checks);
  }
  add('样本量可读', 'PASS', n, 'number', '');
  if (n < slo.min_sample_n) {
    add('样本量充分', 'UNVERIFIED', n, `>=${slo.min_sample_n}`,
      `样本 n=${n} < ${slo.min_sample_n} ⇒ 分位数不可声称（unavailable ≠ zero）`);
    return summarize(checks);
  }
  add('样本量充分', 'PASS', n, `>=${slo.min_sample_n}`, '');

  // ⚠ `Number(null)===0` 且是有限数 ⇒ 直接 `Number.isFinite(Number(x))` 会把
  // **缺失值当成 0ms 放行**，那是最危险的假绿（0 小于一切阈值）。故先拒空再转数。
  const num = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v));
  for (const k of ['p50', 'p95', 'max']) {
    if (!Number.isFinite(num(dx[k]))) {
      add(`${k} 可读`, 'UNVERIFIED', dx[k] === null ? 'null' : (dx[k] === undefined ? '缺失' : dx[k]), 'number',
        `${k} 缺失/null/非数 ⇒ 下游全部不判（Number(null)=0 会被当成"0ms 通过"，必须先拒空）`);
      return summarize(checks);
    }
  }
  add('分位数齐全', 'PASS', true, true, '');

  const p50 = num(dx.p50), p95 = num(dx.p95), mx = num(dx.max);
  add('P95 ≤ 预算', p95 <= slo.p95_budget_ms ? 'PASS' : 'FAIL', p95, `<= ${slo.p95_budget_ms}`,
    `P95 ${p95}ms 对 ${slo.p95_budget_ms}ms 预算`);
  add('max < 模型硬超时', mx < slo.model_hard_timeout_ms ? 'PASS' : 'FAIL', mx, `< ${slo.model_hard_timeout_ms}`,
    `max ${mx}ms 对硬超时 ${slo.model_hard_timeout_ms}ms（撞线即降级，不是"刚好"）`);

  const margin = 1 - p95 / slo.model_hard_timeout_ms;
  add('P95 余量充足', margin >= slo.min_margin_ratio ? 'PASS' : 'FAIL',
    +(margin * 100).toFixed(1), `>= ${slo.min_margin_ratio * 100}%`,
    `P95 ${p95}ms 距硬超时余量 ${(margin * 100).toFixed(1)}%（阈值 ${slo.min_margin_ratio * 100}%）`);

  if (slo.require_live_purity) {
    const md = report.mode_distribution;
    if (!md || typeof md !== 'object') {
      add('live 纯度可读', 'UNVERIFIED', md === undefined ? '缺失' : '形状异常', 'object',
        '无 mode_distribution ⇒ 不能声称这是线上读数（可能整份都是 rule-fallback）');
    } else {
      const fb = Number(md.rule_fallback || 0);
      add('live 纯度', fb === 0 ? 'PASS' : 'FAIL', `rule_fallback=${fb}`, 'rule_fallback=0',
        fb === 0 ? '全样本为 live 模式' : `含 ${fb} 例降级，时延不是纯线上读数`);
    }
  }
  // 只报不拦的结构面（与既有裁定一致：结构性读数异常须让人看见，但不单独当闸）
  const structured = typeof report.structure_pass === 'string' ? report.structure_pass : null;
  if (structured) add('结构通过率（只报）', 'INFO', structured, 'n/n', '非 SLO 项，随行供对账');
  return summarize(checks);
}

function summarize(checks) {
  const fail = checks.filter((c) => c.state === 'FAIL');
  const unver = checks.filter((c) => c.state === 'UNVERIFIED');
  // 三态不折叠：UNVERIFIED 既不算过也不算红在 rc 上，但**不得**印 PASS
  const state = fail.length ? 'FAIL' : (unver.length ? 'UNVERIFIED' : 'PASS');
  return {
    state,
    rc: fail.length || unver.length ? 1 : 0,
    metrics: Object.fromEntries(checks.filter((c) => c.name.startsWith('P95') || c.name.startsWith('max')).map((c) => [c.name, c.got])),
    checks,
  };
}

export const DEFAULT_REPORT = join(MVP, '..', 'iCAN大学生创新创业大赛', '03-评测', 'eval_report_live.json');

function selftest() {
  const t = [];
  const ck = (n, c) => t.push([n, !!c]);
  const base = { dx_latency_ms: { n: 31, p50: 3810, p95: 4602, max: 5074 }, mode_distribution: { live: 31, rule_fallback: 0 }, structure_pass: '31/31' };

  ck('基线读数判过（P95 4.6s / max 5.07s / n=31 / 纯 live）', judge(base).state === 'PASS');
  ck('基线 rc=0', judge(base).rc === 0);

  // 腿1：样本不足 ⇒ UNVERIFIED，**不得判过**（unavailable ≠ zero）
  const small = { ...base, dx_latency_ms: { n: 6, p50: 3590, p95: 4199, max: 4199 } };
  const js = judge(small);
  ck('n=6 ⇒ UNVERIFIED', js.state === 'UNVERIFIED', js.state);
  ck('n=6 ⇒ rc=1（不得判过）', js.rc === 1);
  ck('n=6 不报 PASS 结论', js.checks.some((c) => c.state === 'UNVERIFIED' && c.name === '样本量充分'));

  // 腿2：缺字段 ⇒ UNVERIFIED，**不折成 0ms**
  const missing = { ...base }; delete missing.dx_latency_ms;
  const jm = judge(missing);
  ck('缺 dx_latency_ms ⇒ UNVERIFIED', jm.state === 'UNVERIFIED', jm.state);
  ck('缺字段时不产生任何 PASS 阈值项', !jm.checks.some((c) => c.name.includes('P95 ≤')));

  // 腿3：p95 超预算 ⇒ FAIL
  ck('P95 超 10s ⇒ FAIL', judge({ ...base, dx_latency_ms: { n: 31, p50: 9000, p95: 11000, max: 12000 } }).state === 'FAIL');
  // 腿4：max 撞硬超时 ⇒ FAIL（"刚好"不算过）
  ck('max＝硬超时 ⇒ FAIL', judge({ ...base, dx_latency_ms: { n: 31, p50: 3810, p95: 4602, max: 8000 } }).state === 'FAIL');
  ck('max 超硬超时 ⇒ FAIL', judge({ ...base, dx_latency_ms: { n: 31, p50: 3810, p95: 4602, max: 9000 } }).state === 'FAIL');
  // 腿5：余量不足 ⇒ FAIL（P95 7.5s ⇒ 余量 6.25% < 25%）
  ck('P95 7.5s 余量薄 ⇒ FAIL', judge({ ...base, dx_latency_ms: { n: 31, p50: 7000, p95: 7500, max: 7900 } }).state === 'FAIL');
  // 腿6：非 live 纯度 ⇒ FAIL（不能拿降级样本的时延当线上读数）
  ck('含 rule_fallback ⇒ FAIL', judge({ ...base, mode_distribution: { live: 30, rule_fallback: 1 } }).state === 'FAIL');
  // 腿7：空输入 ⇒ UNVERIFIED 而非 PASS
  ck('空报告 ⇒ UNVERIFIED', judge(null).state === 'UNVERIFIED');
  ck('空报告 ⇒ rc=1', judge(null).rc === 1);
  // 腿8：P95 分位非数 ⇒ UNVERIFIED（不参与比较）
  ck('p95 为 null ⇒ UNVERIFIED', judge({ ...base, dx_latency_ms: { n: 31, p50: 1, p95: null, max: 5 } }).state === 'UNVERIFIED');
  // 腿9：阈值可注入（防阈值写死在被测体里）
  const loose = judge(base, { ...SLO, p95_budget_ms: 999999, min_margin_ratio: 0, model_hard_timeout_ms: 999999 });
  ck('放宽阈值后基线仍过（证明阈值确在判据侧）', loose.state === 'PASS');
  // 腿10：只报项不得改变三态
  const infoOnly = judge({ ...base, structure_pass: '30/31' });
  ck('structure_pass 变差不改三态（只报不拦）', infoOnly.state === 'PASS', infoOnly.state);

  const pass = t.filter(([, ok]) => ok).length;
  for (const [n, ok] of t) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
  console.log(`\nSLO-SELFTEST ${pass === t.length ? 'PASS' : 'FAIL'} (${pass}/${t.length})`);
  process.exit(pass === t.length ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else {
  const args = process.argv.slice(2);
  const rp = args.includes('--report') ? args[args.indexOf('--report') + 1] : DEFAULT_REPORT;
  const asJson = args.includes('--json');
  if (!existsSync(rp)) {
    console.error(`[slo] 报告不可达: ${rp}\n       ⇒ 判 UNVERIFIED，不折成"无问题"`);
    process.exit(1);
  }
  let report = null;
  try { report = JSON.parse(readFileSync(rp, 'utf8')); } catch (e) {
    console.error(`[slo] 解析失败: ${e.message} ⇒ 判 UNVERIFIED`);
    process.exit(1);
  }
  const v = judge(report);
  if (asJson) { console.log(JSON.stringify(v, null, 1)); process.exit(v.rc); }
  const d = report.dx_latency_ms || {};
  console.log(`📈 性能 SLO 判据 ｜ 报告 ${rp}`);
  console.log(`   日期 ${report.date || '(无)'}｜base ${report.base || '(无)'}｜dx n=${d.n} p50=${d.p50} p95=${d.p95} max=${d.max}`);
  console.log(`   阈值 P95≤${SLO.p95_budget_ms}ms ｜硬超时 ${SLO.model_hard_timeout_ms}ms ｜余量≥${SLO.min_margin_ratio * 100}% ｜最小样本 n≥${SLO.min_sample_n}`);
  for (const c of v.checks) {
    const mark = { PASS: '✅', FAIL: '❌', UNVERIFIED: '⚠', INFO: 'ℹ️' }[c.state] || '·';
    console.log(`   ${mark} ${c.name}: 实得 ${c.got}｜要求 ${c.want}${c.msg ? ' — ' + c.msg : ''}`);
  }
  console.log(`[GATE:slo-${v.state === 'PASS' ? 'pass' : 'fail'}] ${v.state}｜rc=${v.rc}｜P95=${d.p95}ms 余量=${(100 * (1 - d.p95 / SLO.model_hard_timeout_ms)).toFixed(1)}%`);
  process.exit(v.rc);
}