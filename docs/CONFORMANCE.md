# 对外契约自验套件（CONFORMANCE）

> 定位：给**集成方与第三方评审**的一页——不需要密钥、不需要读源码、不需要部署，一条命令就能验
> 「这套对外契约是否成立」。这是本仓唯一一件**为仓外人写的判据**。
>
> 立论（第一百零七轮八维对标现取，不是预防性加闸）：peer `inferno-framework/smart-app-launch-test-kit`
> 有 31 个 release、18 位贡献者，它存在的意义就是「**能集成**这句话可以被别人拿去跑」。
> 我方 `frontend/functions/lib/fhir.js` 与 `frontend/functions/lib/cds_hooks.js` 是**实现**，此前没有任何一件是第三方可以指向它做验证的契约面
> ⇒ 差距量化：**对外契约测试 0 个 vs 现成套件 1 个**。

## 1. 一条命令（两种用法）

```bash
# ① 验本地仓：零网络零密钥，直驱 Functions 的 onRequest（Node 有 Request/Response 全局）
node examples/conformance_basic.mjs

# ② 验一个已部署实例（含线上）：走真实 HTTP，同一批不变量
node examples/conformance_basic.mjs --base https://doctor-ai-dx.pages.dev
```

退出码：`0` 全过｜`1` 有违例（逐条印出）｜`2` 取数面坏（用例读不到/为空、处理器取不到）。

> **本页不抄任何读数**：面数与 matched/mismatched 由每次运行现算并印在末行
> （抄进文档的数字一轮就过期，这是本仓 #106 立过的同族事故）。要看当前读数就跑上面那条命令。

## 2. 它验什么（以及刻意不验什么）

| 面 | 验的不变量 | 为什么集成方会依赖它 |
|---|---|---|
| CDS Discovery | `GET /cds-services` 出规范形；服务集与声明**全等**（多一个也是漂移）；每个服务带规范要求的五个字段 | 集成方第一步打的就是这个端点，它决定后续打哪些 URL |
| CDS 调用 | 卡片只含规范字段；`indicator` 只在规范三档内；`summary` 不超长；`source.label` 含「医生终审」；`overrideReasons` 非空 | 卡片字段是集成方渲染的输入；「医生可驳回」的承载位必须存在 |
| CDS 确定性 | 同输入两次**逐字节相同** | 集成方要缓存/幂等，不能每次拿到不同的卡 |
| CDS 拒绝腿 | 六种坏请求各自的**状态码**，错误体恒为 `{code,message}` 且文案零泄漏 | 集成方按这张表写分支，不看源码 |
| FHIR-light | `data.fhir` 是 `Bundle(collection)`，含 Patient/Encounter/Condition/Observation/DiagnosticReport；引用可解析；**零时钟字段**；Patient 带 `syntheticCase=true`；DiagnosticReport 结论以「AI 辅助参考 · 医生终审」开头 | 下游 HIS 按标准资源解析；零时钟字段是「同输入逐字节相同」的前提；`syntheticCase` 让下游区分演示与真实数据 |
| 信封与健康面 | `/api/health`、`/api/cases` 的形状；未知路径 404 的 `{code,message}` 形与零泄漏 | 集成方的启动自检与错误分支 |

**刻意不验的**（写明边界，避免被当成承诺）：

- **不断言任何结论文本**。`mode=live` 时走大模型，同输入两次输出不同是常态——断言措辞＝测模型心情。
  契约面只断言结构、字段、状态码、确定性与红线承载位。
- **不验临床正确性**。诊断排序的自洽度在 `docs/EVAL_CARD.md`（口径限定在那里，不在本页）。
- **不验认证/授权**（本仓不提供，见 `docs/INTEGRATION.md` §4）。
- **不声称符合官方 Profile**：FHIR 是 light 子集，CDS 面不申请 `prefetch`。

## 3. 用例面（第三方可改可加）

声明式用例住 `frontend/tests/fixtures/conformance_cases.json`：服务集、卡片必填/禁填字段、
调用与拒绝用例、FHIR 资源不变量、信封形状。**加一条用例＝改这一个 JSON**，不用碰判据代码。

判据本体住 `frontend/tests/conformance_guard.mjs`：

- 真面：`node tests/conformance_guard.mjs`（cwd = `frontend/`），末行 `[GATE:conformance:pass|fail]` 带 `rc=`；
- 反例腿：`node tests/conformance_guard.mjs --selftest`（每条判据配坏样本，证判据有牙；例数由末行现算）。

**零输入不记绿**：用例文件读不到、`invocations` 为空、处理器取不到 ⇒ 一律 `rc=2 BROKEN`，不读成"没有要验的"。

## 4. 与既有守卫的分工（四件不重叠）

| 件 | 管什么 |
|---|---|
| `frontend/tests/fhir_guard.mjs` | FHIR **资源内部**自洽（术语白名单、悬挂引用、编造编码、零时钟字段） |
| `frontend/tests/cds_hooks_guard.mjs` | CDS **双端行为**（权威 JS 与镜像 Py 逐条比对） |
| `frontend/tests/api_contract_guard.mjs` | **路由 ⇄ openapi** 双向在场 |
| `frontend/tests/conformance_guard.mjs` | **对外可被第三方自验的契约面**（一份声明式 JSON + 一条命令） |

四件都可能对同一个字段下断言，但**取数面不同**：前三件各自站在"实现侧"看自己，本件站在"集成方侧"
看对外承诺。本件的第一版就是靠这一点当场抓出两个自身缺陷（把 FHIR 的 `value[x]` 选择类型误当成必填
`valueString`；把 Pages 的两棵文件路由当成一棵），两处都是"站在实现侧看不出来"的那类。

## 5. 复算命令

```bash
cd frontend && node tests/conformance_guard.mjs --selftest   # 反例腿（离线）
cd frontend && node tests/conformance_guard.mjs              # 真面（离线，直驱处理器）
cd .. && node examples/conformance_basic.mjs --base https://doctor-ai-dx.pages.dev   # 线上
```
