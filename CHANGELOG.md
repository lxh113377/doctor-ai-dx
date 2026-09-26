# 更新日志

本项目格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
评测口径以各版本附带的 31 例离线评测与 `docs/EVAL_CARD.md` 为准；任何涉及红旗规则层、引用白名单、"辅助参考 · 医生终审"文案的变更都会在对应版本显式标注。

## [Unreleased]

## [1.22.0] - 2026-09-26

第二十四轮对标发布轮。本轮的对标对象从"成熟工程的 CI 面"切到**功能可比同类**（13 个 medical-RAG / CDSS 仓逐文件取证），
由此拿到两处此前无人问到的产品级缺陷，并把两条对外声称升级为机器判据。

### Fixed
- 🔴 **红旗规则层的否定词漏判（假阳性，属安全叙事级）**：规则层按子串命中，`无气促` 因此命中 `气促`。
  实测 `ev-06`（主诉"发热3天伴咽痛"＋回答"无气促"，期望 `expect_flag=false`）在**产品真实输入**上打出
  **脓毒症红旗**——感染线索来自主诉、器官灌注线索来自被否定的症状。修复＝命中点前 4 字若以
  `无/没有/未/未见/未出现/无明显/无伴/不伴/否认/阴性` 起头则该次出现作废（任一阳性出现仍算命中）；
  `无尿`（尿闭，真阳性体征）列为例外词，且 `无尿痛` 里不得命中 `无尿`。双端（`rules.js` ↔ `rules.py`）同改。
  **刻意不收 `不`/`排除`/`不支持`**——`不能排除心前区闷痛` 若被抑制就是漏报，本层失败代价不对称（漏报 >> 多提示）。
- 🔴 **该假阳性为何活了六轮没人看见**：`engine_eval.mjs` 判红旗用的是 `scanFlags(answers)`（纯答案），
  而产品算的是 `extractState` 的 `主诉；答案`——**判据测的不是产品**。改为直接断言 `diagnosis.flags`
  （产品真实输出），删掉第二套口径。变异实测：把否定守卫旁路 → `26/27` 并点名脓毒症误报，rc=1，逐字节回滚。
- **文档以仓外路径作凭据**：`README`/`CONTRIBUTING` 让人跑 `../../iCAN…/live_eval.mjs`、`../../work/perf_gate.mjs`、
  `../memory/08-ac-obs.md`——这些在本机可解析（仓外面恰好摆着参赛工作区），第三方 clone 后**全是死路**。
  `docs_link_guard` 的 `PATH_RE` 只认四个顶层目录起头，所以"零假凭据"一直判绿；新增 `../` 判据后**首跑即抓到 3 处**
  （含 PITFALLS 自己举的示例）。生成器/评测脚本收进仓内（`scripts/export_kb.mjs`、`scripts/live_eval.mjs`、
  `scripts/perf_gate.mjs`）。注：`\w` 不匹配中文目录名，首版正则恒绿、被变异实测打回后改显式排除裸 `../`。

### Added
- **诊断排序金标准面**（对标直接结论：功能可比 peer 普遍发表 top-1/top-3／critical sensitivity，
  我方 31 例只测结构/引用/降级三类通过率，**没有任何一条判据问过"给出的诊断对不对"**）。
  `tests/fixtures/dx_gold.json`（31 例逐例标注，含 `kb_gap` 单列）+ `tests/accuracy_guard.mjs`（十九件套）：
  **top-1 26/31=83.9%、top-3 29/31=93.5%、危急类 top-3 召回 22/23=95.7%（主指标）**，地板写在 fixture 由守卫现场重算。
  诚实口径：病例与标注同源自产，该数只衡量"自建病例→自建 55 条库→引擎排序"三者自洽，**不是真实世界准确率**
  （借鉴 urobot-tw／Medico 的自陈惯例）。两组变异实测均判红（产出诊断名错位 → top-1 归零被抓；
  金标准少一条 → 同构校验点名 `ev-14`，而不是拿 30 例继续算分母）。
- **知识库缺口清单**（由上述 `kb_gap` 机器产出，替代"感觉库太小"）：`胃食管反流病`、`肋软骨炎/胸壁痛`、
  `社区获得性肺炎`、`功能性消化不良/慢性胃炎`、`高血压急症`（现仅 `高血压` 慢病管理条）。
- **双端红旗探针表对账**：`smoke_engine.py` 与 `engine_smoke.mjs` 的"逐字同表"此前是口头约定（实测全仓除定义处零引用），
  现由 `engine_smoke.mjs` 按字面解析镜像端表并全等比对，条目数与内容任一漂移即红＋表被删/改名不得静默通过。
  本轮它立刻抓到我自己的单边编辑一次。
- **线上性能指标改为机器每周复现**：`live-smoke.yml` 新增 `online-eval` 作业跑 `scripts/live_eval.mjs` +
  `perf_gate.mjs`，回执写进作业摘要。EVAL_CARD 的 p50 4.1s/p95 4.73s（2026-09-16 一次本机运行、脚本在仓外）
  换成 2026-09-26 实测 **p50 3.756s / p95 4.890s / max 5.097s，31/31 live、红旗 14/14**。
  `perf_gate` 报告缺失判 **exit 2 UNKNOWN** 而非放行（同 `ci_watch.py` 的"没观察到＝不通过"口径）。
- `.gitignore` 增 `.eval/`（评测原始报告不入库，避免"陈旧副本 vs 当前实测"第二真值）。

### Changed
- `AGENTS.md` 校正一处会把贡献者引向改生成物的反向表述：知识库权威源是 `frontend/functions/lib/knowledge.js`，
  `backend/app/knowledge.py` 是生成物（实测生成器方向后确认，原文写反）。收进 `scripts/export_kb.mjs` 后重跑，
  与 HEAD 差异**仅 1 行注释**、55 条目 1580 行逐字节相同 ⇒ 收编过程零数据漂移。

**三条产品红线逻辑零改动**（红旗仍独立于 LLM 且不可被模型覆盖；终审文案与引用白名单未动）；
默认检索档仍 bm25；评测仍是同一批 31 例。本轮改红旗层属**减少误报**（精确化），未放宽任何命中：
阳性对照 8 条（含 `无尿` 真阳性、`血压190/110伴剧烈头痛`）全部仍命中，阴性对照 10 条全部不命中。

## [1.21.1] - 2026-09-26

补丁版，零功能改动。两处都是**本轮刚装的判据在 CI 上真跑时抓到的**，本机因 Docker Desktop 守护进程中途不可达而没能提前发现。

### Fixed
- 🔴 **`infra-lint` 在 main 上判红**：`.github/workflows/live-smoke.yml:32` 被 actionlint 内嵌的 shellcheck 报 `SC2034: i appears unused`（就绪等待循环只数次数不用循环变量）。改 `for _ in ...`，不放宽 actionlint、不给规则加豁免。第二十一轮那句话再次成立：这套静态把关上线后第一轮就拦到作者本人——区别是这次拦它的判据本身也是本轮新装的。
- 🔴 **出包链与预检链不同闸（真实后果，不是理论风险）**：`release.yml` 的「出包前置门禁」此前**不含** `infra-lint` 的任何一步，所以 main 的 CI 已红的提交照样产出了 `ghcr.io/lxh113377/doctor-ai-dx:v1.21.0` + `:latest` 与 GitHub Release。本次即实证：v1.21.0 的镜像与 Release 来自一个 actionlint 红的提交，且已公开可拉 ⇒ 按既有规矩**不重锚 tag**，改出 v1.21.1。
  处置＝把三条**不依赖 docker** 的新闸并进出包前置门禁：`scripts/dep_completeness.py`（import↔声明、非 optional peer↔锁）、`scripts/action_pin.py --verify`（钉版与上游 tag 逐字对账）、`scripts/live_smoke.py --selftest`（判据先自证）。
  仍留在 CI 侧的边界（如实登记，不假称已同闸）：`actionlint` / `hadolint` / `docker compose config` 需要拉镜像，不进 release 门禁——否则出包链会被外部可用性绑死。

### 影响面
三条产品红线（红旗独立于 LLM、引用白名单、"辅助参考 · 医生终审"文案）逻辑零改动；默认检索档仍 bm25；评测仍是同一批 31 例；对外 API 行为零变化（线上 `version` 由 1.21.0 变 1.21.1，`live_smoke.py` 12 条断言全过）。

## [1.21.0] - 2026-09-26

第二十三轮对标发布轮。主题＝**CI 自身的供给链 + 上游反馈闭环 + 已发布交付物的持续可用**。
三条产品红线（红旗独立于 LLM、引用白名单、"辅助参考 · 医生终审"文案）逻辑零改动；默认检索档仍 bm25；评测仍是同一批 31 例。

### Added
- **Actions 供应链钉版与最小权限判据** `scripts/action_pin.py`（`--resolve` 迁移与 `--verify` 判据共用同一枚举器，不留第二真值；15 项判据）。对标实测：peer `bloodworks-io/phlox` 4 份工作流 33/33 处 `uses:` 全钉 40 位提交号，`openemr/openemr` 79 份里 61 份显式 `permissions:`，而我方 5 份 31 处**全部**浮动在 major tag 上、仅 1 份有顶层 `permissions:`。major tag 可被上游随时移指 ⇒ 每次 CI 实际执行什么代码由第三方仓库决定（与 v1.16.0「pip 侧只有区间声明」同族，只是发生在 CI 自己的供给链上）。钉版对账取**外部真值**：注释声明的版本 tag 由 GitHub 解析成提交号后与工作流钉值逐字比，"仓内常量比仓内常量"这种自证式判绿一律不采用；上游读不到即 rc=2，不静默判绿。`--selftest` 14 项含正向对照（防"永远判红"的判据被自证当成合格）。落点：`infra-lint` 新增带 Token 的权威判定步 + pre-commit 第 12 钩（`--offline` 快检，SKIPPED 一律可见）+ `npm run actions` / `actions:selftest`。
- **依赖声明完整性判据** `scripts/dep_completeness.py`（10 项 + `--selftest` 12 项）：Python 侧 AST 枚举、JS 侧行首锚定 import/require 语句，与**三面声明面**（`requirements.txt` / `-dev` / 新增 `-build`）对账；package-lock 里**非 optional** 的 peer 必须与实际解析版本相容（31 条 optional 跳过会打印数量，不静默）。对标 `openemr/composer-require-checker.yml`。
- **Dependabot 分诊闭环** `scripts/dep_triage.py` + `fixtures/dep_triage.json`（14 天）+ `.github/workflows/dep-triage.yml` 每周作业：开放中的依赖 PR 超龄、缺 `dep-triage:v1` 分诊痕迹、或 `created_at` 脏 ⇒ 判红；API 取不到 ⇒ rc=2 而非"没有 PR"；零 PR 如实报数。对标 `openemr/dependabot-auto-merge.yml`——刻意不自动合并（major 升版必须过双视口 E2E 与 bundle/fhir 判据），改判"超龄即红"。
- **已发布交付物持续可用烟测** `scripts/live_smoke.py`（12 条线上断言 + 零网络 17 项反例自证）+ `.github/workflows/live-smoke.yml`：匿名拉 `ghcr.io/...:latest` → 镜像内 `selftest.py` → 真起容器把同一套断言打在镜像上；另一作业判据先自证再打 pages.dev。对标 `openemr/recovery-path-smoketest.yml` / `release-mechanism-smoketest.yml`——我方此前只在打 tag 那一刻验一次，「发布完成」与「仍然可用」是两件事。
- **公开仓 agent 入口 `AGENTS.md`**：对标实测 ragflow 仓根带 agent 指引与 `.agents/` 目录、openemr 带 copilot 指引，我方公开仓为零；内容限定在"该跑哪些命令 / 三条红线为什么不能改 / 改 X 前先知道 Y"，并已纳入 `docs_link_guard` 的关键文档在场清单。

