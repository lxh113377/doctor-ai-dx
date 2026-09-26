# 评测卡 · 安全卡（EVAL CARD）

> 版本锚点：v1.6.0（main）｜ 更新日期：2026-09-24 ｜ 维护口径：任何评测/规则/知识库变更后须重跑门禁并更新本页（v1.4/1.5 期间锚点漏更，2026-09-24 round7 实测补正）
> 本页回答三件事：**系统能看什么病、以什么证据看、不能证明什么**。供评审、医生用户与集成方独立核验。

## 1. 定位与安全声明（红线）

- **AI 辅助参考 · 医生终审**：全界面持续显示，系统不替代执业医生，不做自动处方。
- **红旗规则层独立于 LLM**：关键词 13 组 + 组合条件 4 组 + 血压数值规则 1 项；规则先算、后强制覆盖模型输出，模型不可取消或稀释红旗结果。
- **引用白名单**：全部 `evidence_id` 必须存在于知识库 60 条（单一源 `functions/lib/knowledge.js`，Python 端自动生成零漂移）；非法引用直接拒绝，缺项仅用本次检索命中的合法证据回填。
- **溯源等级（如实披露，2026-09-24 实测）**：`引用可溯源` 目前成立到 **指南名 + 年份 + 机构域名** 一级，**尚未做到文档级深链**——60 条中 0 条深链、28 条仅机构门户域名、32 条 `url` 为空（仅 `source` 文字出处）。前端不渲染这些 url，因此界面不存在"点开的链接指向别处"的风险；`kb_guard.mjs` 以**溯源棘轮**守门（未链数只准减少、深链数只准增加），补链须逐条人工核验后进行，**禁止批量填入猜测性 URL**。
  - **2026-09-25 round9 校正注（上文保留，因其当时为真）**：新增联网门禁 `tests/link_health.mjs` 首跑即发现 **16 条 url 指向 DNS 根本不解析的域名**（`cmas.org.cn` 15 条、`www.nhoc.org.cn` 1 条）—— 属「假回链」，比空 url 更危险（看似可溯源实则不可达）。已全部改为逐条实测 HTTP 200 的正确官方域：`www.cma.org.cn` 13 条（中华医学会）、`www.medjournals.cn` 3 条（中华医学期刊网，承载《中华内分泌代谢杂志》等）。改后 DEAD 3 → **0**；`www.nhc.gov.cn` 返 412 系 WAF 反爬（站点存活），按 BLOCKED 只报不红。同时 `kb_guard` 新增**离线已核验域名白名单**（4 host；反例实测：塞回 cmas.org.cn 即 FAIL 且双端深度相等检查同步报警），CI 每周跑链健康（观察期不阻断，连续两周零 DEAD 后转硬门禁）。深链仍为 0：候选深链实测 404 / JS 空壳，按红线不写未核验链接。
- **2026-09-25 round17 校正注（上文 round9 注保留，因其在当时为真）**：`link_health.mjs` 的 BLOCKED 判据由「计数基线 `BLOCKED_BASELINE`」改为「**内容登记册 `BLOCKED_REGISTRY`**」——原基线本机默认 0 而实测为 1（nhc 412）、CI 里又另设 1，结果这条警告**永远不红**，真正新增的被拦源会被固定噪声淹没。现口径：反爬源须连状态码+实测日期+理由逐条登记，**未登记即判红**；登记项恢复可达则提示清理（防白名单只增不减变掩体）。实测还原后 rc=0「零死链 + 被拦源全部已登记」，反例（删登记项）rc=1。
- **演示数据**：仅脱敏合成病例与评测用例，从未接入真实患者数据。

## 2. 质量指标（可复现命令见 §5）

