# 可观测性与性能 SLO

> 2026-10-04 新增（对标 `samply/blaze` 的 `modules/metrics` + `modules/monitoring` 形态）。
> 起因：八维开源对标实测我方 `observability` 结构痕迹**命中的 2 条全是假阳性**
> （`dep-audit.yml` 是依赖审计、`CHANGELOG.md` 含 "audit"），真实只有
> `frontend/functions/lib/observe.js`（3,420B）—— **P95 时延此前只是报告里的一个数，不是会红的判据**。

## 一、三条硬线

1. **样本不足判 `UNVERIFIED`，不判过**。`n < 10` 时任何分位数都不可声称
   （`unavailable ≠ zero`：不可测与"测了是 0"是相反的两件事）。
2. **缺字段判 `UNVERIFIED`，不折成 0**。`Number(null) === 0` 且是有限数 ——
   缺失值若被当成 `0ms`，会让**所有**阈值"通过"，那是最危险的假绿。判据里先拒空再转数。
3. **只读已入库产物**。本面不跑线上、不改报告；它只负责让那个数变成会红的判据。

## 二、两条判据的分工（阈值不共享）

| 判据 | 量什么 | 取数面 | 阈值表 |
|---|---|---|---|
| `scripts/observe_slo_check.mjs` | **单请求时延**（P50/P95/max） | live 评测报告（**仓外**：项目根仓的评测目录） | `SLO`：P95 ≤ 10,000ms、硬超时 8,000ms、余量 ≥ 25%、n ≥ 10、live 纯度 |
| `scripts/load_probe.mjs` | **并发下的吞吐/错误率** | 活端点（`--base` + `--path`） | `LOAD_SLO`：吞吐 ≥ 20 req/s、错误率 ≤ 2%（>0.5% 进 WARN）、并发 P95 ≤ 10,000ms |

> 两张表**刻意不合并**：一处改动同时动「单请求时延」与「并发吞吐」两个语义，
> 就是本项目台账 #168「两份尺」的同族病。

## 三、阈值出处（唯一真相源）

| 阈值 | 值 | 出处 |
|---|---|---|
| 单次模型硬超时 | 8,000ms | 项目记忆《06 已知约束》「性能/兼容性约束」（**仓外文件，本仓解析不到，故不写路径**） |
| 线上正常链路 P95 | ≤ 10,000ms | 同上 |
| 最小样本量 n | 10 | 本判据自定（低于此分位数不可声称） |
| P95 余量下限 | 25% | 本判据自定（余量过薄＝降级风险未暴露） |

改阈值必须**同时**改项目记忆《06 已知约束》的「性能/兼容性约束」节（该文件在**仓外**，
本仓解析不到），否则就是两把尺。

## 四、复算命令

```bash
# 单请求时延 SLO（读已入库 live 报告）
# 报告在**仓外**（项目根仓的评测目录），因此必须显式传 --report；
# 本仓解析不到该路径，故不在本文写相对路径。
node scripts/observe_slo_check.mjs --report <评测报告绝对路径>/eval_report_live.json

# 判据自检（离线，含方向相反的反例腿）
node scripts/observe_slo_check.mjs --selftest     # 17/17
python scripts/synth_case_pipeline.py --selftest   # 8/8
node scripts/load_probe.mjs --selftest            # 18/18

# 并发探针（默认不联网；不给 --base 直接退 2）
node scripts/load_probe.mjs --base http://127.0.0.1:8788 --vu 8 --duration 20
```

## 五、2026-10-04 实测读数（可复算）

| 项 | 读数 | 出处 |
|---|---|---|
| 诊断链路时延 | **P50 3,810ms / P95 4,602ms / max 5,074ms** | `eval_report_live.json`，n=31，`mode_distribution.live=31 / rule_fallback=0`（纯线上读数），base `https://doctor-ai-dx.pages.dev`，日期 2026-10-02 |
| 报告生成时延 | P50 3,590ms / P95 4,199ms | 同上，n=6 |
| P95 距硬超时余量 | **42.5%**（阈值 25%） | `observe_slo_check` 计算 |
| 脱敏红线 | 31 条评测病例**脱敏零命中**、结构完整、免责声明在位 | `synth_case_pipeline.py --check` |
| 并发探针 | 旧读数（VU8 / 185 req/s）出自项目根仓的探针件（**仓外，本仓解析不到）** | 2026-10-04 已把探针搬进本仓（`scripts/load_probe.mjs`），该数字须以本仓重跑为准 | 2026-10-04 已把探针搬进本仓（`scripts/load_probe.mjs`），该数字须以本仓重跑为准 |

## 六、四态退出码（不折叠）

| 态 | 含义 | rc |
|---|---|---|
| `PASS` | 全部阈值成立 | 0 |
| `WARN` | 仅 `load_probe` 的错误率进早警区间（>0.5%）；**advisory 不成闸** | 0 |
| `FAIL` | 有阈值被撞破 | 1 |
| `UNVERIFIED` | base 不可达 / 样本不足 / 字段缺失 ⇒ **不折成「没问题」** | 1 |

## 七、尚未覆盖（诚实登记，不假装有）

- **无分布式追踪**：无 trace/span 概念，端到端分段时延靠 `eval_report_live.json` 的两个分面（dx / workup_report）近似。
- **无指标持久化**：`observe.js` 只做单次请求内的记录，没有时间序列存储，也就没有告警阈值的历史基线。
- **无负载读数基线**：`load_probe.mjs` 已进仓，但**尚未在 CI 里跑**，因此并发读数目前是人工触发、非守门。