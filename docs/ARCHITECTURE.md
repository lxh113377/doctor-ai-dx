# 架构与不变式（ARCHITECTURE）

> 口径：本文所有数字/路径/参数均为 2026-09-24 磁盘实测（代码直读 + 门禁实跑），非规划值。
> 维护要求：改动链路/规则层/检索层后须同步本页与 `docs/EVAL_CARD.md`，并由 `npm test` 十件套兜底。

## 1. 一图流：单次诊断请求的六段链路

```
病例(脱敏合成) ─┐
                ├─① 临床状态抽取 extractState        engine.js:30 / engine.py
                │     症状·体征·缺项·红旗线索
② BM25 证据检索  rag.js / rag.py ──────────────────►  evidence[] (kb-001..055)
③ LLM 结构化生成  llmDiagnosis  engine.js:212 / llm.py
④ 确定性校验     validateDiagnosis  engine.js:133   ← 引用白名单 + 结构完整性
⑤ 红旗规则兜底   rules.js / rules.py（13 关键词 + 4 组合 + 血压阈值）
⑥ 失败安全降级   ruleDiagnosis  engine.js:192        ← LLM 不可用时仍可出结论
                └─► dx → workup → report（红旗一律服务端重算，不信前端）
```

三条产品红线在链路中的位置：

| 红线 | 实现点 | 由谁守 |
|---|---|---|
| 红旗层独立于 LLM、不可被模型覆盖 | ⑤ 在 ③④ 之后执行且只增不改；`reuseOrBuild` 复用前端 dx 时仍重算红旗 | `route_guard` / `engine_eval` 27+31 项、后端 `smoke_engine` 19 项 |
| 全界面「AI 辅助参考 · 医生终审」 | 前端持续显示 + report `disclaimer` 字段 | `tests/redline.test.jsx`（vitest 7 项） |
| 引用可溯源（不得编造证据） | ④ 白名单校验 `has_evidence(evidence_id)`；越界即降级 | `engine_eval` 引用断言 + `kb_guard` schema |

## 2. 权威面与镜像面

线上权威实现是 **Cloudflare Pages Functions**（`frontend/functions/`），FastAPI 后端（`backend/`）为同链路镜像，供本地/自建与 FastAPI 栈评审使用。两端零漂移由下列对账矩阵保证：

| 语义 | 权威（JS） | 镜像（Py） | 对账门禁 |
|---|---|---|---|
| 知识数据单一源 | `functions/lib/knowledge.js` | `app/knowledge.py`（导出） | `npm run test:kb`（16 项，含四组数据深度相等） |
| BM25 检索 | `functions/lib/rag.js` | `app/rag.py` | `npm run test:retrieval-parity`（50 例双档） |
| 红旗规则 | `functions/lib/rules.js` | `app/rules.py` | `npm run test:contract`（31 例逐字段，容差 0.002） |
| 引擎链路 | `functions/lib/engine.js` | `app/services/engine.py` | 同上 + `backend/tests/smoke_engine.py` |
| 取整规则 | `Math.round(x*10^n)/10^n` | `round_half_up()`（Py 内置为 half-even，会差末位） | `test:contract` |
| 症状探针清单 | 由 `SYMPTOM_TO_KB` 派生 | 同 | `test:kb`「探针单一源」两项 |
| 版本号 | `functions/lib/version.js` | `app/version.py` | `npm run test:version` 五方对账 |

## 3. 检索层（实测参数）

- 分词：中文逐字 + 相邻二元组归一；查询小写、截断 500 字。
- BM25：`K1=1.5`、`B=0.75`；`top_k` 钳制 1..10；稳定排序（分数降序 + 原文档序）。
- 同义词扩展：34 组；症状→证据映射 60 键；红旗加权词 32 个（命中每条 +2）。
- 知识库：55 条 / 19 病种域，ICD-10 映射 51 条（余 4 条显式 `null` 待临床复核）。
- 检索器可切换（注册表三档）：默认 `bm25`；`hybrid`（BM25+概念通道加权 RRF）与 `semantic`（BM25+语义近邻通道）均为 **opt-in**。
- `semantic` 档（v1.9.0 起）：条目↔条目余弦邻接表由 `scripts/build_semantic_neighbors.py` 在**构建期**用本地 BAAI/bge-small-zh-v1.5（512 维，权重 sha256 记录在产物头）蒸馏，运行时**零模型/零网络/零向量服务**，纯查表且双端同源（`semantic_neighbors.js` ↔ `semantic_neighbors.py`）。
  **实测无增益，故不作默认**：54 组权重网格（`work/sweep_semantic_weights.mjs`）在 20 例留出集上「严格优于 bm25」的候选 = **0 组**，9 组与 bm25 逐位等值（通道惰性），45 组劣化（ΔMRR 最差 −0.328）；根因是该通道只做重排名次、无法对**查询**编码，而同类开源项目为此统一外挂 Milvus/Chroma/FAISS/TEI。条件触发路线亦不可解：漏检例 top1 分 14.39/17.65 与命中例最低 12.41 区间重叠（R236 补注③：改机制而非调参）。保留为语料扩容（55→200+）后的复测位，与 `adjacencyChannel`（标定权重 0）同一处置惯例。
