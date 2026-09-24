# 更新日志

本项目格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
评测口径以各版本附带的 31 例离线评测与 `docs/EVAL_CARD.md` 为准；任何涉及红旗规则层、引用白名单、"辅助参考 · 医生终审"文案的变更都会在对应版本显式标注。

## [Unreleased]

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