### Fixed
- 🔴 **`starlette` 一直只是 fastapi 的传递依赖却被直接 import**：`backend/app/main.py:8` 的 `from starlette.exceptions import HTTPException` 是 v1.17.0 把 404 处理器注册到 Starlette 基类时引入的，声明面从未有过它——新判据**首跑即点名**。修法＝补 `starlette>=1.7.0`（下限取锁内实装版本，与本轮 pydantic 同一口径），而不是给判据开豁免。
- **依赖批 #19/#12/#20 清偿**（三张 Dependabot PR 自 9/24 无人处置）：`pydantic` 声明下限由 `>=2.8` 抬到 `>=2.13.5`，与锁内实装一致（旧声明在承诺一个从未测过的下限；本机把环境升到该下限后 `backend/selftest.py` 6/6 套件 exit0、44 pass / 0 fail）。`vite` `^6.3.0 → ^8.3.0` 与 `@vitejs/plugin-react` `^4.5.0 → ^6.1.1` **必须成对**：四组 `npm install --dry-run` 解析实测——单升任一张都 `ERESOLVE`（plugin-react 6 声明非 optional `peer vite ^8.0.0`），两张一起升才解析干净；这就是台账#12/#14/#15 十三轮里两次失败的根因，不是网络问题。成对升后 `npm ci` 清装 387 包 → build 两次同哈希 → 十八件套 exit0 → Playwright **5 passed** → coverage:js 28 项地板全过 → bundle 主 chunk gzip 72,083B ≤ 77,500B。
- **`upload-artifact` 全仓分裂**：`ci.yml` 用 `@v7`、`release.yml` 用 `@v4`（同一 action 两套实现，产物元数据差异只在特定作业暴露）。新增"同一 action 全仓只钉一个提交号"判据并收敛到 v7.0.1。
- **`package-lock.json` 的 `version` 字段长期停在 1.14.0**（与 package.json 1.20.1 不一致），本轮随升版一并归位。
- **README 一处指向仓外目录的说法**：「完整线上评测与原始报告见工作区 `../iCAN大学生创新创业大赛/03-评测/`」在公开仓里必落空（此前逃过对账只因该判据对以 `/` 结尾的目录写法不做强判定）。改为如实写"随参赛提交包交付，不在本仓库内"。
- 🔴 **`env_guard` 的口径缺陷（被本轮新钩子上岗即抓到）**：它把 `scripts/` 读的键与 `backend/app` 读的键混成一个面，于是 CI 令牌必须写进 `backend/.env.example` 才能变绿——那会误导"从零启动"的使用者（跑演示并不需要 GitHub token）。改为**分面对账**：应用面必须入 `.env.example`，工具面可由工作流声明担保，且任何键一旦被应用面读取就回到 `.env.example` 口径（生产代码偷偷读 CI 令牌仍判红）。三组反例实测 rc=1，跑完按 sha256 校验回滚。

### 边界与代价（如实登记，不拿调低判据掩盖）
- 客户端入口哈希变化（`index-DmXZVgwe.js` → `index-CBNGoXmQ.js`）：此前多轮以「hash 零变化」当"无前端改动"的证据，本轮起该证据形态不成立。
- 主 chunk gzip 约 65KB → 72.1KB，体积棘轮余量降到 5.4KB，下次升构建器必须重量。
- 本机 `actionlint` 本轮**未能真跑**（Docker Desktop 守护进程中途不可达），其权威判定由 CI `infra-lint` 出；`live-smoke` 的镜像作业同理，本机只验到线上作业那一路。
- 对标事实自纠：`infiniflow/ragflow` 工作流数由 12 **降为 3**（`release.yml` / `sep-tests.yml` / `serenedb.yml`），`web-lint` 已下线 ⇒ 第二十一轮"ragflow 仅 `web-lint`"的口径只对当时为真；`.trivyignore`、`codecov.yml` 仍在。同轮实测 `yolo-hyl/medical-rag`(303★) 与 `wizardlancet/OpenOE-Lite`(94★) 的 `.github/workflows` 均 404 ⇒ 三个新样本工程面为零，不作追赶锚点。
- GitHub license 字段显示 `Other`：因为 `LICENSE` 是**自定义参赛授权**（不得商用/临床部署/二次分发），属刻意选择而非漏配；已在 `AGENTS.md` 与 README 写明，不为了显示成 MIT 而改授权。


## [1.20.1] - 2026-09-25

### Fixed（`v1.20.0` 的 CI 被上一轮刚装上的判据拦下——这次轮到拦作者本人）
- 🔴 **`infra-lint` 作业在 CI 里判红**：`backend/Dockerfile:24 DL3059 info: Multiple consecutive RUN instructions`。
  起因就是本轮多架构改动本身——为按 `TARGETARCH` 选锁写成了**两条相邻 RUN**（选锁 + 安装），而
  `.hadolint.yaml` 钉的是 `failure-threshold: info`（第二十一轮"当前 0 findings 才敢用最严档"的那条决定）。
  本机跑 hadolint 时我扫的是**改动前**的 Dockerfile（当时确实 0 findings），改完没有在提交前复扫一次。
  修法＝合并成一条 `RUN if ...; then cp ...; fi && pip install ...`，而不是放宽阈值或给 DL3059 加豁免；
  并把"改 Dockerfile 后必须复扫 hadolint"写进 `docs/PITFALLS.md`（见 G5）。
  CI 聚合检查同时判红（`All Checks Passed` 覆盖 5 个阻断作业 ⇒ 一条 infra 红就拦住整条链），
  `deploy` 按设计未跑，**没有任何下游可见物被这条红污染**——除了镜像：`v1.20.0` 的 Release 作业是先于 CI 完成且成功的，
  `ghcr.io/...:v1.20.0` 与 `:latest` 已公开可拉 ⇒ 按"零下游可见物才可重锚"的既有规矩**不重锚 tag**，改出 `v1.20.1`。
- 多架构镜像的锁选择逻辑本身经实测是对的：合并 RUN 前后，`linux/amd64` 与 `linux/arm64` 两个镜像内
  `python selftest.py` 均 `SELFTEST SUMMARY: 6/6 套件 exit0`，arm64 侧 `platform.machine()==aarch64`。
- 🔴 **修掉一处"承诺在文档里、实现在另一条路上"的日志级别缺陷**（跑本轮新守卫时从 stdout 现形）：
  未知病例 id 走 `/api/dx/nope` 对外回 `404`，但权威面 `engine.js` 抛的是**裸 `Error`**，catch 先按"未预期异常"
  落 **`error` 级日志**、事后才用 `message.startsWith("unknown case")` 翻译成 404 —— 与第十九轮"4xx 一律 warn"
  的口径和 `docs/ERRORS.md` 的**书面承诺**都相反，且任何人拿随机 id 打这条路由就能把 error 日志刷成噪声。
  既往守卫只比响应码与文案，所以它**合法地**一直漏着。修法＝权威面补带类型的 `UnknownCase`（`status=404`，
  与镜像面 `engine.py.UnknownCase` 同名同形），4xx 分支按 `e.status` 统一分流，**删除前缀匹配**。
  归因如实记录：前缀翻译自 MVP 首次提交（`4a2c318`，2026-09-04）就在，"4xx 不得落 error"是第十九轮立的口径——
  **立新口径时没回头收干净老出口**，这才是根因（不是"错了两个月"）。
- 判据补两条（`frontend/tests/error_parity_guard.mjs`，10→**12 项**）：① 按 `X-Request-Id` 逐条归因断言
  34 条 4xx 用例**零 `error` 级日志**；② **正向对照**——同批用例必须真留下 34 条可归因行，否则"零 error"是恒真。
  两组反例实测 rc=1：把 `UnknownCase` 退回裸 `Error` → 三条判据同红并点名 `intake × 空 body→404`、`未知病例 id→404`；
  拔掉日志捕获 → 正向对照判红（实测 `0/34`）。分母由 fixture 现算（我先拍了"下限 36"，实测 34，按 B5 改成全等）。
- `docs/ERRORS.md` 的 404 行改指双端同名异常，并把"不会把客户端错误记成 error 级日志"从**声明**升级为**判据**（写明守卫名）。

### 度量与红线
运行时行为零改动（只有 Dockerfile 一条 RUN 的写法变化）：`lock_guard` 19 项全绿（含"额外平台的锁必须被 RUN 选用"——
判据按 RUN 指令解析，续行写法实测仍判绿 ⇒ 收紧判据没有引入假红）、`hadolint` info 档 0 findings、
`actionlint` `[]`、`npm test` 十八件套 exit 0、`api_contract_guard` 含错误目录双向对账、
`error_parity_guard` 38 条三方全等、mypy 31 文件 0 error、pre-commit 10 钩 Passed。
三条产品红线逻辑零改动、默认档仍 bm25、评测仍是同一批 31 例。


## [1.20.0] - 2026-09-25

### Added（第二十二轮：交付物在**任意架构**都能跑，判据从抽样改成枚举积）
- 🔴 **多架构镜像（关台账#32）**。此前 `release.yml` 不设 `platform` ⇒ GHCR 上只有 `linux/amd64`，
  而 README 笼统写"一条命令拉取运行"：Apple Silicon / arm 云机上 `docker run` 直接 `exec format error`。
  现在 buildx 出 `linux/amd64,linux/arm64`（先 `docker/setup-qemu-action@v3`），发布后**断言已推送的 index 里
  真的同时含两个架构**（配了 platform 却被静默降级只出一个，是这类治理的典型死法；判据从"有子清单"升级为
  "子清单覆盖 {amd64, arm64}"）。本机全链路实证：`docker buildx build --platform linux/arm64 --load` 成功后
  `docker run --platform linux/arm64 <img> python selftest.py` 输出 `arch= aarch64` + `SELFTEST SUMMARY: 6/6 套件 exit0`
  （首次尝试被本机 `auth.docker.io` 超时挡住，先 `docker pull --platform linux/arm64 python:3.12-slim` 再构建才通过）。
- 🔴 **锁从一把变两把，并新增"两锁版本集必须全等"判据**。`--python-platform` 解析出的哈希按平台分列 ⇒
  arm64 用 amd64 那份锁会在 `--require-hashes` 下直接装不动。做法：新增 `backend/requirements.arm64.lock`、
  `scripts/recompile_locks.py` **一条命令同时刻重算两把**、`backend/Dockerfile` 按 `ARG TARGETARCH` 选锁
  （选完仍保持单一安装入口 `-r requirements.lock`，避免"两条安装命令只有一条开 require-hashes"）。
  过程中抓到一条**看起来像架构差异、其实不是**的现象：仓内 amd64 锁停在 `uvicorn 0.53.0`，新建的 arm64 锁是
  `0.54.0`；同一时刻分别重算两平台后差异为**零** ⇒ 根因是 `uv pip compile` 会**复用输出文件里已有的钉版**
  （in-source caching），于是"写已存在的锁=保旧版本、写新文件=取最新版"，同一命令两种结果。
  `lock_guard.py` 由 11 条扩到 **19 条**（每把锁各跑 6 条 + 新增三条：`头注平台必须与文件名匹配`、
  `额外平台的锁必须真的被 RUN 选用`、`各锁版本集全等`）。三条都配反例实测 rc=1：
  删掉选锁的 RUN 行 → 判红（第一版判据写得太松，只出现在 COPY 里也算"被引用"，**假绿被自己的反例抓到后收紧**）；
  只手改一把锁的版本 → 判红；把 arm64 锁头注平台换掉 → 判红。
- **`docs/ERRORS.md` 错误契约表 + 三方互咬判据**。给集成方一张不看源码就能写对重试分支的表
  （对标：成熟项目的错误语义是文档一等公民；也是 AI Agent 消费 API 的前置条件）。判据落在
  `frontend/tests/api_contract_guard.mjs`：① openapi 各操作声明的状态码集合与表**双向全等**（文档落后或缺
  声明码都红）；② 表里 400/413/422 三行的文案必须**逐字等于** `limits.js` 导出的常量。
  三组反例实测 rc=1：文案改一字、删一行、表里凭空多一个 `418`。
- **双端错误码对账从 13 条抽样升级为 38 条枚举积**（推进台账#36）。新增 `scripts/gen_error_matrix.py`
  声明 4 条 POST 路由 × 9 类入站违规 + 2 条路由级用例，`fixtures/error_parity.json` 变成它的产物；
  `error_parity_guard.mjs` 增加四条覆盖面判据（用例数==枚举积、路由数对得上、每类违规都在矩阵里、
  fixture 与生成器无漂移 ⇒ 手改或"加了新路由却没用例"直接指名）。实测**38 条三方全等**（码 + 剥故障编号后的文案）。
