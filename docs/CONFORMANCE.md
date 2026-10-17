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
| FHIR 确定性（分档） | `rule-fallback` ⇒ **整包**逐字节相同；`live` ⇒ 只有**确定性子面**逐字节相同（Bundle 头／Patient／Encounter／`Observation/flag-summary`／DiagnosticReport 骨架），模型产出面只断形状 | 集成方能缓存的是规则层产物；模型文本本来就不是幂等输入 |
| CDS 拒绝腿 | 六种坏请求各自的**状态码**，错误体恒为 `{code,message}` 且文案零泄漏 | 集成方按这张表写分支，不看源码 |
| FHIR-light | `data.fhir` 是 `Bundle(collection)`，含 Patient/Encounter/Condition/Observation/DiagnosticReport；引用可解析；**零时钟字段**；Patient 带 `syntheticCase=true`；DiagnosticReport 结论以「AI 辅助参考 · 医生终审」开头 | 下游 HIS 按标准资源解析；零时钟字段是「同输入逐字节相同」的前提；`syntheticCase` 让下游区分演示与真实数据 |
| 信封与健康面 | `/api/health`、`/api/cases` 的形状；未知路径 404 的 `{code,message}` 形与零泄漏 | 集成方的启动自检与错误分支 |

**刻意不验的**（写明边界，避免被当成承诺）：

- **不断言任何结论文本**。`mode=live` 时走大模型，同输入两次输出不同是常态——断言措辞＝测模型心情。
  契约面只断言结构、字段、状态码、确定性与红线承载位。
- **不把「逐字节相同」许诺给模型产出面**（第一百一十轮线上实测写进文档，起因见下）。
  本仓唯一一次"承诺越界"是一手抓出来的：第 109 轮交付本套件后，第一次打线上 `--base` 就跑出
  `matched=24 mismatched=1`，唯一红项是 FHIR 整包逐字节。两轮对照同一请求取到 13 处差异，
  **全部落在模型产出面**（支持理由改写、鉴别诊断次序换位、evidence 数 1↔2、`code.coding` 时有时无）。
  判据把模型输出也拉进了「逐字节」这把尺，而本文 §2 自己就写着"不断言结论文本"——
  那是**判据越界**，不是实现里有随机量。修法＝分档（上表第二行），不是把这条断言整条删掉：
  规则层产物（尤其 `Observation/flag-summary`）在 live 下也必须逐字节定，那是红旗独立于模型这条红线
  在对外面上的可验形态。反例腿各配一条：往确定性子面注入 `timestamp` 必红、红旗文本漂移必红、
  投影到 0 条 entry 必红（骨架不存在≠两次相同）。
- **`integration 幂等/缓存`这句对外承诺的范围＝确定性子面**，不是整个 Bundle。集成方若要缓存 live 的
  诊断文本，请当作"非幂等内容"处理（本仓不给它 ETag，也不承诺它稳定）。
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
传给 `--base` 的部署不可达时同样 `rc=2 BROKEN`，并给出可读原因（**不打栈帧**——本仓红线：不展示堆栈与内部路径；
集成方看到栈会以为套件坏了，而不是「我给的地址没起服务」）。

### 入口脚本自己也有判据（第一百一十一轮）

`examples/conformance_basic.mjs` 是**仓外唯一会跑的那一条命令**，所以它「会不会如实转达结论」本身要被验——
判据本体 25 面全绿只证明「判据会判」，不证明「入口把那个结论传出去了」。守卫：
`frontend/tests/conformance_entry_guard.mjs`（进 `npm test` 链），真起子进程跑入口本体，断言三态都被如实转达：

| 面 | 期望 | 为什么要这一面 |
|---|---|---|
| 真面离线 | `rc=0` 且末行带 `[GATE:conformance:pass]` | 不能只看退出码：入口恒 0 时退出码永远「成功」 |
| 取数面坏（`--base` 不可达） | `rc=2` + `broken` 标记 + **零栈帧** | 坏输入被读成通过＝假绿；栈帧＝违反对外红线 |
| 子进程没起来/超时 | 判红（`status===null` 不得读成合规） | 「没跑」与「跑过且通过」是相反的两件事 |

反例腿把入口的 rc 传递换成恒 0 的合成替身 ⇒ 必须判红（证这把尺有牙）。

## 4. 与既有守卫的分工（五件不重叠）

| 件 | 管什么 |
|---|---|
| `frontend/tests/fhir_guard.mjs` | FHIR **资源内部**自洽（术语白名单、悬挂引用、编造编码、零时钟字段） |
| `frontend/tests/cds_hooks_guard.mjs` | CDS **双端行为**（权威 JS 与镜像 Py 逐条比对） |
| `frontend/tests/api_contract_guard.mjs` | **路由 ⇄ openapi** 双向在场 |
| `frontend/tests/conformance_guard.mjs` | **对外可被第三方自验的契约面**（一份声明式 JSON + 一条命令） |
| `frontend/tests/conformance_entry_guard.mjs` | **入口脚本如实转达结论**（rc 三态 + 零栈帧；判据本体绿 ≠ 入口会转达） |

五件都可能对同一个字段下断言，但**取数面不同**：前三件各自站在"实现侧"看自己，conformance 两件站在"集成方侧"
看对外承诺。本件的第一版就是靠这一点当场抓出两个自身缺陷（把 FHIR 的 `value[x]` 选择类型误当成必填
`valueString`；把 Pages 的两棵文件路由当成一棵），两处都是"站在实现侧看不出来"的那类。

## 5. 复算命令

```bash
cd frontend && node tests/conformance_guard.mjs --selftest   # 反例腿（离线）
cd frontend && node tests/conformance_guard.mjs              # 真面（离线，直驱处理器）
cd frontend && node tests/conformance_entry_guard.mjs        # 入口脚本 rc 传递（真起子进程）
cd .. && node examples/conformance_basic.mjs --base https://doctor-ai-dx.pages.dev   # 线上
```
