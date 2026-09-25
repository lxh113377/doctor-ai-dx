# 更新日志

本项目格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
评测口径以各版本附带的 31 例离线评测与 `docs/EVAL_CARD.md` 为准；任何涉及红旗规则层、引用白名单、"辅助参考 · 医生终审"文案的变更都会在对应版本显式标注。

## [Unreleased]

## [1.11.0] - 2026-09-25

### Added（文档与隐私面：对标同类 5/5 均无隐私/数据留存声明，本项为做优而非追平）
- `docs/PRIVACY.md`：**逐条从实现取实**的数据留存与隐私声明——服务端零持久化（无 DB/无文件写）、无客户端存储、接口 stateless（问诊历史由前端随请求携带）、日志字段白名单 `req/path/method/ms/kind/msg` 且**不写请求体与堆栈**、脱敏形态清单、唯一出站为 LLM 供应商且**必然携带问诊文本**（如实披露而不隐藏产品必要的数据流出）、演示与评测全为合成病例、密钥只走环境变量。**显式声明不构成 HIPAA/GDPR 等任何合规认证**，并列出试点前必补的 6 项未提供能力与「若引入持久化必须同步改写哪些条款」的硬要求
- `frontend/tests/privacy_guard.mjs`（30 项，入 `npm test` 为第十四项）：把声明里可机器化的条款钉成判据，**代码漂移即判红**——① 生产面（`frontend/src`、`frontend/functions`、`backend/app` 共 41 个文件，取自 `git ls-files`）零持久化原语、零第三方遥测 ② 日志调用点不得出现 `body/history/transcript` ③ 双端脱敏模式表同值且 6 用例输出逐字相同 ④ `PRIVACY.md` 引用的代码锚点全部存在（防文档腐烂）+ 锚点抽取数量下限（防判据未接线时的空集假通过）⑤ 合成病例标注、8s 硬超时、`.env` 不入库逐条核对
- 反例实测 5 组（注入 `localStorage`／注入 `fs` 写入／注入 `@sentry` 遥测／把问诊文本写进日志／锚点文件失效）全部可拦；另含**反向断言**：13 位毫秒时间戳不得被手机号模式误脱敏

### Changed
- **脱敏形态扩展（双端同步）**：`observe.js` ↔ `app/observe.py` 新增中国大陆手机号 11 位、18 位身份证号两类模式；两侧均加负向断言边界（`(?<!\d)…(?!\d)`），因 13 位时间戳内含满足手机号形态的 11 位子串，无边界会造成**假脱敏掩盖真问题**。实测双端 6 用例输出逐字一致、模式表同值
- `OBSERVE_PATTERNS` 双端导出，供门禁逐条比对（JS 正则源含 `\/` 转义，比对前归一化，否则 `internal` 组会假性不等）
- 文档：README 挂 PRIVACY 入口；`EVAL_CARD.md` §3 把「隐私口径与数据留存声明写明前不做客户端存储」改为指向已成文的声明并写明改动义务、§2 新增隐私一致性行；`ARCHITECTURE.md` §7 新增门禁行

### 由反例暴露并修掉的判据缺陷（如实登记）
- 初版遥测清单只认 `sentry.io` 域名，反例注入 `@sentry/browser` **零命中**——而 npm 包名与 `Sentry.init(`/`dsn:` 才是实际最常见的引入方式，域名形态反而少见。补全为 12 条形态后反例转绿。教训：**判据要按真实形态写，不按最容易想到的形态写**

### 红线影响
无。三条红线逻辑零改动；客户端存储仍**不引入**（属产品决策，本轮只补声明与门禁）。默认检索档仍 bm25。

## [1.10.0] - 2026-09-25