| 维度 | 结果 | 口径与日期 |
|---|---|---|
| 结构校验（诊断/检查/报告字段完整） | 31/31 | 离线 rule-fallback，2026-09-24 |
| 引用 ID 合法 | 31/31 | 同上；白名单+存在性断言 |
| 红旗召回（正负样例） | 27/27 = 100% | 离线评测集；silver 标注，非临床敏感度/特异度 |
| 线上红旗（pages.dev live） | 14/14 | 2026-09-16 线上评测 |
| 输入敏感性 | 31 例 → 31 种不同结论（≥5 门槛） | 离线，防"恒输出" |
| **诊断排序金标准（合成病例自洽度）** | top-1 **28/31 = 90.3%** / top-3 **30/31 = 96.8%** / **危急类 top-3 召回 17/17 = 100%（主指标）** / 知识库缺口 0 例 / 弃权 3 例（其中过度弃权 1 例）（第二十四轮首测为 83.9%／93.5%／95.7%，缺口 5 例；第二十七轮按台账#53 扩库 5 条后转绿，缺口清单清空） | 第二十四轮新增，`tests/accuracy_guard.mjs` + `tests/fixtures/dx_gold.json` 入二十二件套与 CI。⚠️ **口径限定（不可省略）**：病例与金标准同为自产、取材同一批公开指南，该数只衡量「自建病例 → 自建 60 条知识库 → 引擎排序」三者自洽，**不是真实世界诊断准确率、不是灵敏度/特异度**，未经任何真实患者或外部临床评审（此限定借鉴 urobot-tw 首页「目前没有任何可对外宣称的准确率」与 Medico「cases 与 rules 同作者 ⇒ 只测内部一致性」的自陈惯例）。主指标取危急类召回而非 top-1：漏一个危急诊断的代价远高于排序不优，且它可直接闸门化（漏检即非零退出） |
| 检索质量 · 主口径（BM25+同义词，silver **50** 例） | R@1 **0.577** / R@3 0.793 / **R@5 0.860** / MRR **0.872** / nDCG@5 **0.803**（2026-09-26 第二十七轮复跑；上一值为 0.547/0.793/0.850/0.867/0.789）| 2026-09-24 扩充为 v2.0 集（新增 30 例口语化改写，刻意避开 keywords 书面术语）。原 20 例口径下 R@5=0.95；扩集后回落至 0.85 是**评测集变严**，不是检索退化（同集同码复跑）。红旗子集(23) R@5 **0.870**。⚠️ 本轮把**标点与符号移出 BM25 索引**（`，`曾以 df=54 当检索词、罕见单字「来」df=1 一次匹配即可顶起无关条目），五项指标同时抬升；CI 基线按检索器分档锁定不回归，地板仍为 55 条时代实测值，**未放宽** |
| 检索质量 · 备选口径（hybrid 加权 RRF，同 50 例） | R@5 0.870（+2.0pt）/ MRR 0.825（−4.2pt）/ **红旗子集 R@5 0.891（+4.4pt）** | **未启用**（`RETRIEVER` 可切换，默认 bm25）。权重在同集标定存在自标定过拟合风险，**2026-09-24 已完成留出集验证**：`tests/fixtures/retrieval_holdout.json` 20 例患者口语集（刻意避开 keywords，silver-draft 待复核）上 hybrid vs bm25 **ΔR@5 = 0.0、ΔMRR −1.3pt、红旗子集持平** → 标定增益未泛化，**维持 opt-in、默认口径不变** |
| 检索质量 · 备选口径（semantic 语义近邻通道，同 50 例 + 20 例留出集） | 标定集 R@5 0.830~0.840 / MRR 0.494~0.863；留出集 **无任何组合严格优于 bm25**（0/54 组），9 组逐位等值、45 组劣化（ΔMRR 最差 −0.328） | **未启用**（`RETRIEVER=semantic` 可切，默认 bm25）。邻接表由本地 BAAI/bge-small-zh-v1.5 离线蒸馏（512 维余弦，权重 sha256 与语料指纹写入产物头），运行时零模型零网络。结论：条目↔条目语义相似**不能**替代查询编码——真正的语义召回需向量服务（同类项目均外挂 Milvus/Chroma/FAISS/TEI）。复现脚本 `work/sweep_semantic_weights.mjs` 在参赛工作区侧、**不随本仓库发布**（该结论的防陈旧门禁 `npm run test:semantic` 在本仓内，可独立复跑） |
| 测试覆盖率（v1.12.0 起为常规度量，v1.13.0 更新至类型门禁后口径） | JS Functions 面：语句 **94.75%** / 分支 **75.24%** / 函数 **94.28%**（c8 12.0.0）；Py 镜像面：**92.78%**（v1.13.0 补追问 live 分支后；上一档 90.53%）（coverage.py 7.16.0，v1.12.0 起 `.coveragerc` 开启 `branch=True`，口径由「仅语句」改为「语句+分支弧」；同批测试旧语句口径为 87%） | 2026-09-25 实测。本轮补测涨幅：分支 67.04→74.02、engine.js 53.12→69.23、rules.js 78.12→88.88、fhir.js 66.21→76.92；Py llm.py 37→90、retriever.py 37→98、engine.py 61→74。两端**地板均按模块设**（防红线模块单独退化被全局均值掩盖）：JS 7 模块 + Py 9 模块，阈值单一源 = 同一份 fixture；`npm run coverage:js` / `coverage:py` 强制。本轮实测涨幅：JS 全局分支 74.18→**75.65**（observe.js 分支 69→100）；Py rules.py 75→**98**、`routers/api.py` 57→**100**、main.py 96→98 |
| 延迟（线上诊断链路） | p50 **3.756s** / p95 **4.890s** / max 5.097s（n=31，mode=live 31/31，红旗 14/14） | 2026-09-26 本机经 `scripts/live_eval.mjs` 实测；**该脚本与硬门禁自 v1.22.0 起在仓内**，由 `.github/workflows/live-smoke.yml` 的 online-eval 作业每周重产（回执写进作业摘要），不再是一句指向仓外、第三方跑不动的历史记录。约束 p95 ≤10s、单次模型硬超时 8s |
| 双端一致性（Functions JS ↔ FastAPI Py） | 引擎 31/31 逐字段；检索器 **3 档（bm25/hybrid/semantic）各 50/50** 逐字段；语义邻接表双端同值 + provenance 同值 | 契约测试 CI 常跑；取整规则两端统一为 half-up（`round_half_up`），不用放宽容差掩盖漂移 |
| 知识库入库门禁 | 60 条逐条 schema + 引用完整性 + 孤儿条目 0（症状线索覆盖 100%）+ 双端数据全等 | `frontend/tests/kb_guard.mjs`，17 项断言入 CI |
| 隐私与数据留存（v1.11.0 起成文 + 机器核对） | 声明 13 项断言全部与代码对账通过：持久化原语 0、第三方遥测 0、日志字段白名单（不含请求体）、双端脱敏模式与 6 用例输出逐字相同、文档锚点无死链 | `frontend/tests/privacy_guard.mjs` **59 项**（含 5 组反例实测：注入 localStorage／fs 写入／`@sentry` 包／把问诊文本写进日志／锚点失效）入 `npm test`。判据自证升级为**逐条**：25 条持久化/遥测形态各配一条真实写法样本，数量对位不符或某条样本不命中即判红。根因（v1.12.0 由 ESLint `no-control-regex` 抓出）：上一轮写入的三条遥测判据里 `\b` 被 Python 字符串转义成裸 `0x08` 退格符 ⇒ 正则是永不匹配的**死判据**，而聚合反例因同一条 poison 里 `@sentry/` 命中仍判绿。教训：聚合命中 ≠ 逐条接线，另补「元反例」证明自证块能识别死判据 |
| 类型门禁（v1.13.0 起） | mypy 严格档 `check_untyped_defs=True`，`backend/app` + `scripts` 共 23 文件 **0 error**；阈值单一源钉 `expected_errors=0`，无基线豁免、无 per-module 放行 | `scripts/type_gate.py` + `frontend/tests/fixtures/type_floor.json`；四组反例实测 rc=1/2。首跑 26 条中 7 条为真缺陷（Provider 构造契约、红旗表标注、None 作字典键、`re.search` 结果未判空等），19 条为生成物未标注的推断噪声 ⇒ 修生成器而非加豁免 |
| 入站滥用护栏（v1.17.0） | 请求体/问诊条数/单条字数上限三处同源对账 + 越界 413 + 坏 JSON 400 + 4xx 不落 error 日志 | JS 33 项（`tests/limits_guard.mjs`）+ Py 22 项（`backend/tests/test_limits.py`）；阈值单一源 `fixtures/request_limits.json`，余量按实测峰值 488B 取 128x |
| 分支保护强制性（v1.17.0） | 聚合 required check `all-checks-passed` + `scripts/branch_guard.py` 五判据 | 实测修前 required checks 仅 2/4 作业 ⇒ 新判据可被绕过；修后线上 contexts=[all-checks-passed]、strict=true，四组反例 rc=1 |
| 端到端浏览器回归（v1.15.0 起进 CI） | 生产构建 + Functions 本地运行时（无 Key ⇒ 规则降级，确定可重复）跑 5 条用例：三张脱敏病例卡、红线常驻与负向、五步链路与红旗独立呈现与降级标注、双视口 1440/390 × 五页面零横向溢出、零控制台异常 | `frontend/e2e/app.spec.mjs` + `frontend/playwright.config.mjs`（chromium 单引擎，按 AC 口径不做跨浏览器矩阵）。两组反例实测 rc=1（红线文案改一字 → 1 failed；仅报告页注入 `min-width:200vw` → 2 failed 且报错指向新增的病历报告页断言），还原后 rc=0 / 5 passed。此前「双视口 E2E 通过」只是本机一次性人工证据，本轮起为每次 push 的常驻判据 |
| 交付物可审计性（v1.14.0 起） | tag 触发的 `release.yml`：门禁全绿才产出 `git archive` 源码包 + 双端 CycloneDX SBOM + SHA256SUMS 并挂到 Release（实测前端 362 组件，17 个声明直接依赖连同 lock 解析版本逐一在单） | `frontend/tests/sbom_guard.mjs` 四组反例实测 rc=1；SBOM 不入库防第二真值。**平台侧依赖图实测不可用**（本仓 `dependency-graph/sbom` 读写均 404，peer 3/3 可读）⇒ 属账号/仓库设置面待办，未以代码冒充完成 |
| 可观测性 | 每请求 `X-Request-Id`；错误结构化日志（无堆栈/路径/密钥，出站前脱敏）；>8s 慢请求告警 | `lib/observe.js` ↔ `app/observe.py`；route_guard 25 项 + 后端 test_api_observe 40 项 + live 路径 43/37 项（含追问 live 分支与「超限轮零外呼」）（含无 crypto 回退、warn/info 两级日志、空入参、慢请求 warn 与 404 契约）。日志未接集中式后端（见 §3） |
| 降级行为 | 无 Key / 超时 / 非法 JSON → `rule-fallback` 且带 `fallback_reason` | 31/31 降级标注通过；错误态只显示医生可理解文案 + 故障编号 |

