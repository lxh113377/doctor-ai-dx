# 更新日志

本项目格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
评测口径以各版本附带的 31 例离线评测与 `docs/EVAL_CARD.md` 为准；任何涉及红旗规则层、引用白名单、"辅助参考 · 医生终审"文案的变更都会在对应版本显式标注。

## [Unreleased]

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
