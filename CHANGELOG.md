# 更新日志

本项目格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
评测口径以各版本附带的 31 例离线评测与 `docs/EVAL_CARD.md` 为准；任何涉及红旗规则层、引用白名单、"辅助参考 · 医生终审"文案的变更都会在对应版本显式标注。

## [Unreleased]

### Added
- `.github/ISSUE_TEMPLATE/`（bug/feature 双表单，内嵌红线自查与脱敏提醒）与 `PULL_REQUEST_TEMPLATE.md`（红线/门禁证据/文档同步三段自查）——清偿 round1 差距面"无 issue 模板"欠账（"差距描述必进清单"对账执行）
- CONTRIBUTING 增"依赖维护策略"节（auto-merge 口径 / 聚合批 / major peer 前置）；仓库启用 native auto-merge

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