## 2b. 弃权 / 范围外第三态（第二十八轮，台账 #52）

| 项 | 实测值 | 口径与代价（不美化） |
|---|---|---|
| 触发信号 | 最高 BM25 证据分 `top_evidence_score < ABSTAIN_T` | `ABSTAIN_T = 48.491`，**不是手调**：由 `tests/ood_probe.mjs` 在当前语料 + 当前分词下取「域外最高分 36.559」与「危急域内最低分 60.422」的中点；probe 与该常量互相对账（改语料/分词不重算即判红），双端同值由 `tests/abstain_guard.mjs` 核 |
| 可分性 | 间隙 **23.863**（占危急类最低分的 39.5%） | 任何 `T ∈ (36.559, 60.422)` 都满足"域外 10/10 判出且危急 0/14 误伤"；间隔 <1.0 视为不可靠（当前通过） |
| 输出形状 | `abstain=true` + `scope_status ∈ {insufficient-information, out-of-scope}` | 只出一张弃权卡（`信息不足，建议补充问诊`）、**不编鉴别诊断**；`flags` 与 `evidence` 照常返回 |
| 红线保护 | 红旗命中一律不弃权 | 线上与离线均有判据（`live_smoke` 反例 + `abstain_guard` 13 条规则表派生探针）。peer 同向取舍：`kheireddinedev00/Medico` 弃权时红旗仍抬优先级并配具名测试；`dmustapha/triage-0` 用三条决定性体征禁止弃权 |
| 31 例上的代价 | 3 例走弃权：ev-24、ev-25（弃权即期望答案）＋ **ev-09 属过度弃权**（普通上感，top=43.525 落在阈值下） | 过度弃权单列并设地板 `over_abstain_max = 1`（只准降不准升）；把阈值调高到"什么都弃权"会同时撞这条与"危急被弃权即判红" |
| 已知局限 | 阈值对**转录重复**敏感 | BM25 词频随重复增长：同一句无关输入重复 6 次可把 top 分从 ~31 抬到 56.07 从而越过阈值（本轮实测）。故本能力主张是"对**单次**域外输入弃权"，不主张抗灌水；已列台账 #74 |