- **codespell 进 `infra-lint`（对标 OpenEMR 的 `.codespellrc` + 忽略清单）**。接线前先量误报：全仓唯一命中是
  `EHR`（电子健康档案，被词典当成 `HER` 的拼写错误）⇒ 按原因登记进 `.codespellrc` 的 `ignore-words-list`
  而不是关掉检查；版本钉在 `backend/requirements-dev.txt`（`codespell>=2.4.1,<2.5`，词典随版本变＝判据会漂）。
  注入反例实测：临时放一个含两个常见错拼（<!-- codespell:ignore-begin 这里的字面错拼是**反例样本本身**，不是笔误 -->`recieve`/`accomodate`<!-- codespell:ignore-end -->）的文件 → rc=65 并逐条点名，删除后 rc=0。
  另加"受检文件数 ≥80"的覆盖面下限（本机实测 87）——**这里我第一版拍了 120，实测只有 87，
  分母必须量出来不能猜**，已按实测改。

### Changed
- **依赖锁推进一个版本**：`uvicorn 0.53.0 → 0.54.0`（`--upgrade` 全量重解析 22 个包，只有这一项变化，
  两平台一致）。运行时镜像、CI、发布链都从锁安装并开 `--require-hashes`，故本次升级的真实效果在
  镜像内自证：amd64 与 arm64 两个镜像内 `SELFTEST SUMMARY: 6/6 套件 exit0` 均实测通过。
- `docs/PITFALLS.md` 新增/修订条目：`auth.docker.io` 超时与 buildkit 取 token 路径、uv 的 in-source caching、
  `--load` 与多平台互斥、`RC=$?` 读管道尾命令的码（同 D5）等；`README.md`/`CONTRIBUTING.md` 补错误契约口径。

### 度量与红线
`npm test` **十八件套** exit 0（`api_contract_guard` 新增错误目录对账、`error_parity_guard` 10→覆盖面 10 项含 38 条用例全等、
`docs_link_guard` 扫描面由手列 8 个文件改为**枚举 md 文件**并加关键文档在场断言）；`lock_guard` 11→**19** 项；
Py 覆盖率维持 93.6% 档、mypy 30 文件 0 error、ruff 全绿、pre-commit 10 钩 Passed、Playwright 5 passed；
`actionlint` 对新增 6 步 infra-lint 与改过的 release/dep-audit 均 `[]` 无告警。
**三条产品红线逻辑零改动**（红旗仍独立于 LLM、终审文案与引用白名单未动）、默认检索档仍 bm25、评测仍是同一批 31 例。


## [1.19.0] - 2026-09-25

### Added（第二十一轮：把"我们写坏的基础设施文件"和"双端错误码"都变成有判据的面）
- 🔴 **基础设施层静态把关进阻断链**。对标实测：OpenEMR 有专门的三条 linting 工作流（`Github Actions Linting` / `Dockerfile Linting`(hadolint) / `Docker Compose Linting`），ragflow 只有 `web-lint`，phlox 零 ⇒ **1/3** 有；我方此前 ESLint/ruff/mypy 只看源码，**工作流/Dockerfile/compose 这三份"决定发布能不能跑"的文件没有任何判据**——而本仓反复在这里自伤（r18 把 `--require-hashes` 写进注释导致判据命中"说到"而非"做到"；r19 `requirements.txt` 注释续行漏 `#` 让 pip 解析失败；r20 把 `sed` 的 `\1` 落成裸 `0x01` 让 YAML 直接解析失败）。新增阻断作业 `infra-lint`：`rhysd/actionlint:1.7.7`（内嵌 shellcheck 扫每个 `run` 块）+ `ghcr.io/hadolint/hadolint:v2.14.0-alpine`（规则集钉在仓根 `.hadolint.yaml`，`failure-threshold: info`）+ `docker compose config -q`，另加"扫描面非空"反空断言（workflow 文件 ≥5、Dockerfile/compose 在场）。**首跑即抓到一条真问题**：`release.yml` 的 `sha256sum *` → `SC2035`（文件名以 `-` 开头会被当成选项）。更诚实的一条：修它时我又穿了一层 shell+python 转义，把续行写成**字面 `\n`**，被同一个 actionlint 以 `SC1012` 当场抓回——这正是本作业要防的事，且它上线第一轮就拦到了作者本人。新作业已挂进 `all-checks-passed.needs` 与 `deploy.needs`（`scripts/branch_guard.py` 反例实测：漏挂即 rc=1 并指名 `缺 ['infra-lint']`）。
- **镜像层 CVE 扫描**（对标：ragflow 仓根带 `.trivyignore` ⇒ 同类把镜像层纳入扫描；我方自 v1.18 起把镜像发布给评审，却只扫依赖清单，基础镜像的 OS 包全在射程外）。阻断档取值的依据是实测而非拍脑袋：本机扫我们刚发布的镜像得 `Total: 44 (HIGH: 44, CRITICAL: 0)`，逐条查 `FixedVersion` **44 条全部无可用修复版本**（Debian 侧未发补丁）⇒ 阻断档＝「CRITICAL 且已有修复版本」（`--severity CRITICAL --ignore-unfixed --exit-code 1`，当前 0 命中），HIGH 全量只写进 job summary 不拦（按 HIGH 阻断会在上游出补丁前长期红灯＝cry-wolf，同 r17 计数基线教训）。判据真的会咬的机制反例：同一镜像去掉 `--ignore-unfixed` ⇒ rc=1。落点：`.github/workflows/release.yml` **推之前**扫（不把已知可修的 CRITICAL 推给评审）+ `.github/workflows/dep-audit.yml` 定时扫已发布的 `:latest`。
- **双端错误码三方对账**：新增 `frontend/tests/fixtures/error_parity.json`（12→13 条用例，期望码写在仓内单一源）+ `frontend/tests/error_parity_guard.mjs`（期望 ↔ JS ↔ Py 三方，另含"客户端错误一律 4xx""4xx 必须 {code,message} 且 message 非空"两条不变式）。`api_contract_guard.mjs` 的"实现真的有这个分支"从**比字符串**升级为**比 limits 常量产出的状态码集合**（旧判法一改 if 写法就假红）。`docs/openapi.json` 四个 POST 补声明 `422` + `BadShape` 响应组件。
- **排障手册 + 手册自身的守卫**：新增 `docs/PITFALLS.md`（转义/假绿/发布与 Git/Windows+Git Bash/双端一致 五类，每条写「可 grep 的报错症状 → 根因 → 处置 → 常驻判据」，写不出判据的坑不许进手册）；新增 `frontend/tests/docs_link_guard.mjs` 守它和其余文档：markdown 仓内链接与锚点必须存在、反引号里的仓内路径必须真实（`CHANGELOG.md` 按历史叙述豁免，理由写在代码注释里）、被点名的判据文件必须存在、扫描面必须非空。**首跑抓到 4 处既存真死链**：`SECURITY.md` 的 Discussions 写成 `../../discussions/...`、`docs/PRIVACY.md` 引 `SECURITY.md` 少一层 `../`、`docs/ARCHITECTURE.md` 写 `tests/redline.test.jsx`（实在 `frontend/src/`）、`docs/EVAL_CARD.md` 写 `scripts/sbom_guard.mjs`（实在 `frontend/tests/`）——全部已修。
- **推送后的远端回执脚本化**：新增 `scripts/ci_watch.py`（只读；按提交聚合 run/作业结论，失败时打印失败作业名 + 首条错误行 + run 链接；`--json` 供 IDE 钩子消费）。关键取向：**一条 run 都没观察到 = exit 2（UNKNOWN）而不是通过**，实测反例 rc=2。`CONTRIBUTING.md` 增「推送之后」一节，并把可选的 post-execution hook 写法交给人（钩子只做只读观察，不代改全局设置、不自动 rerun）。

### Fixed（同轮，多数由上面两条新判据抓出）
- 🔴 **台账#28 关闭**（此前"同一入参权威面 500／镜像面 422"被测试**钉住**当既成事实，而不是修掉）：`history` 传成字符串改由入站定码 **422**；三方对账又抓到三条此前无人知道的差异并一并收敛——① 镜像面额外强制 body 带 `case_id`（权威面从路径取）⇒ 只带路径 id 的合法请求镜像面回 422；② `content` 传对象时镜像面 `"".join()` 抛 `TypeError` → **500**（本机日志实证 `sequence item 1: expected str instance, dict found`）而权威面静默继续；③ 请求体不是合法 JSON 时权威面 400、镜像面按 FastAPI 惯例 422。现统一：结构不合契约＝422、解析不了＝400、id 只取路径。对外文案两侧各写一遍中文必然漂 ⇒ 提成三对同名同值常量（`TOO_LARGE/BAD_JSON/BAD_SHAPE`_MESSAGE），由 `limits_guard` 逐字对账。
- **错误处理路径自身不得把请求带崩**：`catch` 分支里 `redact(e.message, env)` 读 env 一旦抛异常，异常就逃出 handler，医生看到的是平台错误页而不是承诺过的可读文案（破「API 失败只显示可读文案」这条口径）。改为 `redact` 的 env 读取与 `logEvent` 的序列化各自兜底：**归因可以降级，响应信封不能失败**。`route_guard` 用「取属性即抛的 env 桩」把这条钉成常驻用例（不给生产代码开测试后门）。
- `docs/` 四处死链（见上）；`.github/workflows/release.yml` 的 `sha256sum *` → `sha256sum ./*`。

### 度量与红线
`npm test` 十六→**十八件套**（+`test:docs`、+`test:error-parity`）exit 0；`route_guard` 29→**37** 项、`test_limits` 40→**44** 项、`test_api_observe` 39→**42** 项、`error_parity_guard` 33 项、`docs_link_guard` 7 项（三组反例实测 rc=1：假凭据／死链／删掉判据行）；覆盖率 Py **93.52→93.63%**（地板 90）、JS 全局零降（新增的 `observe.js` 两条兜底支路各自 100% 覆盖，模块地板余量最薄 2.0pt 如实记录）；ruff/mypy(29 文件 0 error)/ESLint/文本卫生/pre-commit **10 钩**全绿；`branch_guard` 阻断作业 4→5 且 needs 全覆盖。**三条产品红线逻辑零改动**（红旗仍独立于 LLM、终审文案与引用白名单未动）、默认检索档仍 bm25、评测仍是同一批 31 例。


## [1.18.2] - 2026-09-25

### Fixed
- 🔴 **CodeQL `py/stack-trace-exposure` 的处置方式＝改代码追上承诺，而不是申辩误报**。v1.18.1 发布后 `gh api .../code-scanning/alerts?state=open` 实测开放告警 **0 → 1**（`backend/app/main.py:49`，severity=error）。逐行核验后确认**按当前实现它确实是误报**：`RequestTooLarge.__str__` 返回的是医生文案「请求内容超出可处理范围…」，归因细节走 `.reason` 只进日志（且 `test_limits.py` 第 5 节早已断言 `">" not in str(e)`）。但"异常对象直接进响应体"这个**形状**恰好是本项目红线（错误响应不展示堆栈或内部路径）要防的东西，留着规则就只能靠人记住"这次碰巧没事"。故出口改为模块常量 `limits.TOO_LARGE_PUBLIC_MESSAGE`（两处 `str(exc)` → `exc.public_message`），并新增 `test_limits.py` 第 6 节把它钉成判据：全 `app/` 源码扫 `"message": str(` 命中即红（**变异实测**：任一处回退 `str(exc)` → 该条 FAIL、rc=1）、`public_message` 与常量逐字同值、不含 `[`/`>`/字段名、`reason` 仍保留细节（日志侧信息量不降）、413 实际响应真的走常量。
- 新判据第一版**自己就是假的**：扫描根写成 `os.path.join(REPO, "app")`，而 `REPO` 是上三层 = `backend/`，`backend/app` 不存在 ⇒ `os.walk` 对不存在路径**静默返回空**，"扫 0 个文件"照样判绿。改成 `Path(__file__).resolve().parent.parent / "app"` 并加一条"扫描面 ≥5 个 .py 且目录真实存在"的反空判据（镜像内 `REPO` 会解析成 `/srv`，那里根本没有 `app/`——同一 bug 在镜像里会长期静默）。教训与 r12/r18 同族：**枚举器必须自带会红的非空断言**。

