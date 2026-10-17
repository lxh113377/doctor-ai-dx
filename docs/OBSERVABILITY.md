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

## 二、三条判据的分工（阈值不共享）

| 判据 | 量什么 | 取数面 | 阈值表 |
|---|---|---|---|
| `scripts/observe_slo_check.mjs` | **单请求时延**（P50/P95/max） | live 评测报告（**仓外**：项目根仓的评测目录） | `SLO`：P95 ≤ 10,000ms、硬超时 8,000ms、余量 ≥ 25%、n ≥ 10、live 纯度 |
| `scripts/load_probe.mjs` | **并发下的吞吐/错误率**（活端点，网络面） | 活端点（`--base` + `--path`） | `LOAD_SLO`：吞吐 ≥ 20 req/s、错误率 ≤ 2%（>0.5% 进 WARN）、并发 P95 ≤ 10,000ms |
| `frontend/tests/latency_guard.mjs`（并发段） | **并发下代码路径退化 + 请求串扰**（直驱面，零网络） | 直驱 Functions 处理器（`npm test` 常驻） | `CONC`：并发/单 worker ≥ 0.5×（低于即并发更慢）、错误率 ≤ 2%、三病例交错 20 轮零串扰 |
| `.github/workflows/live-smoke.yml` 的 `live-concurrency` 作业 | **网络面并发读数**（活端点、每日现算） | 线上 `/api/health`（1 VU 串行基线 + VU8 × 20s） | **判退化不判绝对吞吐**：并发 ≥ 串行 × 0.5（`--serial`）；错误率 ≤ 2%、并发 P95 ≤ 10s 沿用 `LOAD_SLO` 单一源 |

> **四张表**（第一百一十二轮起把「网络面并发」从人工触发变成每日作业）：一处改动同时动「单请求时延」与「并发吞吐」两个语义，
> 就是本项目台账 #168「两份尺」的同族病。
> 第一、二行（`observe_slo_check` / `load_probe`）**也不合并**（原立论保留）；第三行（`latency_guard` 并发段）与第二行
> 同样不合并：前者量**代码路径在并发下有没有退化/串扰**（直驱、无网络、进 `npm test` 阻断链），后者量
> **活端点在网络堆栈下的吞吐**（需起服务、人工触发）。合成一个数就是「直驱读数被当成线上并发承诺」的假绿。

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
# 并发面判据（直驱、零网络零密钥；进 npm test 链，每次提交都跑）
node frontend/tests/latency_guard.mjs             # 20 面（3 面时延 + 2 面并发 + 3 病例零串扰 + 12 条红态自证腿）

# 并发探针（默认不联网；不给 --base 直接退 2）
node scripts/load_probe.mjs --base http://127.0.0.1:8788 --vu 8 --duration 20
# 网络面并发读数（每日作业跑的同一句，打线上；本机也可复算）
node scripts/load_probe.mjs --base https://doctor-ai-dx.pages.dev --path /api/health --vu 8 --duration 20
```

## 五、2026-10-04 实测读数（可复算）

| 项 | 读数 | 出处 |
|---|---|---|
| 诊断链路时延 | **P50 3,810ms / P95 4,602ms / max 5,074ms** | `eval_report_live.json`，n=31，`mode_distribution.live=31 / rule_fallback=0`（纯线上读数），base `https://doctor-ai-dx.pages.dev`，日期 2026-10-02 |
| 报告生成时延 | P50 3,590ms / P95 4,199ms | 同上，n=6 |
| P95 距硬超时余量 | **42.5%**（阈值 25%） | `observe_slo_check` 计算 |
| 脱敏红线 | 31 条评测病例**脱敏零命中**、结构完整、免责声明在位 | `synth_case_pipeline.py --check` |
| 并发探针（活端点） | 旧读数（VU8 / 185 req/s）出自项目根仓的探针件（**仓外，本仓解析不到**）⇒ **不可引用** | 2026-10-04 已把探针搬进本仓（`scripts/load_probe.mjs`）；本仓复算命令见 §四，**本表不抄读数** |
| 并发退化（直驱面，常驻判据） | 读数是机器相关量 ⇒ **本表不抄**；判据每轮在 `npm test` 里现算并打印（并发/单 worker 比值、错误率、串扰命中数） | `frontend/tests/latency_guard.mjs`（第一百一十一轮起） |

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
- **绝对吞吐地板（20 req/s）只适用于本地起服务**：第一百一十二轮一手实测——本机打线上 `/api/health`
  VU8 只有 3.19~4.48 req/s（P50 541~2097ms，受网络 RTT 支配），而 `LOAD_SLO.min_rps=20` 来自 localhost 经验。
  把 20 搬到公网端点上，从国内网络跑是**每天恒红**、从美国 runner 跑可能**恒绿**——同一阈值在两个位置给出相反
  结论，它就不是一把尺（与 r111「并发加速比 3× 把 Node 单线程判成恒红」同族）。故新增 `--serial`：
  先取同端点 1 VU 串行基线，判 `并发 ≥ 串行 × 0.5`（只判「并发比单跑还慢」，与位置无关）。
  绝对地板在**没有串行基线时**仍生效（本地自测口径不变）。
- **活端点并发读数已进每日作业，但仍非合码阻断**：`load_probe.mjs --base` 打真实 HTTP 端点、量网络堆栈下的吞吐，
  第一百一十二轮起由 `.github/workflows/live-smoke.yml` 的 `live-concurrency` 作业**每天现算**（打线上 `/api/health`，
  VU8 × 20s，读数上传为 `load-probe-live` 工件并写作业摘要）——它不再靠人记得跑，但**不进 `ci.yml` 阻断链**：
  那条链的契约是零网络零密钥，拉外网进去就等于给每次提交引入一类不可复现的红。**且「并发面会不会退化」这一维另有常驻尺**——`frontend/tests/latency_guard.mjs` 自第一百一十一轮起
  带并发判据：三面直驱 Functions 处理器（零网络零密钥），判**并发退化**（并发吞吐应 ≥ 单 worker 的 0.5 倍；
  低于此即全局锁/同步阻塞/资源争用征兆）、**错误率**（≤2%）与**并发串扰**（三病例交错 20 轮，每条响应必须与串行基线
  逐字节相同——单例上下文被覆盖会当场抓到）。它进 `npm test` 链，所以每次提交都在跑。
  ⇒ 两条尺的分工不变：`load_probe` 量**网络面吞吐**（人工），`latency_guard` 的并发段量**代码路径退化**（常驻）。
  **不把后者说成「并发 P95 承诺」**：直驱面没有网络与调度开销，其读数不可外推到线上。