## 2c. 能力级适用范围（第二十九轮，台账 #76）

| 项 | 值 | 口径 |
|---|---|---|
| 权威数据 | 仓内 `data/scope_rules.json`（**本仓第一块外置临床决策数据**） | 逐条带 `rationale`（为什么不做）与 `doctor_note`（该找谁）；`frontend/functions/lib/scope_rules.js` 与 `backend/app/scope_rules.py` 是生成物，由 `npm run scope:export` 单向产出，禁手改 |
| 三条规则 | 影像与检查报告解读 ／ 给药剂量与处方方案 ／ 非人类患者 | 命中 ⇒ `abstain=true` + `scope_status=out-of-scope` + `scope_rule=<id>`，只出弃权卡、不编鉴别诊断；**红旗与 evidence 照常在场** |
| 立据实测 | 「拍了CT／片子上说有个结节」原本 **top=59.091 却不弃权**，首诊给出「急性上呼吸道感染」 | 本轮动机不是设想：系统没有阅片能力却自信作答，是幻觉风险最高的越界。剂量与兽医类输入原本**偶然**因分数低于阈值弃权（44.147／43.747），理由错但结果对，本轮改为因正确理由命中 |
| 载入即校验 | `validateScopeRules()` 11 类拒绝路径，全部用变异数据自证会抛 | 形状抄 `kheireddinedev00/Medico`（数据 + 载入即拒 + 具名安全测试）；阈值不抄它 |
| 否定处理 | 复用红旗层词表 + 本层追加线索（窗口 6 字） | 「我没做过CT」必须**不**命中；「我没做过CT，可这个CT报告您帮我看看」必须命中（同词先否定后阳性的取或语义，c8 实测该行原本无探针覆盖，第 29 轮补齐） |
| 刻意不做的收紧 | 不用裸单字「猫」「狗」作关键词 | 被狗咬伤的暴露处置（狂犬病疫苗、破伤风）本身是基层人医业务，用单字会把它挡在范围外；探针『被狗咬了要不要打狂犬疫苗』常驻断言不命中 |
| 判据 | `frontend/tests/scope_guard.mjs` 46 项（npm test 第 22 件）＋ E2E 双向 ＋ `live_smoke` 线上域外实调 | 31 例既有用例零真误伤（ev-25 属 gold 已声明"弃权即正确"的改判，非误伤） |