### Added（把"发布正文"从一次性生成升级为可复算真值）
- 阈值单一源 `frontend/tests/fixtures/release_notes.json`（`min_body_chars=200`）：`release.yml` 的正文步骤现**读该 fixture**而不是写死 200，fixture 缺失/非法一律 `exit 2`（fail-closed，实测 rc=2 + 指名 FileNotFoundError）。
- `version_guard.mjs` 五→**九项**，新增三条与本文件同源的升版预检：① `release.yml` 真的引用该 fixture（防"fixture 成摆设、改数字只改一处"）；② 阈值形态合法（整数且 ≥50）；③ `CHANGELOG.md` 有 `## [当前版本]` 小节**且正文 ≥ 阈值**——把"CI 出包时才判红"前移到"升版本当轮就红"。**两组反例实测 rc=1**：`package.json` 改成无小节的 1.18.9 → 报「CHANGELOG.md 有 ## [1.18.9] 小节」；把 `release.yml` 里的 fixture 路径改掉 → 报「正文长度阈值取自 fixture」。改动后两个受控文件按 sha256 逐字节还原自检通过。
- `release.yml` 末尾新增一步「线上正文 ↔ 本次生成结果逐字节对账」：`gh release view --json body` 与 `dist-release/NOTES.md` 比非空白字节数（第二十二轮校正单位：`wc -c` 数的是字节，实测 2500 字符＝4453 字节），不等即红并打出 diff（防"改了生成逻辑但 Release 还挂着旧正文"这种只有第二次发布才会暴露的残留）。
- 本版同时是 1.18.1 那套新链条的**首次自证**：v1.18.2 的 Release 正文完全由 `CHANGELOG.md` 本节机器产出，资产与正文在 CI 内对账，本机可用 `scripts/release_repro_check.py --ref v1.18.2 --against <CI 包>` 独立复算。

### 度量与红线
运行时对外行为**逐字不变**（413/400 的响应体文案与码完全相同，改的是取文案的出口）：`npm test` 十六件套 exit 0（`version_guard` 5→9）、`test_limits.py` 34→**40 项**（第 6 节 6 条）、`coverage:py` 全局 93.51%≥90、pre-commit 10 钩 Passed、离线评测 31/31 + 红旗 27/27 零回归。三条产品红线逻辑零改动、默认档仍 bm25、评测仍是同一批 31 例。


## [1.18.1] - 2026-09-25

### Fixed（v1.18.0 发布作业判红后的三处自查——**拦下来就是拦下来，不绕**）
- 🔴 **判据的归因错误（本条最值钱）**。`v1.18.0` 的 `release.yml` 在「匿名可拉取实证」一步判红，日志提示语写的是「包可见性多半仍是 private」。实测证明**这个猜测是错的**：`docker/build-push-action` 推上去的是 OCI **index**（`mediaType=application/vnd.oci.image.index.v1+json`），而判据的 `Accept` 只列了 `image.manifest` 与 `distribution.manifest` 两种类型 ⇒ registry 回 `404 MANIFEST_UNKNOWN: OCI index found, but Accept header does not support OCI indexes`；包自始就是 **public**（`gh api users/lxh113377/packages?package_type=container` 实测 `visibility=public`）。本机同一命令对照实验：两类型 `http=404`，四类型 `http=200`（body 856 B）。修法：`Accept` 补 `oci.image.index` + `distribution.manifest.list` 两类；报错按状态码分支（401/403 → 可见性、404 → tag 未推上，各自给可执行改法）并把响应体打进日志；再补一条下限——**200 之后还必须有子清单**，否则等于验证了个空壳。教训：**判据红了先读响应体再改状态**，猜测式提示语会把下一轮排查整个带到别的系统上去（这次就白折腾了一趟"翻可见性"）。
- **镜像内自证根本跑不起来**。`backend/Dockerfile` 只 `COPY app/ requirements* tests/`，而本轮刚把套件改成 `backend/selftest.py` 驱动 ⇒ 发布出去的镜像里没有 runner（compose selftest 一跑就是 `No such file`）。补 `COPY selftest.py ./`（注释写明这是"清单驱动化后 Dockerfile 属于消费方"这一类，不是单点）。镜像内实测 `SELFTEST SUMMARY: 6/6 套件 exit0` + `[GATE:selftest-pass]`。
- **后端测试对仓库外文件的隐式依赖**。`tests/test_limits.py` 第 4 节直读 `frontend/tests/fixtures/request_limits.json`（数值同源对账），镜像内只装后端 ⇒ 整套崩。改为文件不存在时**显式 SKIP 并写明"数值同源改由 npm 侧 limits_guard 判定"**——绝不静默 `return`（静默通过就是假绿）。镜像内实测 `30 pass / 0 fail` + 1 条 SKIP。

### Added（顺带关闭台账#23：Release 正文进版本控制且由机器产出）
- 原来 `release.yml` 是"先建**占位正文**的 Release，再由人事后补双语说明"——两处毛病：占位忘了补就是评审看到一句空话；且正文**不在版本控制里**，无从对账、无从复现。现改为取 `CHANGELOG.md` 的 `## [<版本>]` 小节拼成 `NOTES.md`，前置一段"一条命令拉取 + 独立核验（`sha256sum -c` / `git archive --mtime` 复算）"，再 `gh release create --notes-file`（已存在则 `gh release edit` 连正文一起更新）。**小节缺失／正文 <200 字符直接判红**：宁可不发，也不发一个只有占位话的 Release。本机把该步骤脚本从 YAML 里**原样抽出实跑**：正例 rc=0（正文 2613 字符），两组反例 rc=1（无 `## [9.9.9]` 小节 / 正文裁到 3 字符）。过程自身踩到两条：`ln.strip() == "## [1.18.1]"` 匹配不上带日期的标题（改 `startswith`）、python 里引用了 shell 的 `TAG`（NameError）——**都只有真跑才会暴露**，写在文档里就是又一条"未跑先写"的反面教材。
- 顺手把镜像内自证命令按 `Dockerfile` 真实 `WORKDIR=/srv/backend` 写成 `docker run --rm --entrypoint python <image> selftest.py`，并在本机对刚构建的镜像跑通（`6/6 套件 exit0`）后才写进 Release 正文与 CONTRIBUTING。

### 关于 `v1.18.0` 这个 tag（不偷偷抹平）
`v1.18.0` 的 tag 与 `ghcr.io/lxh113377/doctor-ai-dx:v1.18.0` 镜像**保留原样、不重锚**：镜像已经公开可拉＝存在下游可见物，重锚会让"已拉走 v1.18.0 镜像的人"对不上源码，属于我自己在 r17 立下的规矩（零下游可见物才可重锚）。该 tag **没有 GitHub Release**（发布作业在出包前就红了，符合设计），其缺陷已由本版修复并随 `v1.18.1` 重新出包；`:latest` 随本次成功发布覆盖为 v1.18.1 构建。

### 度量与红线
运行时行为零改动（版本号四处同步 + `docs/openapi.json` 重新生成）：`npm test` 十六件套 exit 0、`suite_guard` 九项、`coverage:py` 全局 **93.51% ≥ 90**（模块地板 10 项）、pre-commit **10 钩** Passed、镜像内 6/6 套件 exit0。三条产品红线逻辑零改动、默认检索档仍 bm25、评测仍是同一批 31 例。

## [1.18.0] - 2026-09-25

### Added（第二十轮：交付物的"可拉取"与"单一清单"）
- 🔴 **缺口一：发布物不可拉取**。对标当轮实测：`gh api users/bloodworks-io/packages?package_type=container` 查到公开 container 包 `phlox`，而 `gh api users/lxh113377/packages?package_type=container` 返回 **0 个包**——我方镜像只在 CI 里临时 build 做 selftest，评审与用户仍然必须自己装 Python/Node 或手工 build。本轮在 `release.yml` 门禁全绿之后增加镜像发布链：`docker/setup-buildx-action@v3` → `docker/login-action@v3`（用工作流自带 `GITHUB_TOKEN`，**不引入额外凭据**）→ `docker/build-push-action@v6` 推 `ghcr.io/<owner>/doctor-ai-dx:<tag>` 与 `:latest`，`permissions` 补 `packages: write`。
- **顺序与判据**：镜像步骤排在所有门禁与源码包/SBOM **之后**（任一判据红就不产出镜像）；随后一步 `放开包可见性`（best-effort PATCH，失败不硬拦）+ **匿名可拉取实证**：不带任何凭据向 `ghcr.io/token?scope=repository:<pkg>:pull` 换 token 再读 manifest，非 200 即判红并给出可读的修法提示。理由＝"认证后可读"是最低要求，**"评审一条命令拉得下来"才是交付标准**；只推成功却仍是私有包，等于没发布。
- 🔴 **缺口二：同一份清单被抄了两遍**。第十九轮新增 `backend/tests/test_limits.py` 后实测发现：`docker-compose.yml` 的 selftest 与 `frontend/package.json` 的 `coverage:py` **各自硬编码同一份五件套清单**，新套件两边都没挂上 ⇒ 发布出去的镜像自证的是**过期套件**（那段注释还写着"三套"，数字早失真）。本轮改为单一源驱动：
  - 新增清单 `backend/tests/suite.json`（6 条，按依赖代价升序，fail-fast）+ 新增 runner `backend/selftest.py`（`--coverage` 供覆盖率链复用；清单缺失/为空/条目不存在一律 exit 2，**绝不静默当通过**）；CI 后端作业、compose selftest、`coverage:py` 三处全部改为调用 runner。
  - 新增门禁 `scripts/suite_guard.py`（`npm run test:suite` + CI `Suite manifest gate` + pre-commit 第 10 钩）九条判据：清单非空且 ≥6／每条真实存在（防改名后静默跳过）／**枚举 `tests/test_*.py` + `smoke_engine.py` 反向核对全部已登记**（新增测试忘记挂清单即判红）／无幽灵条目／无重复／**三处消费方必须已改为 runner 驱动**（再抄一份硬编码清单即判红）／runner 存在。**三组反例实测 rc=1**：新建未登记的 `test_zz_probe.py` → 报「漏登记 ['tests/test_zz_probe.py']」；清单里塞幽灵条目 → 同时打中"条目存在"与"无幽灵"两条；compose 回潮硬编码 → 报「仍在硬编码逐条套件＝第二真值」。还原后 rc=0（runner 实跑 6/6 套件 exit0）。
- **SBOM pip 侧回到声明式（关闭台账#27）**：v1.14.0 当时只能走 `environment` 模式（本仓无钉版 ⇒ `requirements` 模式只出 5 条空壳）。第十八轮锁落地后前提消失，本轮改由 `cyclonedx-py requirements backend/requirements.lock` 生成，判据随之升级为**锁 ↔ 清单双向全等**：正向逐包版本一致（原来因区间声明"自然通过"，现在真有牙）、反向「清单无锁外组件」、条目数 ≥22 非空证明。实测弃用 `environment` 的理由：它报的是"这台 CI 机器装了 282 个包"（含 flask、pip、cyclonedx-bom 自身等与镜像无关者），随环境漂移；而运行时镜像里恰好只有锁中的 22 个包 ⇒ **只有锁生成的清单才等于交付物**。两组反例实测 rc=1：删一个组件 → 「组件数 ≥22」+「uvloop 缺失」双红；加一个锁外假组件 → 反向判据指名 `somebotpkg`。另：`MIN_COMPONENTS.pip` 由 15 抬到 22（＝实测锁内条目数，只升不降）。
- README「方式C」补一条 `docker run --rm -p 8000:8000 ghcr.io/lxh113377/doctor-ai-dx:latest`；`docs/ARCHITECTURE.md` 门禁表补「测试套件单源对账」行并改写发布工件行；`CONTRIBUTING.md` 写明清单与镜像两条新口径。

### Fixed（本轮自查）
- 写工作流时把 `sed` 的回引用 `\1` 经 Python 字符串落地成裸 `0x01` 控制字符（**同族第七次复发**，前六次是 `\b`→`0x08`）；`check_text_hygiene.py` 在提交前抓出（`unacceptable character #x0001` 也让 YAML 解析直接失败），按字节还原为字面 `\1` 并复验。教训同前：**凡带反斜杠的字面量一律用 Write/Edit 工具落地，不穿 bash+python 两层转义。**

### 度量与红线
运行时行为零改动：`npm test` 仍十六件套 exit 0（`limits_guard` 34 / `privacy` 59 / 其余同 v1.17.0）、`suite_guard` 九项、`sbom_guard` 11 项、ESLint + ruff + 文本卫生 + mypy（受控 28 文件）全绿、pre-commit **10 钩** Passed。三条产品红线逻辑零改动、默认检索档仍 bm25、评测仍是同一批 31 例。

## [1.17.0] - 2026-09-25