### Added（维护/质量基建：把"测试通过"升级为"哪些分支被执行过"）
- **覆盖率度量基建**：对标实测成熟层项目 3/3 已有覆盖率配置（`phlox` `.coveragerc`+Makefile、`OpenEMR` `codecov.yml`+jest.config、`ragflow` `codecov.yml`），我方此前为零。本轮引入 **c8 12.0.0**（JS/Functions 面）与 **coverage.py 7.16.0**（Py 镜像面，配置 `backend/.coveragerc`，形态借鉴 phlox），并**刻意不接 Codecov 等外部服务**——与本项目"零外部件/零密钥离线可复现"的架构口径一致；dev 依赖独立到 `backend/requirements-dev.txt`，实测容器运行时镜像内 `import coverage` 仍报 ImportError（dev 未泄漏进生产镜像）
- `tests/coverage_floor_guard.mjs`（25 项）：**按模块级**地板（rules/engine/fhir/rag/retriever/knowledge + 全局），因全局均值会掩盖红线模块单独退化。三条硬判据：输入非空证明（summary 缺失即红）、模块级地板、**地板清单与产物改名对账**（模块被改名/删除不得静默失效）。反例三组实测均判红：移走 summary → `1 pass/1 fail`；地板抬到 99.5 → `24 pass/1 fail`；模块改名 → 同时触发"改名对账"与"红线模块在册"两条 FAIL
- `frontend/tests/live_path_guard.mjs`（36 项，入 npm test 为第十三件套之首链）：注入 `globalThis.fetch` 桩 + 占位 Key，**离线覆盖生产实际走的 live 分支**——① 模型编造白名单外 `evidence_id` 被确定性校验剔除并回填合法引用 ② 模型返回 `flags: []` 仍被规则层重算覆盖（红旗不可被模型推翻）③ 模型自带 `evidence` 清单被检索结果覆盖 ④ 7 类降级（非法 JSON／primary 空／HTTP 500／429／缺 choices／json() 抛错／fetch reject）逐条断言 `rule-fallback` + `fallback_reason` + 红旗不削弱 + 仍产出 FHIR Bundle ⑤ 无 Key 零外呼 ⑥ 报告缺 `disclaimer` 时注入「医生终审」默认文案 ⑦ 系统提示词红线关键词在册
- `backend/tests/test_live_path.py`（25 项）与 `backend/tests/test_retriever_channels.py`（25 项）：后端镜像面同判据（桩 `httpx.post`）。后者回应实测盲点——`app/retriever.py` 仅 37%：hybrid/semantic 通道过去**只被 parity 经 subprocess 比对**，"比对保证两端一致，不保证两端都对"

### Changed（覆盖率提升为实测结果，非声称）
- `engine_smoke.mjs` 27 → **43 项**：补红旗规则分支边界——血压 180/120 恰界（判据是 `>=`）、179/119 不命中、仅舒张压越界、全角斜杠 `／`、空格写法 `185 / 110`、超生理上限 999/999 与下限 40/15 拒收、无斜杠不误判、同规则去重、组合规则单线索不触发/多线索才触发、空串与纯空白、超长文本截断、中英混排、命中结构含 `name/severity/advice`、红旗字符串契约格式不变
- `fhir_guard.mjs` 30 → **45 项**：补 FHIR 条件分支——性别非二元落 `unknown`、`女`→female、组合 `icd` 按分号拆成多条 coding（实测 kb-028 = `M54.2; M75.0`）、`icd=null` 只出 text、鉴别诊断无 note 时出空数组、证据无 url / 非 http 链接时不产 `presentForm`、首要诊断截断 4 条与鉴别截断 6 条、红旗明细截断 8 条 component、症状截断 12 条、患者无姓名时不产出空 `name` 占位
- `docker-compose.yml` 的 `selftest` 由 3 套扩为 **5 套**（容器内实测 19/15/16/25/25 全绿 exit 0）；`.gitignore` 增覆盖率产物忽略项
- 文档：`ARCHITECTURE.md` §7 门禁行改十三件套并新增 JS/Py 覆盖率地板两行、容器行更新；`EVAL_CARD.md` §2 新增覆盖率指标行、§5 增复现命令；`README.md` 自动化验证段更新