## 3. 能力边界（不覆盖什么）

- **不证明诊断正确率**：31 例证明结构、引用合法与规则命中；诊断 Top-k 准确率、校准度、真实临床效度未评测（需医生金标准与前瞻研究）。
- **专科纵深未覆盖**：肿瘤、罕见病、产科复杂合并症、肾内/血液专科、儿科新生儿重症等不在 60 条知识库范围；超出范围时应由医生主导，红旗层仅作提示兜底。
- **无持久化/无多用户**：请求无服务端会话，刷新即失；未实现认证与审计日志。FHIR 对接自 v1.8.0 起提供 **light 只读导出**（`/api/dx` 的 `data.fhir`，见 ARCHITECTURE §9），但**不含**资源写回、Transaction/批次幂等、术语服务器校验与官方 Profile  conformant 声明——它是「可被集成的输出面」，不是完整 EHR 集成方案。刻意未引入浏览器本地会话缓存——把问诊叙述落到客户端存储属新增风险而非收益；隐私口径与数据留存声明已成文于 [`PRIVACY.md`](PRIVACY.md)（若将来引入任何持久化，须按其 §7 同步改写声明并把「零持久化」断言换成持久化白名单+加密断言，禁止删断言凑绿）。
- **日志留存与集中化**：结构化日志已具备可归因字段（`req/path/method/ms/kind/msg`），但仅走运行时 stdout（Cloudflare 免费额度保留期短），未接 Sentry/Langfuse/OTLP 后端（需外部账号与密钥）。跨会话的线上故障回溯仍未实现。
- **ICD-10 字段**：60 条已附初筛映射（组合条目分号并列；综合征/分诊类条目为 `null`），**未经临床复核前不得作为编码依据**。
- **知识时效**：条目含 source/year，过期撤回流程未建设；使用指南类结论前请核对来源年份。