### Added（第十九轮：判据的强制层 + 入站滥用护栏）
- 🔴 **缺口一：判据写了但不被强制**（实测）。`ci.yml` 有 **4 个阻断性作业**（build-and-test / backend-test / text-hygiene / e2e），而 `gh api repos/.../branches/main/protection` 实测 `required_status_checks.contexts` 只有 **2 项**（`build-and-test`、`backend-test`）⇒ **上一轮的文本卫生门禁与本轮刚上线的浏览器回归都可以被绕过**——PR 带着红的 e2e 照样能合进 main。这与 r12「红线在 live 路径从未被测」同类，只是发生在更外层（合入闸门）。
  - 治本采用 OpenEMR 的做法（其 95 个工作流里有名为 **`All Checks Passed`** 的聚合作业）：新增 `all-checks-passed` 聚合 job（`needs` 全部阻断作业 + `if: always()`），并把仓库 required check 改指该聚合项 ⇒ **以后新增作业只要挂进 needs 就自动被强制**，不必再回头手工改仓库设置。聚合项用 `if: always()` 是必须的：否则任一前置红时聚合不运行，那个 required check 永远"等待中"，保护从形同虚设变成永久卡死。
  - 新增 `scripts/branch_guard.py`（CI `backend-test` 内自跑）五条判据：聚合 job 存在／**聚合 needs ⊇ 全部阻断作业（新增作业忘记挂进来即判红）**／`if: always()` 在场／ci.yml 真的调用本脚本（防"判据只写在文档里"）／`deploy.needs` 同样全覆盖；`--remote` 另核线上真实 contexts（读不到时打印 SKIP，不静默判绿）。**四组反例实测 rc=1**：needs 漏 `e2e`、删 `if: always()`、插入未挂聚合的新 job（同时打挂 deploy 判据）、把聚合 id 改名而线上保护未同步。
  - 边界如实登记（不 overclaim）：`enforce_admins` 保持 false——本项目的发布通道就是直推 main，关掉它等于把发布一起锁死；故聚合检查强制的是 **PR 合入**，直推路径的兜底是"推送后 CI 全绿 + `release.yml` 出包前把全部门禁再跑一遍"。
  - 线上变更前后均留痕：改前 contexts=`['build-and-test','backend-test']`、strict=false；改后 contexts=`['all-checks-passed']`、strict=true；原配置整份备份到系统临时目录（`branch_protection_backup.json`）便于回滚。
- 🔴 **缺口二：双端零入站边界**。实测同类对请求体一律有显式上界（ragflow `docker/nginx/nginx.conf` 设 `client_max_body_size 1024M`；OpenEMR 走 PHP/Apache 上传上限），而我方权威面是 Cloudflare Pages（**没有边缘 nginx，上界只能写在应用层**），此前两端都无上限，且 Functions 的 `readBody` 用 `catch { return {} }` 把坏 JSON **静默接受**后继续消耗引擎与 8s LLM 窗口。
  - 新增单一源 `frontend/tests/fixtures/request_limits.json`：`max_body_bytes 65536 / max_history_items 64 / max_content_chars 2000 / max_dx_json_bytes 65536`，状态码 413/400。**上限不是随手整数**：实测本仓合法峰值 body 488B、history 5 条 ⇒ 取 128x 余量（门禁第 6 组判据现场重算余量并把"上限小于真实峰值"判红）。
  - JS 侧 `functions/lib/limits.js` + 路由改 `parseBoundedBody(await request.text())`（先看 Content-Length 第一道，读出后按**实际字节**复核）；Py 侧 `app/limits.py` + `models.py` 的 `field_validator`（**进引擎前**就挡，不付 LLM 窗口）+ `main.py` 中间件（声明长度先检）与 `RequestTooLarge` 专用处理器。
  - 新增 `frontend/tests/limits_guard.mjs`（入**十六件套**，33 项）与 `backend/tests/test_limits.py`（22 项，入 CI 与覆盖率链）：数值三处同源逐字段全等／越界必拒且**文案不含内部阈值**／合法链路不误伤（含"红旗规则层仍独立生效""未知病例仍 404"）／**接线实证**（路由源文本必须真的调用 `parseBoundedBody`，并断言旧的静默 `catch { return {} }` 已消失）／4xx 不得记成 error 级日志（否则滥用流量会把错误日志刷成噪声、掩盖真故障）。
  - 实测双端同码：Py 侧超限由 500 兜底改判 413（`code:413` + 医生可读文案）；`--selftest-negative` 模式证明本门禁自己会红（rc=1）。

### Fixed（本轮过程中被既有门禁当场抓到的失手）
- **常驻判据立刻抓到本人引入的回归**：改写 `[[route]].js` 代码块时把 `json()` 里的 `requestId` 参数丢了 ⇒ `X-Request-Id` 在**所有成功响应**上消失（会静默废掉"故障编号可对账"这条契约）。`tests/route_guard.mjs` 在改动后数秒内报 `FAIL 响应头带 X-Request-Id :: 实测 ""`（2 fail），随即修回并复跑 25/0。这是第十七轮"判据必须常驻"的直接回报：**没有常驻判据，这类回归会一路跟到线上**。
- **判据被注释字面量骗过（同族第二次，方向相反）**：`limits_guard` 的"反静默 catch"判据按全文匹配 `catch { return {} }`，而我在 route.js 的**注释里**引用了这句旧代码作说明 ⇒ 判据**误判红**。修法是剥掉整行注释再匹配（第十八轮那次是注释让判据假绿，这次是注释让判据假红——两个方向同指一条：**拿源码文本做判据必须先剥注释**）。
- **文案对账判据的退化风险**：初版用正则从 Py 源里提 `super("…")` 字面量，提错时两边都取到空串 ⇒ **相等判绿**。改为"JS 文案原样出现在 Py 源里且长度 > 8"，把"提不到"变成显式失败。
- 📋 **登记一条既有双端差异（不偷偷改）**：同一入参 `history:"boom"` 在权威面 Functions 走引擎抛错 → **500**（`route_guard` 钉住），在镜像面 FastAPI 于 pydantic 契约层被拒 → **422**。本轮不扩大范围去动既有错误语义，改为在 `test_limits.py` 里把两侧实测码钉住并登记台账#28（收敛方向＝统一 400）。
- `pyyaml` 从"只作为 uvicorn[standard] 传递依赖存在"改为**显式声明**（`branch_guard.py` 直接用它解析 ci.yml，不自造 YAML 解析器）；锁已重生成，`lock_guard` 实测 声明 6 条 → 锁内 22 条全等。

### 度量与红线
- 三条产品红线逻辑**零改动**：护栏只做入站边界，实测"红旗规则层仍独立生效""未知病例仍 404""正常链路仍 200/code=0"；默认检索档仍 bm25；评测仍是同一批 31 例。
- 门禁面：`npm test` 十五→**十六件套**（+limits_guard 33 项）；pre-commit 九钩不变（新判据经 CI 与 npm 链生效）；ruff／ESLint／文本卫生／`lock_guard`／`branch_guard --remote` 全绿；mypy 受控文件 25→**27**（新增两个脚本/模块）仍 0 error。
- **新写模块不许留盲区（自查两轮）**：`app/limits.py` 首版只有 79%，且藏着一处**死代码** `check_payload`（全仓无调用点，只有本文件 docstring 提到自己）与一处**重复实现**（中间件自己 `int(content_length)` 比较阈值，而 `limits.check_declared_size` 是同逻辑的第二份）。处置＝删死代码、把阈值判断收进单一实现由中间件委托，并补 12 条模块级分支用例。实测 `app/limits.py` **79% → 100%**，全局 **92.78% → 93.51%**；据此把全局地板 88→**90**、新增 `app/limits.py` 地板 **97**（余量 3pt 与既有模块同量级），理由写进 fixture 的 `_meta.r19_note`（地板只升不降，降必须写理由）。
- **判据也不能盯实现细节的形状**：上面那次去重把 `MAX_BODY_BYTES` 字样从 `main.py` 挪走，`limits_guard` 里"main.py 出现该字样"的判据**立刻误判红**——它盯的是实现形态而非行为。改判为"中间件必须委托 `limits.check_declared_size` 单一实现 + 处理 `RequestTooLarge`"，并反向加一条"阈值字面量不得在 main.py 再现"（同一逻辑写两遍正是漂移开端）。改后 `limits_guard` 34 项全绿。
- 另外 `test:limits` 自身的两条 `no-unused-vars`（多余 import、未用变量）被 `--max-warnings=0` 抓出并删除：本轮新写的**判据脚本本身**也在 lint 覆盖范围内，不是只当裁判不当选手。
- 覆盖率口径：后端新增 `tests/test_limits.py`（34 项）进入覆盖率采集链（`coverage:py` 与 CI 同步），红线模块地板不降。

### 本轮**自己引入又当场修掉**的两个缺陷（如实登记，不写成"一次做对"）
- 🔴 **把聚合检查配成了永远不会满足的 required check**：`required_status_checks.contexts` 我写的是 job key `all-checks-passed`，而 GitHub 上报的 check 名是 job 的 **`name: All Checks Passed`** ⇒ 保护指向现实中永不出现的 check，**每个 PR 会被永久卡死**（比形同虚设更坏）。更难看到的是我的 `branch_guard --remote` 当时判绿——它拿"我写在常量里的 key"去比"我写进保护的 key"，属**自证式对账**。修法＝context 真值一律从 ci.yml 的 `name` 字段推导（无 name 才回落 job key），线上核 `期望=实测` 逐字对账；保护已改回 `["All Checks Passed"]` 并实测 PASS。教训：**判据的期望值必须来自被测系统的实际产出，不能来自我自己写的常量。**
- 🔴 **声明面坏掉而生成器不报**：给 `requirements.txt` 加的注释有一段续行漏了 `#`。`uv pip compile` 照样解析成功（生成器宽容），CI 里 `pip install -r` 直接 `ERROR: Invalid requirement`（run 36105388164 的 `build-and-test` 判红，聚合检查如实跟着判红——这一层工作正常）。`lock_guard` 当时也判绿，因为它的行解析器**跳过**不认识的行。新增第 11 条判据按 **pip 的行规则**逐行核（非 `#` 又不是 requirement 语法即判红），反例＝原样复刻本次漏 `#` 的那行，实测 rc=1 并指名 `11: 把"靠传递依赖"写成声明依赖…`。教训：**校验要用消费者的口径，不是生成器的口径**（同一逻辑也解释"锁必须按运行时平台解析"）。
- 顺带把 `build-and-test` 里最后一处浮动安装（`pip install -r requirements.txt`）改成从锁安装 ⇒ 三个 CI 作业 + 运行时镜像现在共用同一份依赖真值。
- 🔴 **第三个（也是由发布链自己抓出来的）：SBOM 名字比对假设两侧命名规范一致**。声明面按 r18 的口径把 `pyyaml` 从"传递依赖"改成显式声明后，`release.yml` 的 pip SBOM 对账直接判红（run 36106279797：`FAIL 每个声明依赖都出现在清单里 :: pyyaml`）。实测归因：锁里是 `pyyaml==…`（uv 按 PEP 503 归一），而 `cyclonedx-py environment` 出的组件名是发行包原始大小写 **`PyYAML`** ⇒ 精确匹配必然漏。**判据假定 ≠ 事实**。修法＝两侧名字都按 PEP 503 归一（小写、`_`/`.` 折叠为 `-`）后再比，并对反例做实测：把归一化退回精确匹配 ⇒ rc=1 且指名 `pyyaml`；恢复 ⇒ rc=0 九项全过。另注：这条缺陷在 r16 落地时就存在，只是当时声明面恰好没有一个"包名 ≠ 分发名"的项，**判据的覆盖面缺陷往往要等下一次真实变更才暴露**。

## [1.16.0] - 2026-09-25