- 溯源棘轮：未回链条目上限 32、深链下限 0，只准变好（`kb_guard` 强制）。

## 4. LLM 接入与降级

- 单次硬超时 **8.0s**；只输出 JSON 的调用走 `response_format=json_object`。
- 失败面（无 Key / HTTP≠200 / 网络异常 / 输出非对象）统一抛 `LLMUnavailable`，由引擎捕获后转 ⑥ 规则降级，响应带 `mode` 与 `fallback_reason`。
- Provider 抽象：`LLM_PROVIDER` 环境变量（默认 `openai_compatible`），换 OpenAI 兼容端点改 `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL` 即可。
- 系统提示词内嵌四条硬约束（仅辅助参考 / 高危优先急诊转诊且不推翻已检出红旗 / 只引用给定 `evidence_id` / 不编造检查数值）。

## 5. 可观测性与契约

- 每请求一个编号：响应头 `X-Request-Id`，前端故障文案内回显该编号供对账。
- 慢请求阈值 `SLOW_MS = 8000`（双端同值），只补日志不改响应。
- 日志最小集归因：不写堆栈、不写请求体（防病例文本入日志）、`sk-` 形态与 env 密钥脱敏、内部路径替换、超长截断。
- 错误面：422/500 均只回医生可理解文案 + 编号；`docs/openapi.json` 为 6 端点机器可读契约，由 `test:api` 双向对账 + CI `gen_openapi.py --check` 守版本。

## 6. 配置与端口

| 变量 | 默认 | 用途 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空（→ mock-fallback） | LLM 密钥，仅服务端 env，禁入库 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_PROVIDER` | `openai_compatible` | Provider 抽象开关 |
| `BACKEND_HOST` / `BACKEND_PORT` | `127.0.0.1` / `8000` | FastAPI 监听 |
| `CORS_ORIGINS` | `http://localhost:5173` | 逗号分隔白名单 |

端口口径：`8788` = 一体化演示（`wrangler pages dev dist --local`，与线上零漂移）；`5173` = Vite 开发服（代理到 8000）；`8000` = FastAPI（本机或容器）。
本地启动：Windows `powershell -File start-demo.ps1`；跨平台（Linux/macOS/Git Bash）`./start-demo.sh`；仅有 Docker 时 `docker compose up -d`（`backend/Dockerfile` 基于 `python:3.12-slim`，镜像内置 `BACKEND_HOST=0.0.0.0` 与 HEALTHCHECK；`docker compose run --rm selftest` 跑镜像内 19+15+16 项断言自证，实测 exit 0）。
容器边界（如实声明）：compose 只编排 FastAPI 镜像面——生产权威面是 Cloudflare Pages + Functions（serverless，不可自托管为容器），强行容器化前端只会造出与线上不同的一条链路。
线上 `/api/health` 返回 `version`，可用于确认部署版本。

## 7. 门禁清单（合入前必须全绿）

| 层 | 命令 | 覆盖 |
|---|---|---|
| 前端十三件套 | `cd frontend && npm test` | smoke 43（含红旗规则分支边界 16 项）· engine 31 · retrieval 50 例双档地板 · retriever parity 3 档 × 50 例 · semantic 22（含 7 组反例 + 语料指纹防陈旧）· **live_path 36（注入 fetch 桩验三条红线，零网络）** · 双端契约 31:31 · fhir 45（含 6 组反例 + 分支补测）· kb 17 · route 14 · api 契约 6 端点 · vitest 7 · version 五方 |
| 覆盖率地板（JS） | `cd frontend && npm run coverage:js` | c8 12.0.0 包住整条 npm test（套件只跑一次）→ `coverage_floor_guard.mjs` **按模块级**地板对账（rules/engine/fhir/rag/retriever/knowledge + 全局）；三条硬判据：输入非空证明、模块级地板、地板清单与产物改名对账；反例实测 3 组（summary 缺失／地板抬高／模块改名）均判红。刻意不接 Codecov 等外部服务（与零外部件架构一致） |
| 覆盖率地板（Py） | `cd frontend && npm run coverage:py`（CI 同命令） | coverage.py 7.16.0 + `backend/.coveragerc`；5 套脚本合并统计后 `--fail-under=85`。dev 依赖走 `requirements-dev.txt`，实测**不进运行时镜像**（容器内 `import coverage` 报 ImportError） |
| 构建体积 | `npm run build && npm run test:bundle` | 主 chunk gzip ≤77500B / assets 合计 ≤86500B（地板线，防膨胀也防假瘦身） |
| 后端 | `smoke_engine` / `test_api_observe` / `test_fhir` / `test_live_path` / `test_retriever_channels` | 规则降级 19 · 可观测脱敏 15 · FHIR 17 · **live 路径红线 25**（桩 httpx 零网络）· **检索通道 25**（三档纯函数与 RRF 语义） |
| 容器（从零启动自证） | `docker compose up -d` + `docker compose run --rm selftest` | 镜像构建成功 + HEALTHCHECK `healthy` + 镜像内 **19/15/16/25/25 五套** exit 0（源码树级检查在容器内显式 SKIP，不计通过也不计失败；coverage 等 dev 件实测不在镜像内） |
| 契约派生件 | `python scripts/gen_openapi.py --check` | openapi 版本与后端单一源一致（只同步版本行，禁全量重写） |
| CI | `.github/workflows/ci.yml`（3 job）+ `codeql.yml` + `dep-audit.yml` | 上述全量 + 每周 npm/pip 漏洞扫描 |
| 引用链健康（唯一联网门禁） | `cd frontend && npm run test:links` | 知识库全部 url 逐条可达性核验：DEAD 即红、412/403 类反爬按 BLOCKED 只报不红；CI `link-health.yml` 每周跑（观察期） |
| 交付一致性（工作区侧） | `node work/freeze_check.mjs` / `python work/check_delivery_consistency.py` | PDF 20 页、视频 284.7s、线上 live+version、HEAD 锚点、ZIP 与目录三类归零 |