## 4. 病种覆盖清单（60 条 · 20 个临床域）

按 `functions/lib/knowledge.js` 的 `scope` 首段聚合 `condition` 现算生成（第二十七轮起不再手抄；`tests/docs_link_guard.mjs` 逐域比对该清单与知识库，改名/增删条目未同步即判红）。

急诊（2）：急性冠脉综合征（待排除）、濒危/危重（优先转运） ｜ 心血管（6）：急性冠脉综合征（ACS）、主动脉夹层、高血压、体位性低血压、高血压（随访）、高血压急症/重度高血压伴靶器官损害
呼吸（8）：肺栓塞、自发性气胸、急性上呼吸道感染、流行性感冒、化脓性扁桃体炎、支气管哮喘、慢性阻塞性肺疾病、社区获得性肺炎 ｜ 神经（3）：头晕（前庭/全身性）、偏头痛、失眠障碍 ｜ 血液（1）：贫血
消化（5）：急腹症（需转诊）、上消化道出血、急性胃肠炎、胃食管反流病（GERD）、功能性消化不良 ｜ 内分泌（4）：2 型糖尿病、低血糖、甲状腺功能减退、甲状腺功能亢进症 ｜ 泌尿（3）：急性肾盂肾炎、泌尿系结石、良性前列腺增生
耳鼻喉（4）：过敏性鼻炎、急性中耳炎、鼻出血、急性会厌炎（气道急症） ｜ 皮肤（4）：带状疱疹、湿疹/接触性皮炎、荨麻疹、丹毒/蜂窝织炎 ｜ 风湿（1）：痛风 ｜ 骨科（3）：颈椎病/肩周炎、腰椎间盘突出（马尾红旗）、四肢外伤/骨折
儿科（4）：儿童发热（感染性为主）、手足口病、小儿腹泻伴脱水、肠套叠（需急诊） ｜ 妇产（4）：异常子宫出血、异位妊娠（急症）、阴道炎、痛经 ｜ 眼科（2）：急性闭角型青光眼（急症）、视网膜中央动脉阻塞（急症）
口腔（1）：牙髓炎/牙槽脓肿 ｜ 精神（2）：焦虑障碍、抑郁障碍 ｜ 感染（1）：脓毒症（急症） ｜ 老年（1）：老年综合征（跌倒/多重用药） ｜ 全科（1）：肋软骨炎/胸壁疼痛