### Added（第十八轮：运行环境可复现——依赖锁定 + 配置契约门禁）
- 对标实测（`gh api repos/<peer>/contents`）：**4/4 同类项目都带锁文件** —— OpenEMR `composer.lock` + `package-lock.json`、ragflow `pyproject.toml` + `uv.lock`、phlox `package-lock.json`、medical-rag `environment.yml`。我方 npm 侧一直有 `package-lock.json`，**pip 侧只有区间声明**（`fastapi>=0.141.1` 等）⇒ 同一个 tag 在不同时间 `pip install` 会装出不同环境，镜像与评测结果都无可审计的依赖真值。这也正是第十六轮 SBOM 的 pip 侧被迫走 `environment` 模式的根因（声明式 `requirements` 模式因无钉版只出 5 条空壳＝假门禁）。
- 新增 `backend/requirements.lock`：`uv pip compile requirements.txt --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes`（**按运行时镜像的 Linux/glibc 解析**，命令原样写在锁头注里，改声明面照抄即可）。实测：声明 5 条 → 锁内 **22 个包 / 505 条 sha256**。`requirements.txt` 定位为**声明面**（写区间、给人读、供门禁对账），锁为**安装面**；`backend/Dockerfile` 与 CI 一律改从锁安装并开 `--require-hashes`。
- 新增 `scripts/lock_guard.py`（`npm run lock` + CI `Lock gate` 步骤 + pre-commit 第 9 钩）九条判据：锁内包数下限（**空锁/半截锁不得判绿**）、头注须含 `--generate-hashes` 与目标平台（换平台＝换判据）、声明包逐一钉版、**锁内版本须满足声明区间**（专治"改声明不重锁"）、每条目须带 sha256、**Dockerfile 真从锁安装 + 真开 `--require-hashes` + 不再安装浮动 requirements**。
- 新增 `frontend/tests/env_guard.mjs`（入十五件套，第 12 项）六条判据：代码读取的环境变量（`os.getenv` / `environ[]` / JS `env?.K`）↔ `backend/.env.example` **双向对账**、示例面密钥类条目必须留空、扫描面与键集合非空证明、**双端扫描面各自非空**。对标 OpenEMR `Check Vendored Contracts` 与 ragflow 的 `*.example` 惯例——把"声明面"钉成判据而不是靠人记。

### Fixed（首跑即抓到真实漂移，且反例抓出门禁自身的假通过）
- 🔴 **配置面真实漂移 1 条**：`BGE_ENGINE_DIR`（`scripts/build_semantic_neighbors.py` 构建语义邻接表时读）从未出现在 `.env.example` ⇒ 照示例配置的人无法复现构建期链路。已补登记并写明"构建期工具、不参与线上运行时、线上零模型零网络"。
- **门禁自身的假通过（自查抓到）**：`lock_guard` 初版按 Dockerfile **全文**匹配 `--require-hashes`，而我把这个词写在了 Dockerfile 的**注释**里 ⇒ RUN 行实际是浮动安装时判据仍 PASS。这是"用文档字面量满足代码判据"，与本项目反复复发的 `\b`→`0x08` 死判据同族。修法：先剥注释行、只匹配 `RUN/COPY` 指令，再把该场景写成反例（现测得 3 条 FAIL、rc=1）。
- **判据覆盖面缺陷（自查抓到）**：`env_guard` 初版正则漏吃 JS 可选链 `env?.K` ⇒ 整个 Functions 权威面命中数为 0，而 Python 侧 8 个键让"总键数"看起来完全健康。修法：`env\s*\??\s*\.` + 新增「双端扫描面各自非空」硬判据（现测 Py 4 文件 / JS 3 文件；把正则改回去立刻 rc=1）。
- **门禁自身写法被自己的非空证明拦住**：`env_guard` 首版正则要求键名前无引号，实测"读到 0 个环境变量键"→ 非空证明直接判红，当场暴露而不是静默通过（R247 落地即生效）。

### 反例与验证（实测退出码）
- `lock_guard` 四组反例 rc=1：① 抹掉锁内哈希 → 报「每个条目都带 ≥1 个 sha256」并列首批包名；② Dockerfile 退回 `pip install -r requirements.txt` 且注释保留锁字样 → **3 条 FAIL**（正是上面那条假通过的回归测试）；③ 把声明改成 `fastapi>=0.999.0` 不重锁 → 报「声明 >=0.999.0 但锁内 0.141.1」；④ 还原后 9 项 PASS rc=0。
- `env_guard` 三组反例 rc=1：注入未登记键 `DX_MAX_STEPS` → 指名 `backend/app/config.py:24`；注入孤儿项 `UNUSED_FLAG` + 给 `DEEPSEEK_API_KEY` 填上值 → 两条 FAIL；破坏 JS 侧匹配 → 「双端各自非空」FAIL。还原后 6 项 PASS rc=0。
- CI `backend-test` 作业改为**从锁安装**（`pip install --require-hashes -r requirements.lock`）并新增 `Lock gate` 步骤；`release.yml` 出包前置门禁同步加入锁对账 ⇒ 跑测环境、发布门禁环境与运行时镜像环境三者同一。
- **容器实测（锁生效的最终证据）**：`docker build backend`（镜像内 `pip install --require-hashes -r requirements.lock`）成功，镜像 `sha256:0d814aa98e49b0…`（235,311,696 B），镜像内五套自证全绿 **25 / 40 / 16 / 37 / 25 pass，0 fail** ⇒ 锁定的不只是清单，装出来的环境能跑全部断言。

### 度量与红线
- 前端由十四件套扩为**十五件套**（新增 `test:env` 6 项），pre-commit 由 8 钩子扩为 **9 钩子**；`mypy` 受控文件 24→25 仍 0 error，ruff / ESLint / 文本卫生全绿，`lock_guard --quiet` 与 `pre-commit run --all-files` 全 Passed。
- 覆盖率与运行时代码零改动：JS 全局分支 75.24%（地板 74）、Py 92.78%（地板 88）；三条产品红线逻辑零改动、默认检索档仍 bm25、评测仍是同一批 31 例。
- 口径边界如实登记：锁按 Linux 解析，**Windows 本机 `pip install --require-hashes -r requirements.lock` 会因 uvloop 无 Windows 轮而失败（属预期）**，本机开发继续用声明面；文档与 CONTRIBUTING 均已写明，不做"跨平台万能锁"的假主张。

## [1.15.1] - 2026-09-25

### Fixed（发布工件跨环境可复现：给第十六轮的"边界"翻案）
- **归因翻案**：第十六轮实测记录"CI 产物与本机包 sha 不同，疑因 git 版本 / zip 容器元数据"，并据此把文档主张降级为"同环境字节可复现"。本轮按同一 ref 逐文件 **CRC** 对账，抓出真实成因是两个、且**都可消除**：① **行尾**——Git for Windows 默认 `core.autocrlf=true` 使 `git archive` 导出时做 LF→CRLF，实测本机包与 CI 包 **119/122 个文件字节不同，且差异全部只是行尾**（EOL 归一后 122/122 CRC 全等）⇒ 新增 `.gitattributes`（`* text=auto eol=lf`，另列二进制禁转换、`.bat/.cmd` 保 CRLF）；② **时区**——zip 的 MS-DOS 时间字段按**归档进程所在时区**渲染，CI runner 是 UTC、本机 UTC+8，同一 commit 同一 `--mtime` 仍差 284 个单字节（每个条目 1 字节）⇒ 出包与环境变量都钉 `TZ=UTC0`。教训：**"跨环境不可复现"是未归因，不是物理限制**——元数据类差异要先按字段定位再下结论
- **实测结果**：`TZ=UTC0 git -c core.autocrlf=false archive --format=zip --mtime=<tag 提交时间>` 本机重建 v1.15.0 源码包，与 GitHub Release 资产 **SHA256 全等**（`168f697d9e0f42bb…`，381160 B / 122 文件）⇒ 主张从"内容集合可复现 + 同环境字节可复现"升级为**跨环境逐字节可复现**
- 新增 `scripts/release_repro_check.py`（判据，纳入 ruff/mypy 受控面并被 `release.yml` 调用）：① 同 ref 二次构建 SHA256 全等；② **包内文本文件零 CRLF**（防 `.gitattributes` 被删或被 tree 外因素绕过）；③ 文件数 >100 非空证明；④ 给 `--against` 时与外部（CI）包 SHA256 全等。**两组反例实测 rc=1**：拿未钉 TZ 的本机包对账 → 报 `local=168f697d external=e148782e`；变异脚本（同时去掉 `-c core.autocrlf=false` 与 `TZ=UTC0`）→ 报 `包内文本文件零 CRLF … CRLF 文件=['.github/ISSUE_TEMPLATE/bug_report.yml', …]` 且 sha 不等。还原后 4 项 PASS rc=0
- `release.yml`：出包步骤显式 `env: TZ: UTC0`，并新增"可复现性自证"步骤调用上述门禁（**只出一次包不算可复现**）；步骤注释改写为"两个成因已定位并消除"，不再保留被证伪的旧边界表述
- **交付链同源事实（新增可核验点）**：`交付物/iCAN-参赛交付物/源码-…-v1.1.zip` 改由上述钉好行尾与时区的命令产出 ⇒ **参赛源码包与公开 Release 资产逐字节相同**（第三方下载公开包即可与本包 SHA256 直接对账，无须信任本机）
- 三条产品红线、运行时链路、检索默认档与评测口径零改动（JS 分支 75.24% / Py 92.78% / mypy 23 文件 0 error / 十四件套全绿，均与 v1.15.0 同值）

## [1.15.0] - 2026-09-25

### Added（端到端浏览器回归进 CI：对标 OpenEMR 的 Acceptance 常驻作业）
- 对标实测（`gh api actions/workflows`）：**OpenEMR** 有 `Acceptance test (docker)` / `Acceptance test (package)` / `Acceptance-only re-run + publish`（另配 `Github Actions Linting`、`Docker Compose Linting`）；**phlox** 的 `ci.yml` 里 grep 不到任何浏览器测试；**ragflow** 有 `release`/`sep-tests` 无 E2E；**medical-rag** 零工作流 ⇒ 浏览器级验收常驻作业 **1/4 有**。我方历史文档写的「桌面 1440 + 移动 390 双视口 E2E 通过」实际是**本机一次性人工运行**，不在任何常驻判据里——三条红线在真实浏览器渲染结果上此前零自动化拦截
- 新增 `frontend/playwright.config.mjs` + `frontend/e2e/app.spec.mjs`（devDep `@playwright/test@1.63.0`，`npm run test:e2e`）：跑**生产构建 + Pages Functions 本地运行时**（`wrangler pages dev dist --local`），刻意不设 `DEEPSEEK_API_KEY` ⇒ 必走 rule-fallback ⇒ 零网络零密钥、结果确定可进 CI。5 条用例覆盖：① 三张脱敏病例卡 + 常驻红线条款 + 演示声明 + **零控制台异常**；② 红线**负向**（全站不得出现「替代医生」/「自动诊断」）；③ 五步全链路（红旗区块 + 「不可被模型覆盖」声明 + `.mode-badge` 明确标注「规则引擎降级模式」+ 引用可见 + 检查建议三组 + SOAP 四段 + 「执业资质的医生」免责 + 打印入口）；④⑤ **1440×900 与 390×844 双视口 × 五步全页面**零横向溢出
- CI `ci.yml` 新增 `e2e` 作业（build → `playwright install --with-deps chromium` → `playwright test`），并把 `e2e` 加进 `deploy` 的 `needs`（fail-closed：浏览器回归不过就不部署）
- 刻意**不做**的两件事（附理由）：① 不进 `npm test` 链——那条链被 c8 整体包裹算覆盖率，混入浏览器进程会污染口径（与 lint 同理）；② 不装 firefox/webkit——AC 口径是双视口自适应，不是跨浏览器矩阵，加引擎只会让 CI 时长翻倍而不多抓一类缺陷。live 分支的自动化仍由 `tests/live_path_guard.mjs`（fetch 桩）负责，职责不重叠

### 反例与自纠（实测）
- **两组反例证明它真的会红（实测 rc 与报错原文）**：① 把常驻红线文案改一个字（终审→复核）→ `npx playwright test` **rc=1**，`1 failed / 4 passed`，报错原文即指到被改后的文案；② 只在报告页注入 `.report-sheet { min-width: 200vw }` → **rc=1**、`2 failed`（双视口各一次），报错原文 `病历报告页: scrollWidth=800 > clientWidth=390`——命中位置正是本轮新增的那半截断言，证明"五步全页面"不是纸面属性。两次都以还原文件+重建收尾，还原后 `npx playwright test` **rc=0 / 5 passed (19.8s)**
- **同类出口补全**：首版溢出断言只覆盖首屏与诊断页——报告页表格最宽、历史上最易出事的一半被留在盲区；本轮补成五步全页面逐页断言（并写进 CONTRIBUTING 的维护约定）
- **E2E 本轮没抓出产品缺陷，抓出的是测试自身的写法缺陷（两次）**：① 初版用定长 `waitForTimeout(250)` 点快选项，在请求 `busy` 期间点击被组件直接吞掉；改为"等对话气泡数量增加"后**仍然失败**——真正根因是用户气泡在点击瞬间就入列，`expect.poll` 立即返回，下一轮照样落在 `busy` 窗口里，8 轮预算被空等吃掉一半，表象却是"链路卡住"。② 终版改为等**打字气泡消失**（`.msg .typing` 计数归 0，即 `busy` 的真实渲染信号）后通过：五步全链路从"30s 超时失败"变 **4.7s 通过**。登记此条是因为这类假故障极易被后来者误判成产品回归；同时暴露一个通用判据：**等待条件必须取"被等对象的完成信号"，不能取"自己刚触发的副作用"**