## 8. 扩展点与边界

- 加一条知识：改 `functions/lib/knowledge.js`（唯一源）→ `test:kb` 会拦 schema/孤儿/溯源违规 → 重导出 `backend/app/knowledge.py`。
- 补一条回链：先实测该 URL 可达（`npm run test:links` 或 curl 200）→ 把域名加进 `kb_guard.mjs` 的 `VERIFIED_HOSTS` → 再写进条目；**未核验域名会被离线白名单直接拦下**（2026-09-25 实测教训：16 条 url 指向 DNS 不存在的域，属假回链）。
- 加一条红旗：`rules.js` 的 `DANGER_RULES`（单词）或 `COMBO_RULES`（多线索组合，降低非特异词误报）→ 同步 `rules.py` → `test:contract` 兜底。
- 换模型/自建推理：只动 `llm.py` 的 Provider 与 `DEEPSEEK_BASE_URL`，链路与红线不受影响。
- 重建语义邻接表（**知识库一改必做**）：`python scripts/build_semantic_neighbors.py --engine-dir <含 bge_onnx_engine.py 的目录>` → 产物头写回 `corpusSha256` → `npm run test:semantic` 会比对实算指纹，**忘记重跑即判红**（2026-09-25 变异实测：改一条正文 → `表内 5422… vs 实算 7385…` FAIL）。
- 明确未提供：鉴权与多租户、数据持久化（无患者落库）、查询侧语义编码（需向量服务，serverless 形态下未引入；条目侧邻接已落地但实测无增益）、真实临床验证（评测为 silver 标注）。

## 9. FHIR-light 导出层（对外集成面，v1.8.0 起）

兑现 README 的「可被既有 HIS/公卫平台集成的能力单元」——诊断响应 `data.fhir` 直接给出 FHIR R4 资源 Bundle，集成方无需自定义字段映射。

| 面 | 口径（实测） |
|---|---|
| 实现 | `functions/lib/fhir.js`（权威）↔ `backend/app/services/fhir.py`（镜像），纯函数、零网络、零 LLM |
| 资源组合 | Bundle(`collection`) = Patient + Encounter + Condition(疑似/鉴别) + Observation(症状/红旗/引用) + DiagnosticReport |
| 插入点 | `buildDiagnosis` 末端（确定性校验与红旗兜底**之后**）→ 只读派生视图，红旗层与引用白名单零触碰 |
| 术语绑定 | 只用 HL7 已发布 CodeSystem 的 code：`condition-clinical#active`、`condition-ver-status#unconfirmed`、`condition-category#encounter-diagnosis\|problem-list-item`、`v3-ActCode#AMB`、`administrative-gender`、`bundle-type#collection`、`observation-status#final`、`diagnostic-report-status#final\|partial`；本地语义走本仓命名空间 `…#fhir-light/code`（仅 `red-flag`/`citation` 两值） |
| ICD 规则 | 知识库 `icd` 为 null 的条目**只出 `text` 不出 `coding`**——标准编码不得由系统编造（`fhir_guard` + `test_fhir` 双向锁） |
| 确定性 | 无 `timestamp`/`issued`/`effective` 字段，同输入逐字节相同 → 才能进 `test:contract` 的 31 例双端逐字段对账 |
| 状态语义 | `mode=live` → `DiagnosticReport.status=final`；降级 → `partial` 并在 `conclusion` 写明降级原因（如实标注，不伪装成终稿） |
| 红线携带 | 每份 `conclusion` 以「AI 辅助参考 · 医生终审」开头；Patient 打 `syntheticCase=true` 扩展，演示数据不含真实患者 |
| 门禁 | `npm run test:fhir`（30 项，含 6 组反例：非法 system/非法 code/悬挂引用/时钟字段/丢终审文案/编造 ICD）+ 后端 17 项 + CI backend 新步骤 |
| 边界 | **light 子集，不声称符合官方 Profile**：未做 StructureDefinition 校验、未接术语服务器、无 Transaction 幂等写回；`docs/openapi.json` 的 `fhir` 字段描述即对外承诺面 |