### 实测覆盖率涨幅（本轮全部为实跑取数）
- JS/Functions 面：语句 92.12→**94.75%**，分支 67.04→**74.02%**，函数 91.42→**94.28%**；其中红线相关 `engine.js` 分支 53.12→**69.23%**、`rules.js` 78.12→**88.88%**、`fhir.js` 66.21→**76.92%**
- Py 镜像面：总覆盖 73.33→**87%**（`.coveragerc` 排除无语义行口径；未排除口径 88.79%，两者均高于地板 85）；`llm.py` 37→**90%**、`retriever.py` 37→**98%**、`engine.py` 61→**74%**

### 红线影响
无。新增的是**测试与度量**，未改任何判定逻辑；三条红线在 live 分支上首次获得自动化保护（此前只被 rule-fallback 路径测过）。默认检索档仍 bm25，客户端产物 hash 零变化。

## [1.9.0] - 2026-09-25

### Added（可扩展性：语义通道，含实测负面结论）
- **语义邻接表离线蒸馏链**：`scripts/build_semantic_neighbors.py` 用本地 BAAI/bge-small-zh-v1.5（512 维，权重 sha256 `69a0b846…` 记录在产物头）对 55 条知识库做 pairwise 余弦，蒸馏为条目↔条目邻接表并双端同源落盘（`functions/lib/semantic_neighbors.js` ↔ `backend/app/semantic_neighbors.py`，440 对 / 每条 8 邻 / 千分比整数）。**运行时零模型、零网络、零向量服务**——本项目权威面是 Cloudflare Pages + Functions（serverless），托管不了同类项目普遍外挂的 Milvus/Chroma/FAISS/TEI
- 检索器注册表新增 `semantic` 档（BM25 种子 + 语义近邻通道加权 RRF），**opt-in，默认仍 bm25**
- `frontend/tests/semantic_guard.mjs`（22 项，入 `npm test` 第十二项）：表结构/引用白名单内/无自环/分数降序且为整数千分比/弱对称一致/**语料指纹防陈旧**/双端 provenance·常量·表值同值/**红线：默认档未变**；含 7 组反例实测（越界 id／自环／乱序／越界分数／静默丢条目／破坏对称／击穿地板）+ 合法对照组零命中
- `work/sweep_semantic_weights.mjs`：54 组权重网格在 50 例标定集 + 20 例留出集上出双集对照，判据要求**严格优于** bm25

### 实测结论（未采纳为默认，如实登记）
- 留出集上「严格优于 bm25」的组合 = **0 组**；9 组与 bm25 逐位等值（权重过低⇒通道惰性，非增益）；其余 45 组劣化，ΔMRR 最差 −0.328。标定集同样无增益——bm25 在 50 例 top-5 已 100% 命中，无提升空间
- 根因：该通道只对**条目**建邻接、无法对**查询**编码，只能重排名次；真正的语义召回必须引入查询侧 embedding（即同类项目外挂向量服务的原因）
- 「条件触发」路线经实测判定**不可解**：漏检例 BM25 top1 分数 14.39/17.65 与命中例最低 12.41 区间重叠 → 按 R236 补注③ 应改机制而非调参，未引入伪阈值
- 保留为语料扩容（55→200+）后的复测位，与 `adjacencyChannel`（标定权重为 0）同一处置惯例

### Changed
- `frontend/tests/retriever_parity.mjs` 由硬编码 `hybrid` 泛化为**遍历注册表全部档位**（bm25/hybrid/semantic 各 50/50）——原实现下新增档不受双端判据保护
- 文档：`ARCHITECTURE.md` §3 语义通道与实测结论、§7 门禁改十二件套、§8 新增「知识库一改必重建邻接表」扩展点；`EVAL_CARD.md` §2 增 semantic 指标行、§5 增复现命令；`README.md` 自动化验证与检索器说明同步
- 客户端产物 hash 零变化（`index-XkAWhl6S.js`，73.81KB gzip）：9KB 邻接表只进 Functions 服务端，不进前端包，体积地板线复跑 ALL PASS

### 红线影响
无。默认检索口径仍 bm25（线上零改动）；红旗层与引用白名单未触碰；语义通道输出的每个 id 都由门禁断言在引用白名单内。

## [1.8.0] - 2026-09-25

### Added（功能模块覆盖：对外集成面）
- **FHIR R4（light 子集）导出层**：`/api/dx` 响应新增 `data.fhir`——标准 Bundle（Patient + Encounter + Condition + Observation + DiagnosticReport），兑现 README「可被既有 HIS/公卫平台集成的能力单元」此前未落地的部分。实现为 `frontend/functions/lib/fhir.js`（权威）与 `backend/app/services/fhir.py`（镜像）双端同源，纯函数、零网络、零 LLM
- `frontend/tests/fhir_guard.mjs`（30 项）：Bundle 结构自洽、术语编码白名单（8 个 HL7 已发布 CodeSystem + 本仓命名空间锁两值）、悬挂引用检测、零时钟字段断言、红线文案断言（`conclusion` 必含「医生终审」）、ICD 溯源断言（`icd=null` 的条目只出 `text` 不出 `coding`）；**含 6 组反例实测**（非法 system／非法 code／悬挂 reference／混入 timestamp／丢终审文案／编造 ICD）+ 合法对照组零命中，证明判据已接线而非恒真
- `backend/tests/test_fhir.py`（17 项）并挂入 CI `backend-test`：API 层透出（Pydantic 未吞字段）、双端 CodeSystem URI 清单一致、空输入兜底
- `docs/ARCHITECTURE.md` 新增 §9「FHIR-light 导出层」：资源组合、插入点（确定性校验与红旗兜底**之后**）、逐条术语绑定来源与边界声明
- **容器化 FastAPI 镜像面**（round8 因守护进程不可用暂缓，本轮守护进程实测可用后落地并全程实跑）：`backend/Dockerfile`（`python:3.12-slim`，依赖层分离、镜像内置 `BACKEND_HOST=0.0.0.0`、HEALTHCHECK 打 `/api/health`、测试随镜像提供）+ `backend/.dockerignore` + 根 `docker-compose.yml`（`backend` 服务 + 一次性 `selftest` 服务）。实测：构建成功（235MB）、`health` 返回 `version 1.8.0` 且 `mock-fallback`、`/api/dx` 命中红旗 1 项并产出 21 条 Bundle entry、容器内三套断言 19/15/16 全绿 exit 0、HEALTHCHECK `healthy`

### Changed
- 前端离线套件由十件套扩为**十一件套**（`npm test` 增 `test:fhir`）
- `docs/openapi.json` 的 `Diagnosis` schema 补 `fhir` 字段说明（手工契约文档，按既有口径只做字符串级改写，不全量重写）
- README API 契约表 `/api/dx` 响应列补 `fhir`，并新增 HIS 集成说明段
- `docs/EVAL_CARD.md` §3 状态性表述回扫：原「未实现…FHIR 对接」改为「v1.8.0 起提供 light 只读导出，但不含写回/事务/术语服务器校验/官方 Profile conformant 声明」——避免交付材料里的能力声明落后于实现
- `docs/ARCHITECTURE.md` §7 与 `EVAL_CARD.md` §5 计数纠正：`kb` 门禁实际为 17 项（round9 增第 17 项后此两处未同步），前端套件计数同步为十一件套

### 红线影响
无。红旗规则层仍独立且在导出之前执行；引用白名单未扩；「AI 辅助参考 · 医生终审」文案在 Bundle 结论中同样强制（并由门禁断言）。双端契约 31:31 逐字段对账已覆盖新增的 `fhir` 对象。

## [1.7.0] - 2026-09-25

### Fixed（🔴 引用面实质缺陷修复）
- **16 条「假回链」域名纠正**：新增的联网门禁 `tests/link_health.mjs` 首跑即实测发现 `cmas.org.cn`（15 条）与 `www.nhoc.org.cn`（1 条）**DNS 根本不解析**——这类 url 让引用看似可溯源而实际不可达，比空 url 更危险。已逐条改指向实测 HTTP 200 的正确官方域：`www.cma.org.cn`（中华医学会，13 条）与 `www.medjournals.cn`（中华医学期刊网，3 条：《中华内分泌代谢杂志》×2、《中华耳鼻咽喉头颈外科杂志》×1）；`export_kb.mjs` 重导出 `knowledge.py` 保持双端零漂移。改前后实测：DEAD 3 → **0**，`www.nhc.gov.cn` 412 归为 BLOCKED（WAF 反爬、站点存活，只报不红）
- `start-demo.sh` 补执行位（`git update-index --chmod=+x`，实测首提交为 100644 需 `bash` 前缀）；README 主用法改 `bash start-demo.sh` 以对所有平台成立

### Added
- `frontend/tests/link_health.mjs` + `npm run test:links` + CI `.github/workflows/link-health.yml`（每周三，观察期不阻断）：**唯一联网门禁**，与离线十件套隔离（离线套件保持零网络确定性）；分级 OK / BLOCKED(401/403/412/429/451) / DEAD，非存活自动重试 2 次防抖动误红，`BLOCKED_BASELINE` 显式登记 nhc 反爬基线
- `kb_guard.mjs` 新增第 17 项**离线已核验域名白名单**（`VERIFIED_HOSTS` 4 host）：未登记域名的 url 直接 FAIL——治本防「拼错/不存在域名冒充回链」再犯。反例实测：把 `cmas.org.cn` 塞回即同时触发白名单 FAIL + 双端深度相等漂移报警（17→15 pass/2 fail），还原后 17 pass/0 fail
- `docs/ARCHITECTURE.md` 增「引用链健康」门禁行与「补链流程」扩展点（补链须先实测可达再加白名单，禁写未核验链接）；`docs/EVAL_CARD.md` 溯源小节加 2026-09-25 校正注（保留原表述，因其当时为真）

### Not done（实测受阻，如实登记）
- 文档级**深链补链**：中文指南全文在官方域内检索无结果；一级出版方候选 `ahajournals.org` DOI 实测 403、`medjournals.cn` 期刊页深链实测 404/JS 空壳 → 按红线「禁止写入未核验链接」维持深链=0，转人工站内定位后再补
- Docker 化：本机守护进程不可达（`docker version` 连不上 npipe），运行时基建不得先写后验

### Tests
- 十件套全绿（kb 守卫 16→17 项）：smoke 27 / engine 31 / retrieval 双档 / parity / 契约 31:31 / kb 17 / route 14 / api 对账 / vitest 7 / version 5；后端 19+15 全绿；链健康实测 OK=3 BLOCKED=1 DEAD=0

## [1.6.1] - 2026-09-24

### Added
- `docs/ARCHITECTURE.md`：六段链路图 + 三条产品红线的代码插入点 + JS/Py 双端镜像对账矩阵（7 组语义↔守卫）+ 检索层实测参数（K1 1.5 / B 0.75 / 500 字截断 / top_k 1..10 / 32 红旗加权词）+ 环境变量与端口口径 + 门禁清单；数字全部磁盘实测（13 单词红旗 + 4 组合红旗 + 血压 180/120、KB 55 条含 ICD 51 条）——对标 ragflow/CQL/OpenEMR 的 docs 树缺口（round8 实测三家有 docs/ 而我方仅 2 件）
- `start-demo.sh`：跨平台一键演示启动（Linux / macOS / Windows Git Bash），与 `start-demo.ps1` 同三步口径——**实跑验证**：起服 :8788、`/api/health` 返 `mock-fallback + version 1.6.1`、`POST /api/dx/c1` 命中 ACS 红旗且返回 3 项诊断 / 8 条引用（对标 phlox 的 compose/Makefile 跨平台面）
- `.pre-commit-config.yaml`：提交前快检子集（版本真值 / 知识库零漂移 / 契约对账 / OpenAPI 版本漂移四只钩子），全部 `language: system` 复用仓内既有守卫，零网络拉取、零第二套判据；`pre-commit run --all-files` 实测 4 Passed，注入版本漂移实测 exit=1（正反例双过）

### Changed
- README：启动章节改列一键脚本（sh/ps1 双平台）；文档区挂载 ARCHITECTURE 与 pre-commit 两条

### Security
- 依赖审计首跑抓到 3 项真实发现并清偿（dev-only 测试依赖，不触线上产物）：`happy-dom` 17→20.14.5（GHSA-37j7-fg3j-429f VM 逃逸 RCE，critical）、`vitest`/`@vitest/mocker` →4.1.11（GHSA-82fw-gwwq-j7x9 路径穿越，moderate）；vitest 4 下组件测试 7/7、十件套全绿，顺带移除误加的 `@vitest/coverage-v8`（本仓无覆盖率承诺，不虚设）

## [1.6.0] - 2026-09-24

### Added
- **版本真值链**（round7 对标实测抓到三处漂移：`main.py 0.2.0` / `package.json 0.2.0` / `openapi 1.5.0` / tag `v1.5.0`）：`backend/app/version.py` + `functions/lib/version.js` 双端单一源，双端 `/api/health` 响应新增 `version` 字段（纯增字段，六端点契约零破坏）；`tests/version_guard.mjs` 五方对账（四处声明同值 + 对最新 SemVer tag 单调不减，fail-closed）入 `npm test` 第十项；`scripts/gen_openapi.py` 只外科同步 `info.version` 单行（字符串级替换+改后 JSON 回验，禁全量重写手工契约排版——实测全量覆盖曾打爆 api_contract_guard 10 项）；CI 增 `gen_openapi.py --check` 漂移步骤
- **社区健康面**：`SECURITY.md` 风险面声明 + 协调披露（对齐 OpenSSF/OSMB CVD 最小模板裁剪，明示"什么不算漏洞"防无效报告，红线三重防线写入）；GitHub Discussions 启用（Q&A / Show and tell 分类）；仓库私有漏洞报告通道开启
- `.github/ISSUE_TEMPLATE/`（bug/feature 双表单，内嵌红线自查与脱敏提醒）与 `PULL_REQUEST_TEMPLATE.md`（红线/门禁证据/文档同步三段自查）——清偿 round1 差距面"无 issue 模板"欠账（"差距描述必进清单"对账执行）
- CONTRIBUTING 增"依赖维护策略"节（auto-merge 口径 / 聚合批 / major peer 前置）；仓库启用 native auto-merge

### Changed
- `frontend/package.json` version 0.2.0 → 1.6.0（历史欠账：发布线已至 v1.5.0 而包版本未跟）；`docs/openapi.json` info.version 经脚本同步 1.6.0

### Tests
- 十件套全绿：smoke 27 / engine 31 / retrieval 50 例双地板 / retriever-parity / contract 31:31 / kb 16 / route 14 / api 契约对账 / vitest 7 / version 5；后端 19+15；version_guard 正反例实测（注入 1.6.1 漂移 → exit 1 抓到，还原 → 全绿）

## [1.5.0] - 2026-09-24

### Added
- `docs/openapi.json`：Functions（线上权威）OpenAPI 3.0.3 机器可读契约，README 挂载；`tests/api_contract_guard.mjs` 契约↔实现双向对账入 `npm test`（round1 §2.6 遗留补票）
- `tests/bundle_size_guard.mjs`：主包体积地板线（主 chunk gzip ≤77.5KB / assets 合计 ≤86.5KB，按 19.3.0 实测 73,806/82,174B + 约5% 余量标定），build 后 CI 步骤执行
- README 三徽章（CI / Latest release / CodeQL）

### Changed
- actions/setup-node v4 → v7（覆盖 Dependabot #1，聚合于本轮）


## [1.4.1] - 2026-09-24

### Changed
- 依赖治理轮：Actions 四件套升级 checkout v7 / setup-python v7 / upload-artifact v7 / download-artifact v8（v4 系已弃用；聚合覆盖 Dependabot #2-#5）
- react / react-dom 19.2.8 → 19.3.0，wrangler 4.128.0 → 4.135.0（覆盖 #6 #11 #13）；主包 gzip 实测 65.07 → 73.81KB（React 官方体积变化，如实入账）
- backend 依赖下限提升：fastapi≥0.141.1 / uvicorn[standard]≥0.53.0 / httpx≥0.28.1 / python-dotenv≥1.2.3（覆盖 #7-#10）

### Notes
- 每批均经聚合 PR CI 双 job + CodeQL 全绿后 squash 合入（#15/#16），被覆盖 Dependabot PR 关闭留痕、可 /rerun 重建
- #12（@vitejs/plugin-react 4→6）经实测因 peer 要求 vite^7 暂不合入，已在 PR 留言说明并挂框架升级单独批次


## [1.3.0] - 2026-09-24

GitHub 开源对标第二轮（6 家同类项目 `gh api` 实测数据驱动）改进批次。红线三项零触碰。

### Added
- **知识库入库门禁** `frontend/tests/kb_guard.mjs`（16 项，入 `npm test` 与 CI）：55 条逐条 schema 强校验（id 顺延唯一 / year 区间 / https url 形态 / keywords ≥3 不重复 / text 长度 / `icd` 形态或显式 `null`）、`SYMPTOM_TO_KB` 引用完整性、孤儿条目检测、`knowledge.py` 手改漂移深度比对（四组数据 JS/Py 全等）
- **溯源等级棘轮**：按「深链 / 机构门户 / 未链」三档记录真实分布（实测 0 / 23 / 32），未链数只准减少、深链数只准增加；`docs/EVAL_CARD.md` §1 如实披露「引用可溯源」目前成立到指南名+年份+域名一级，尚无文档级深链
- **请求级可观测性** `functions/lib/observe.js` ↔ `backend/app/observe.py`：每请求 `X-Request-Id`、错误结构化日志（`req/path/method/ms/kind/msg`，不落堆栈不落请求体）、出站前脱敏（`sk-` 形态 / 运行期密钥原文 / 内部路径 / 300 字截断）、>8s 慢请求告警；前端错误文案带可对账故障编号
- 可观测性契约测试：`frontend/tests/route_guard.mjs`（14 项，直接调 Pages Functions `onRequest`）、`backend/tests/test_api_observe.py`（15 项），双双入 CI
- **`hybrid` 检索器**（opt-in，默认仍为 `bm25`）：BM25 主干 + 概念通道（同义词组扩条目 + 症状线索直连）加权 RRF 融合；权重由 `work/sweep_hybrid_weights.mjs` 在 50 例集上网格标定
- 检索评测集 v2.0：20 → **50 例**，新增 30 例患者口语化改写查询（刻意避开 `keywords` 书面术语），`_meta.provenance` 登记标注依据与合成性质
- 检索器双端一致性测试 `frontend/tests/retriever_parity.mjs`（50 例逐字段 id + 分数）；检索基线改为按检索器分档地板
- `SECURITY.md`（已实现控制 / 明确未保障项 / 报告渠道 / 支持版本）与 `CONTRIBUTING.md`（双端同步矩阵、提交前必跑门禁、知识库与评测集变更规范），README 挂载入口

### Fixed
- **症状词表漂移**（真实缺陷）：抽取层硬编码 42 探针与映射层 `SYMPTOM_TO_KB` 42 键仅 38 个交集 —— 4 条死探针（`冷汗/意识/呕血/黑便` 命中后召回 0 证据）+ 5 条不可达键（`血压高/咽痛剧烈/小儿发热/儿童腹泻/下肢放射痛` 永远检测不到）+ 6 条孤儿知识条目。改为探针清单从 `SYMPTOM_TO_KB` 派生（JS/Py 同源）并补 18 条映射：症状线索 42→60，条目覆盖率 89.1%→**100%**
- **双端取整规则不一致**（真实缺陷）：Python 内置 `round()` 为 half-to-even、JS `Math.round` 为 half-up，`.5` 边界末位差 1（`0.020313` vs `0.020312`）。新增 `app.rag.round_half_up` 使两端取整规则一致（不靠放宽容差掩盖），`rag.py` 同步采用
- FastAPI 422 外泄 `detail` 字段路径数组，与 Functions 端 `{code,message}` 契约不对称 → 改 `RequestValidationError` 处理器输出医生可理解文案 + 故障编号
- `get_settings()` 的 `lru_cache` 快照使日志脱敏取不到运行期新写入的密钥 → 新增 `config.current_api_key()` 实时读
- `backend/app/retriever.py` 相对导入越界（`..knowledge` → `.knowledge`），由双端一致性测试首跑暴露

### Measured（同码同集复跑口径）
- 检索 Recall@5：BM25 在扩充后的 50 例集上 0.95(20 例) → **0.85(50 例)**，为评测集变严所致；`hybrid` 0.870（+2.0pt），**红旗子集 0.891（+4.4pt）**，代价 MRR 0.867 → 0.825 → 结论是「召回优先」取舍而非全面更优，故不改默认口径
- 知识图近邻通道在标定网格上最优权重为 0（无增益），保留函数但不进融合，结论已写入代码注释
- 结构/引用/降级/双端契约：31/31 零回归；主包 gzip 65.07KB（较 1.2.0 零增量）

## [1.2.0] - 2026-09-24

### Added
- 知识库 55 条条目新增 `icd` 字段（WHO ICD-10 默认版初筛映射；组合条目分号并列，综合征/分诊类条目为 `null` 待临床复核），双端检索证据对象透出该字段
- 双端黄金用例契约测试 `frontend/tests/contract_parity.mjs`：31 组确定性输入分别跑 Functions(JS) 与 FastAPI 镜像(Python) 引擎，dx/workup/report 逐字段比对（数值容差 0.002），并入 `npm test` 与 CI
- CI `build-and-test` job 增加 Python 3.12 环境以执行双端契约比对
- `docs/EVAL_CARD.md` 评测卡与安全卡：能力边界、病种覆盖清单、检索/红旗/延迟指标一页可查

### Changed
- `llm.py` 抽出 LLM Provider 抽象（`OpenAICompatProvider` 默认实现），超时/重试/模型名收敛到 Provider 层，业务引擎不再直连 HTTP 细节

### Fixed
- Python 检索镜像与 JS 权威实现漂移修复（契约测试首跑捕获）：同义词扩展由 `join("")` 整串分词改为逐词分词去重（消除跨词伪 bigram）、查询归一小写、500 字符截断、`top_k` 钳制 1..10、排序改显式稳定序
- Python `evidence_for_symptoms` 由 `set` 改为保序映射，消除 PYTHONHASHSEED 引起的双端随机漂移
- `export_kb.mjs` 生成链支持 `null` → Python `None` 转换（新增可空字段后原假设失效）

## [1.1.0] - 2026-09-23

### Added
- 红旗结构化输出 `flag_details`（name/severity/advice）双端镜像
- 前端 `useIntakeFlow` hook、AbortController 请求兜底、React.lazy 五视图分包（主包 gzip 64.99KB）
- 检索器注册表（`retriever.js`/`retriever.py`）：BM25 为首个注册实现，向量/混合检索可按配置扩展且不侵入引擎

### Fixed
- `api.js` 网络错误透传缺口改医生可理解文案；ErrorBoundary `resetKey` 切病例自动重置；`data.js` 旧知识库双源清理

## [1.0.0] - 2026-09-17

### Added
- iCAN 提交冻结版：临床状态抽取 → BM25 证据检索 → LLM 结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级全链路封板
- 离线评测 31/31（结构/引用/降级标注）、红旗召回 27/27、线上 14/14、P95 4.7s；双视口（1440/390）浏览器 E2E 通过
- Cloudflare Pages + Functions 一体化部署（DeepSeek live）与 FastAPI 镜像后端；CI build+deploy

## [0.x] - 2026-09-04 之前

- 原型（proto-doctor-ai-dx，5 屏静态 SPA）→ MVP 初版（FastAPI 后端 + React19 前端五视图）→ 行业研究报告