### 门禁自身缺陷自纠（本轮跑全量门禁时按 R236「先实跑再据其下结论」抓到）
- `tests/link_health.mjs` 的 **BLOCKED 判据从"计数基线"改为"内容登记册"**：原 `BLOCKED_BASELINE = 0` 与实测值 1（`www.nhc.gov.cn` 返回 412，是其 WAF 反爬前置校验、浏览器可达）长期不一致 ⇒ 每次运行都打印"不得长期悬空"却**永远不红**，且真正新增的被拦源会被这条固定噪声淹没。这正是本项目反复在防的 cry-wolf 型判据（警告失去意义＝判据失效）。现在：`BLOCKED_REGISTRY` 按 `host → 状态码 + 登记日期 + 理由` 逐条登记，**未登记的被拦源直接判红**；反向还检查"登记册里的 host 如今已可达"并提示清理（防白名单只增不减变成掩体）。反例实测：临时删掉 nhc 登记项 → **rc=1** 且报 `https://www.nhc.gov.cn(412·未登记)`；还原后 **rc=0** 报 `零死链 + 被拦源全部已登记`。与本轮 lessons 口径一致：**计数型判据要看内容，不看数量**

### 度量与红线
运行时零变更 ⇒ JS 全局分支 75.24%（地板 74）、Py 92.78%（地板 88）、mypy 23 文件 0 error、ESLint/ruff/文本卫生/SBOM 对账全绿均与 v1.14.0 一致；新增 devDep 会进 SBOM 与依赖审计面（`@playwright/test` 及其传递依赖），已实测 `npm ci` 与 `npm run lint` 通过。三条产品红线逻辑零改动、默认检索档仍 bm25、评测仍是同一批 31 例。

## [1.14.0] - 2026-09-25

### Added（交付物可审计性：对标 OpenEMR / ragflow / phlox 的"打 tag 即由机器出包"）
- 对标实测（`gh api actions/workflows`）：**OpenEMR** 有 `Build Release on Tag` / `Build Release` / `Build Patch Release` / `Dependabot Auto-Merge`；**ragflow** 有 `release`；**phlox** 有 `Build and Release` + `release-please`；**medical-rag** 零工作流。我方发布链此前全靠本机手工 `git archive` + `gh release create`，同一轮内因"包内容与 tag 不同步"重锚三次 ⇒ 新增 `.github/workflows/release.yml`（tag 触发）：**先跑全部门禁**（ruff / type_gate / 文本卫生 / ESLint / 十四件套 / 双端覆盖率地板 / build / bundle / openapi 漂移）绿了才产出 `doctor-ai-dx-source-<tag>.zip` + 双端 SBOM + `SHA256SUMS.txt`，并挂到该 tag 的 Release；源码包由 `git archive HEAD` 产出（＝tag 内容，不含未跟踪文件），并自检"文件数 >100 且打印 SHA256"防半成品工件。
- SBOM 采用**成熟工具 + 钉版 + 门禁对账**：npm 侧 `@cyclonedx/cyclonedx-npm@6.0.1`（`npm run sbom`），pip 侧 `cyclonedx-bom==7.4.0`（CI 内）。新增 `frontend/tests/sbom_guard.mjs`（`npm run sbom:check`；放 tests/ 而非 scripts/ 是与 kb_guard/fhir_guard 同族，且能进 ESLint 覆盖范围）：校 `bomFormat/specVersion`、组件数 ≥50（**空清单不得判绿**）、每组件必有 name/version/purl、生成工具主版本与 manifest 相符（npm=6 / pip=7，**换大版本＝换判据**）、**本仓声明的 17 个 npm 直接依赖连同 lock 解析版本逐一在清单内**。四组反例实测 rc=1（删掉一条声明依赖 / 把 vite 版本改脏 / 组件表清空 / `bomFormat` 改成 SPDX）。
- SBOM 定位为**发布期产物不入库**（`.gitignore` 加 `docs/sbom/`）：入库就会产生"陈旧副本 vs 当前 lock"的第二真值，与本轮要消灭的漂移同类；改为随 tag 生成并公布 SHA256，可独立复核。
- 台账#18 关闭：`scripts/type_gate.py` 增**零豁免机器判据**——扫 `backend/app` + `scripts` 的行尾类型抑制注释与 `mypy.ini` 的 `disable_error_code`/`ignore_errors`/`follow_imports` 整段关闸，预算取 `fixtures/type_floor.json` 的 `max_suppressions`（实测全仓为 0 ⇒ 钉 0）。反例实测：临时文件注入一条抑制注释 → rc=1 且精确报 `文件:行`，删除后 rc=0。范围刻意**不含 ruff 的行尾 noqa**（那是另一套判据，理由逐条写在 `ruff.toml` 头注，混判会把已论证的余量一起打掉）。

### 由门禁自己抓出的三处"判据自指 / 覆盖缺口"缺陷（如实登记）
- 扫描器把**自身文档字符串里引用的被扫字面量**当成违规（`type_gate.py` 首跑自判红 1 处）。修法不是加白名单——按既有立规「文档引用不等于规则本体，不得据此豁免」，这里反过来同样成立：**扫描器自身文案不得内嵌被扫字面量**，改写为描述式表述。
- 生成型产物的复位必须重跑生成器：负例跑完我用 `json.dumps` 往返"复原"清单，对账仍判红 ⇒ 正确复位是 `npm run sbom` 重新生成（已按此复核并记录 sha256 变化）。
- **lint 覆盖缺口自查**：新写的 SBOM 守卫放在 `scripts/` 时**不在任何 lint 范围内**（ESLint 判据基准锁在 `frontend/`，实测把配置上移仓根又因插件解析不到 `frontend/node_modules` 而 rc=2）。正解是回到既有约定——`*.mjs` 门禁一律放 `frontend/tests/`（与 `kb_guard`/`fhir_guard`/`coverage_floor_guard` 同族），`scripts/` 只放 Python 工具。移入后 ESLint **立刻抓出该文件里一个只自增从不输出的死变量**（`pass`），证明"有 lint 覆盖"不是纸面属性。现两模式各 9 条判据通过，pip 侧改用 `cyclonedx-py environment`（实测 `requirements` 模式因本仓不钉死版本只出 5 条空壳清单，正是"清单存在但没用"的假门禁形态）。

### Changed
- 平台侧依赖图实测**不可用**：`GET/PUT /repos/lxh113377/doctor-ai-dx/dependency-graph/sbom` 均返回 404，而同法在 3/3 peer 上可读（1817 / 3038 / 1223 组件）⇒ 属账号/仓库设置面（需本人开启），**不以代码冒充已完成**，登记为待办；本轮因此把可审计性做在仓库自证产物上。
- 文档：`ARCHITECTURE.md` §7 新增「发布工件与 SBOM」行、`EVAL_CARD.md` 供应链行、`CONTRIBUTING.md` 增加"改依赖必须重跑 SBOM 对账"、README 命令表补 `npm run sbom` / `sbom:check`。
- 🔴 **同族缺陷第五次复发，被 r14 立的门禁当场抓住**：本轮给 `type_gate.py` 加零豁免判据时，正则里的词边界又在经 Python 字符串落地时变成裸 `0x08`（1 处），`check_text_hygiene.py` 首扫即报 `scripts/type_gate.py:39:82 控制字符 U+0008`。这是该缺陷类第四次在**本项目内**复发（r13 隐私判据 3 条 → r14 文档 2 处 + CHANGELOG 6 处 → r14 收口 AGENTS.md 1 处 → 本轮 1 处），也是"为什么必须留字节层门禁、不能靠记得用 raw 字符串"的最强证据。

### 红线影响
无。三条产品红线逻辑零改动；本轮只动发布与门禁基础设施（新增工作流/脚本/判据），运行时代码零变更；默认检索档仍 bm25，评测仍是同一批 31 例。


## [1.13.0] - 2026-09-25

### Added（类型层门禁：对标 OpenEMR 的 phpstan level 10 + baseline-diff，我方直接钉零错误档）
- 对标取证（`raw.githubusercontent` 逐文件实测）：**OpenEMR** `phpstan.neon.dist` 为 `level: 10`（最高档）且配三个工作流（`phpstan.yml` / `phpstan-types.yml` / `phpstan-baseline-diff.yml`，即"高严格 + 存量入基线 + 只拦新增"）；**phlox** 有 `tsconfig.json` 但 `strict:false`、`allowJs:true` + `checkJs:false`（装了不用）；**ragflow** 只有 `[tool.ruff]`（无 mypy/pyright）；**medical-rag** 根目录零配置。**CDSS-RAG-Chatbot 连续两轮 404 ⇒ 锚点退役**，本轮按 4 个活体锚点计。类型层门禁现状：2/4 有，我方此前为零。
- `mypy.ini`（仓根，与 `ruff.toml` 同构）：`files = backend/app, scripts`、**`check_untyped_defs = True`**（连未标注函数的函数体也查，取向与 phlox 的 `strict:false` 相反）、`warn_unused_ignores`、`no_implicit_optional`、`show_error_codes`。刻意**不含任何 per-module 豁免段**——实测把唯一候选（生成物 `var-annotated`）关掉后仍是 23 文件 0 error，留着就是"以后也许用得上"的暗门；`ignore_missing_imports` 是唯一全局放宽并写明理由（第三方缺 stub 不算本仓缺陷）。
- `scripts/type_gate.py` + 阈值单一源 `frontend/tests/fixtures/type_floor.json`：除 mypy 退出码外还核对三件事——**实跑检查文件数 ≥ 22**（R247 输入非空证明：mypy 静默检查 0 个文件也会报成功）、**`requirements-dev.txt` 是否钉住 mypy 版本区间**（换版本=换判据）、**实跑版本 ≥ 阈值最低版本**。`expected_errors: 0` 只准收紧。四组反例实测：阈值下限抬到 999 → rc=1；注入 `data["k"]`（str 当下标）→ 报 2 条 error 且 rc=1；去掉钉版行 → rc=1；阈值文件缺失 → rc=2（fail-closed）。
- `npm run typecheck` 与 pre-commit 第 8 钩；CI `backend-test` 作业新增 `Type gate` 步骤（与 ruff 同 job，devDep 已具备）。

### 首跑 26 条告警的逐条处置（关键判断：**不为凑绿而加豁免**）
1. **19 条是推断噪声，正解在生成器不在下游**：`backend/app/knowledge.py` 由 `03-评测/export_kb.mjs` 生成且无任何标注 ⇒ mypy 推断为 `dict[str, object]`，下游 `rag.py` / `retriever.py` / `engine.py` 成片报"object 不可下标"。修法=在**生成器**里注入 `from typing import Any` 与四行精确标注后重新生成；并用 AST 逐结构深度比对证明**数据零改动**（55 条目 / 60 症状键 / 32 红旗词 / 34 同义词全等），`kb_guard` 17 项双端对账仍绿。
2. 🔴 `llm.py` **`BaseProvider` 没有构造契约**：`PROVIDERS: dict[str, type[BaseProvider]]` 以 4 个关键字参数实例化基类 ⇒ mypy 判 `call-arg` ×4。这不是"标注补一下"：它意味着**新增 Provider 若签名不一致，只能运行时炸**。补基类 `__init__` 契约（子类保持自身实现，与 JS 端 `llm.js` 同构），并加三条断言（四参数落字段 / 基类 `chat` 必抛 `NotImplementedError` / 未知 provider 名抛 `LLMUnavailable` 而非静默回退默认供应商）。
3. 🔴 `rules.py` 两张异构规则表未标注 ⇒ 两个循环复用同名变量即触发 `[assignment]` 冲突。**红旗表加字段会静默漂移**，这一条正是类型层对红线的暴露。与生成物同口径标注（数据表 `Any`、逻辑函数具体类型）。
4. 🔴 `fhir.py` 以 `p.get("gender")`（可能 `None`）作 `GENDER_BY_TEXT` 的键——`check_untyped_defs` 抓出；改为显式归一，行为逐值不变。
5. 🔴 `scripts/gen_openapi.py` 对 `re.search(...)` 结果直接 `.group(1)`：版本单一源被改坏时抛 `AttributeError` 而非可读错误（`union-attr` 抓出）⇒ 改 fail-closed 显式报错。
6. `scripts/build_semantic_neighbors.py` 空列表 `pairs` 无元素类型 ⇒ 按真实形状 `list[list[str | int]]` 标注（顺带把返回类型从裸 `list[list]` 收紧）。