## 5. 复现命令

```bash
cd frontend && npm test                 # 二十二件套：smoke 57（含双端同表红旗探针 12 条逐字对账）+ 引擎 31 例 + 检索双档地板 + 检索器 3 档双端 50/50 + 语义表守卫 22（含 7 组反例）+ live 路径红线 43 + 双端契约 31:31 + FHIR 导出 45 项（含 6 组反例）+ KB 守卫 17 + 路由守卫 25 + 隐私声明对账 59 + 配置契约对账 6 + API 契约对账 + vitest 组件 + 版本真值五方对账
node tests/coverage_floor_guard.mjs     # 覆盖率模块级地板（先跑 npm run coverage:js 生成 coverage/coverage-summary.json）
cd frontend && npm run coverage:js      # JS 覆盖率 + 地板棘轮（实测：全局分支 74.02%，红线模块单独设地板）
cd frontend && npm run coverage:py      # Py 覆盖率+模块地板（实测 90.53%，地板 88；阈值单一源见 fixtures/coverage_floor.json）
cd frontend && npm run lint               # 静态检查：ESLint（frontend）+ ruff（backend），--max-warnings=0
node tests/semantic_guard.mjs          # 语义邻接表：结构/白名单/无自环/降序整数千分比/弱对称 + 语料指纹防陈旧 + 双端同值 + 7 组反例
node tests/retrieval_eval.mjs --retriever=semantic                              # 语义档检索读数（默认 bm25）
# 语义通道权重标定（0 组严格优于 bm25）：标定脚本在参赛工作区侧不入库；
# 本仓内的可复现部分是防陈旧门禁与留出集：
npm run test:semantic                      # 邻接表双端同值 + 语料指纹防陈旧 + 留出集判定
python ../scripts/build_semantic_neighbors.py --engine-dir <bge_onnx_engine.py 所在目录>   # 知识库变更后重建邻接表（必做，否则 test:semantic 判红）
node tests/fhir_guard.mjs               # FHIR-light 单独跑：Bundle 结构/术语白名单/悬挂引用/零时钟/红线文案 + 反例可拦性
node tests/api_contract_guard.mjs       # openapi.json ↔ Functions 路由双向对账（6 端点）
node tests/bundle_size_guard.mjs        # 主包体积地板线（需先 npm run build；主 chunk ≤77.5KB / assets ≤86.5KB gzip）
                                        #      + 双端契约 31/31 + 知识库门禁 17 + 路由可观测性 14
node tests/retrieval_eval.mjs --retriever=hybrid   # 备选检索器口径（默认 bm25）
node tests/retrieval_eval.mjs --retriever=hybrid --write-baseline  # 收紧该检索器地板线（只准收紧）
node tests/retrieval_eval.mjs --fixture=retrieval_holdout.json --retriever=bm25   # 留出集（不参与基线断言）
node tests/retrieval_eval.mjs --fixture=retrieval_holdout.json --retriever=hybrid # 留出集对比同命令
python ../backend/tests/smoke_engine.py         # 后端降级链 19 项
python ../backend/tests/test_api_observe.py     # 后端可观测性契约 15 项
python ../backend/tests/test_fhir.py            # 后端 FHIR 导出 17 项（含 API 透出与双端术语集一致）
```

数据来源：`frontend/tests/fixtures/*.json`（评测集与基线，provenance 见 `_meta`）；根工作区 `iCAN大学生创新创业大赛/03-评测/eval_report*.json`。