### 由新测试暴露并修掉的产品级缺陷（🔴 双端同步）
- **追问"续问硬上限 3 轮"原本形同虚设地漏钱**：`engine.js` / `engine.py` 都是 `live = await llmFollowup(...)` **之后**才判 `idx < answers.length + 3` ⇒ 超限那一轮仍完整付一次 LLM 请求（最长 8s 超时窗口 + token）再把它丢弃。把上限前移到调用之前，并补三条对位断言：超限即 `done/mode=rule`、**超限轮零外呼**（实测 `calls=0`）、上限前一轮仍走 live（证明没把可用路径一起砍掉）。
- 顺带补上从未执行的 `nextIntakeQuestion` live 分支：脚本本题答完后 LLM 接管（`mode=live`、`reply===question`、chips 透传、仍走同一 `/chat/completions`）、`{done:true}` 收敛、空 `question` 不返回假 live、HTTP 500 异常被兜住。`live_path_guard.mjs` 36→**43 项**、`test_live_path.py` 25→**37 项**，两端逐条对位。

### 度量（涨跌都记）
- Python：`engine.py` 77→**85%**、`llm.py` 86→**88%**，全局 **90.53→92.78%**（口径仍是 r14 起的"语句+分支弧"）；模块地板随实测收紧 `engine.py` 74→82、`llm.py` 83→85。
- JS：**如实登记回落** —— 全局分支 75.65→**75.24%**、`engine.js` 分支 70→69.5%。起因是上限前移（删掉一个三元里的恒真条件、新增一个提前返回）改变了分支计数，属真实修复的度量副作用；**地板不降**（`engine.js` 分支地板仍 68，余量 1.5pt，已在 fixture `_meta.js_floor_note_r15` 写明）。
- 新增受控文件 3 个：`mypy.ini`、`frontend/tests/fixtures/type_floor.json`、`scripts/type_gate.py` ⇒ 受版本控制文件数 115→**118**。

### 红线影响
红旗规则层逻辑零改动（`rules.py` 只加类型标注与注释）；引用白名单与"辅助参考 · 医生终审"文案零触碰；默认检索档仍 bm25；评测口径仍是同一批 31 例。唯一行为变化是**追问超限轮不再外呼**（收敛结果与原先逐字段一致，仅省掉一次被丢弃的请求）。

## [1.12.0] - 2026-09-25

### Added（静态质量门禁：对标实测同类 5 家中 3 家有 linter，我方此前全仓零静态检查）
- 对标取证（`gh api contents` 实测）：`OpenEMR` 有 `eslint.config.mjs` + `.pre-commit-config.yaml` + 专门 Linting 工作流；`ragflow` 有 `pyproject.toml`(ruff) + `web-lint` 工作流 + CodeQL；`phlox` 有 `eslint.config.js` + CI + CodeQL；`medical-rag` 无任何工作流；`CDSS-RAG-Chatbot` 现已 404（仓库消失，登记为「维护状态」证据）。我方前端无 ESLint、后端无 ruff/flake8/mypy ⇒ 本轮补齐
- `frontend/eslint.config.mjs`（ESLint 9.39.4 flat config，插件 `@eslint/js` 9.39.5 / `eslint-plugin-react` 7.37.5 / `react-hooks` 7.1.1 / `react-refresh` 0.5.7 / `globals` 17.12.0）+ `frontend/lint.mjs`（把执行目录钉在 `frontend/` 的薄壳，理由见文件头注）+ `npm run lint:js|lint:py|lint`，**`--max-warnings=0`：警告也算红**
- `仓根 ruff.toml`（ruff 0.16.5，`requirements-dev.txt` 钉 `>=0.16.5,<0.17`）：**规则集显式钉文件**——实测 ruff 0.16 默认 select 已含 `I/B/UP/RUF100` 而旧版只含 `E4/E7/E9/F`，靠默认值等于"换工具版本即换判据"。刻意不选 `BLE001`（失败安全降级本就靠宽 `except` 兜，逐条断言在 `test_live_path.py`）与 `RUF100`（ruff 与 pycodestyle 对 `E402` 的判定不同，钉它会随换检查器而判据反转），理由写进配置头注
- `scripts/coverage_gate.py`：Python 侧模块级地板门禁，与 JS 侧 `coverage_floor_guard.mjs` 读**同一份** `fixtures/coverage_floor.json`（新增 `py_modules` 9 项模块地板）
- `scripts/check_text_hygiene.py`（新增文本卫生门禁，CI 第 4 个 job + 第 7 枚 pre-commit 钩子）：扫 `git ls-files` 的 105 个受控文本文件，禁止 C0 控制字符（`\t \n \r` 之外）与 DEL。**立论依据是同类缺陷两次实测**：v1.11.0 的 `\b`→`0x08` 死判据、v1.12.0 写本文档时同一机制当场复发——"记得用原始字符串"防不住，需要与语言无关的字节层门禁。清单条目数低于 40 即判红（防"清单来源坏了 ⇒ 零违规"的假通过）
- 双端同表红旗探针 6 条（`engine_smoke.mjs` 的 `RED_FLAG_PROBES` ↔ `smoke_engine.py` 的 `RED_FLAG_PROBES` 逐字同表）：覆盖数值血压判定、组合线索、超生理值域拒收、同名去重、空输入。两端各自做变异实测——取消 JS 侧值域守卫 → JS rc=1；取消 Py 侧同一守卫 → Py rc=1
- 后端路由级断言 25 条（`test_api_observe` 15 → 40）：四条业务路由 404、未匹配路径 404、全链路 200（抽取→诊断→检查→报告）、慢请求 warn 分支与字段白名单；前端 `route_guard` 14 → 25（补无 `crypto.randomUUID` 回退、warn/info 两级日志、`redact` 空入参与非字符串、`withRequestId` 两条分支、404 错误体权威面基准）

### 由新门禁抓出的真实缺陷（逐条实测，非风格问题）
1. 🔴 **隐私判据里有三条"永不匹配"的死正则**：`privacy_guard.mjs` 的 `\bSentry\.init\b`、`\bdsn\s*:`、`\bfbm\b.*sdk` 中的 `\b` 在上一轮由 Python 写文件时被转义成**裸 `0x08` 退格符**（5 处），正则要求文本里真有一个退格字符 ⇒ 永不命中 ⇒ 遥测扫描静默假通过。当时聚合反例仍判绿（同一条 poison 里 `@sentry/` 那条救回了命中数）。ESLint `no-control-regex` 抓出；修复后把"聚合反例"升级为**判据逐条自证**：25 条形态各配一条真实写法样本 + 数量对位断言 + 「元反例」证明自证块能识别死判据（`privacy_guard` 30 → **59 项**）。教训：聚合命中 ≠ 逐条接线
2. 🔴 **双端错误体不同形**：后端 404 吐 FastAPI 默认 `{"detail": "unknown case: nope"}`，权威面 Functions 吐 `{code,message}`；且第一版处理器注册在 `fastapi.HTTPException` 上仍漏掉未匹配路径的 404（Starlette 自己抛基类，实测 `{"detail":"Not Found"}` 照旧外泄）⇒ 改注册到 `StarletteHTTPException` 并统一文案为 `not found: <path>` 与 Functions 同形。**该缺陷此前零判据覆盖**：`contract_parity` 只比引擎输出、`api_contract_guard` 只比 OpenAPI↔Functions，而 `app/routers/api.py` 语句覆盖 57%、四条路由的 404 分支从未执行
3. 🔴 **CodeQL 从未扫过生产分支**：实测 30 次分析全部落在 `refs/pull/*/merge`，`refs/heads/main` 为零（只在 Dependabot PR 与 cron 上触发）⇒ 补 `push: [main]`。与 round9「门禁挂在长期 skipped 的 deploy 作业上 = 没有门禁」同族
4. **覆盖率地板"清单与判据两套数"**：`py_total_fail_under` 写在 fixture 里但**没有任何代码读它**，真实阈值 `--fail-under=85` 硬编码在 `ci.yml` 与 `package.json` 两处 ⇒ 改 JSON 不影响判定。现两处均改调 `scripts/coverage_gate.py`，反例实测（假地板：模块改名 + 抬到 99%）两条均判红 rc=1
5. 死代码与缺陷类告警清零：后端 `F401`（`SEMANTIC_META` 死导入）、`F841`（`fhir.py` 死变量，与 JS 端逐行核对确认非漏用）、5 处 `B904`（`raise ... from None`，与「日志不写堆栈」的隐私声明一致）、10 处导入次序；前端死类 `Http404`、4 处死导入、恒真三元 `filter(x ? true : true)`、`no-useless-escape`
6. `App.jsx` 三处 `exhaustive-deps` 告警按规则建议改为解构稳定成员（`useCallback` 已稳定，语义零变化）——而非写死 disable；`require-await` 经实测确认会误判 fetch 桩与同形 async 签名，故不启用并写明理由
7. 新立的文本卫生门禁**首跑即抓出 2 处同族缺陷**（`ARCHITECTURE.md` 与 `EVAL_CARD.md` 各 1 处 `0x08`，均为本轮用 Python heredoc 写文档时 `\b` 被转义），另在自己刚写的 CHANGELOG 里当场抓到 6 处 ⇒ 该门禁不是假想需求。反例实测：临时文件混入退格符 → 精确报出 `文件:行:列 + U+0008` 且 rc=1
8. 该门禁**第一次在 CI 上跑就判红了自己**：它自己的源码里"非 UTF-8 检测"用的字面量替换符被当作内容写进文件（合法 UTF-8，但扫描器把它当违规字节报出）⇒ 改为只写转义序列。同时把 ruff 配置从 `backend/ruff.toml` 上移为**仓根 `ruff.toml`**，`scripts/` 一并纳入静态检查 —— 顺带暴露 `build_semantic_neighbors.py` 的 B904 与无占位符 f-string 两处真问题（均修）；生成器只改源码未重跑，`semantic_guard` 22 项与语料指纹复验零漂移

### 度量与地板（口径变更如实标注）
- `backend/.coveragerc` 开启 **`branch = True`**：Python 口径由「仅语句」改为「语句+分支弧」（更严）。同批测试新口径实测 **90.53%**（旧语句口径 87%）；`rules.py` 75→**98**、`routers/api.py` 57→**100**、`main.py` 96→98；地板 85→**88**
- JS 全局分支 **74.18 → 75.65%**（`observe.js` 分支 69→**100**）；地板全线收紧（engine 分支 65→68、fhir 72→74、rag 74→75、retriever 80→81、rules 85→86、knowledge 68→69、全局 72→74），并把此前**不在清单内**的 `observe.js`（脱敏层）以 98/98/98 登记
- `.pre-commit-config.yaml` 四钩子 → **七钩子**（+ESLint +ruff +文本控制字符扫描）。实测 `pre-commit` 4.6.2 对 `repo: local` 的 `cwd` 键只告警不生效 ⇒ 前端改由 `lint.mjs` 内部钉目录。钩链反例实测：往 `version.py` 塞死导入 → ruff 钩判红，恢复后 6/6 Passed
- 套件数变化：`engine_smoke` 43→49、`route_guard` 14→25、`privacy_guard` 30→59、`coverage_floor_guard` 25→28；后端 `smoke_engine` 19→25、`test_api_observe` 15→40（`test_fhir` 17、`test_live_path` 25、`test_retriever_channels` 25 不变）
- 文档口径纠偏：README/CONTRIBUTING 里「七件套/九件套/十三件套」的漂移表述统一为十四件套并补 lint 命令与判据维护约定

### 红线影响
无。三条产品红线逻辑零改动（红旗规则层只**新增**测试，未改判定；引用白名单与终审文案零触碰）；默认检索档仍 `bm25`；评测口径仍是同一批 31 例，未因本轮改动调整任何期望值。`App.jsx` 的依赖数组改写属渲染层等价改写，客户端 bundle 因源码改动必然换 hash，已用线上实测复核。


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
