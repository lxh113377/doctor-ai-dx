# 医 · 基层AI辅助诊断系统 — v0.3

[![CI](https://github.com/lxh113377/doctor-ai-dx/actions/workflows/ci.yml/badge.svg)](https://github.com/lxh113377/doctor-ai-dx/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/lxh113377/doctor-ai-dx)](https://github.com/lxh113377/doctor-ai-dx/releases)
[![CodeQL](https://github.com/lxh113377/doctor-ai-dx/actions/workflows/codeql.yml/badge.svg)](https://github.com/lxh113377/doctor-ai-dx/security/code-scanning)

面向基层医生的 AI 辅助诊断网页端程序。**临床状态抽取 → BM25证据检索 → LLM结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级**，三重保障控制幻觉。

## 架构（双后端同源）

```
frontend/   React 19 + Vite 6（五视图 SPA：选病例 → 问诊 → 诊断 → 检查 → 报告）
  functions/  Cloudflare Pages Functions —— 线上权威后端（与前端一次部署）
backend/    FastAPI —— 同一链路的 Python 镜像（可选本地运行，满足 FastAPI 栈要求）
```

- **线上 = Functions**：`https://doctor-ai-dx.pages.dev`，前端 dist + functions/ 单次部署。
- **两端镜像**：`backend/app/{knowledge,rules,rag,retriever}.py` 与 `functions/lib/{knowledge,rules,rag,retriever}.js` 逻辑一致；`knowledge.py` 由 `scripts/export_kb.mjs` 从 `knowledge.js` 自动生成（`npm --prefix frontend run kb:export`），保证知识库数据零漂移。
- `rules` 危险信号规则引擎（不依赖 LLM，可解释可测试，命中即强制转诊，**优先级高于模型不可覆盖**）
- `rag` BM25 + 医学术语同义词扩展检索，输出带 `id/source/year/url/scope` 的证据
- `retriever` 检索器适配边界；当前默认且唯一启用原 BM25，后续可增加混合检索，BM25 始终保留为安全回退
- `engine` 确定性校验：非法 `evidence_id` 直接拒绝；无 Key / 超时 / JSON 非法 → 明确标注 `mode=rule-fallback` 降级
- `llm` DeepSeek（OpenAI 兼容）；单次硬超时 8s

## 启动（本地演示，三选一）

```bash
# 方式A（推荐·与线上零漂移）：一键脚本，跨平台（Linux/macOS/Git Bash）
bash start-demo.sh         # 或 ./start-demo.sh（已置执行位）；Windows 亦可 powershell -File start-demo.ps1
# 或手工执行同样三步：
cd frontend && npm install && npm run build
node node_modules/wrangler/bin/wrangler.js pages dev dist --port 8788 --local
# 打开 http://127.0.0.1:8788

# 方式B（FastAPI 栈）：起 Python 后端 + Vite 前端
cd backend && cp .env.example .env   # 有 DeepSeek Key 则填入；无 Key 走 rule-fallback
python -m pip install -r requirements.txt && python run.py   # :8000（本机开发用声明面；容器与 CI 用 requirements.lock 安装面）
cd ../frontend && npm install && npm run dev                 # :5173，/api 代理到 8000

# 方式C（容器）：只需 Docker，不装 Python/Node
docker run --rm -p 8000:8000 ghcr.io/lxh113377/doctor-ai-dx:latest   # 直接拉发布镜像（第十九轮起由 tag 触发推 GHCR）
docker compose up -d          # :8000 起 FastAPI 镜像面（无 Key ⇒ 按设计降级 rule-fallback）
docker compose run --rm selftest   # 镜像内全套离线断言（清单由 backend/tests/suite.json 单源驱动）
```
> 容器只编排 FastAPI 镜像面：生产权威面是 Cloudflare Pages + Functions（serverless，不是可自托管的容器），故不入 compose。

> 无 DeepSeek Key 时两端均自动进入**规则引擎降级模式**并在界面明确标注，功能完整可演示（AC-OBS-07）。

## 自动化验证（无需 LLM Key）

```bash
cd frontend
npm test       # 二十件套：49 冒烟(含双端同表红旗探针) + 31 例引擎评测 + 检索分层回归 + 检索器 3 档双端一致 + 语义表守卫 22 + live 路径红线 43 项（含追问 live 分支与续问上限零外呼） + 双端契约 31:31 + FHIR 导出 45 项 + 隐私声明对账 59 项 + 配置契约对账 6 项 + 滥用护栏对账 33 项（契约需本机 Python）
npm run lint     # 静态检查：ESLint（frontend，--max-warnings=0）+ ruff（backend 与 scripts，规则集钉在仓根 ruff.toml）
npm run typecheck  # Python 类型门禁：mypy 严格档（check_untyped_defs）+ 阈值单一源，实测 23 文件 0 error、抑制项 0（零豁免有机器判据）
npm run sbom       # 生成前端 CycloneDX SBOM（钉版 @cyclonedx/cyclonedx-npm）；属发布期产物，不入库
npm run sbom:check # SBOM 对账门禁：声明依赖连同 lock 版本逐一在单 + 组件数/purl/工具版本核验
npm run build && npm run test:e2e  # 端到端浏览器回归（生产构建 + Functions 本地运行时，无 Key 走降级链路；首次需 npx playwright install --with-deps chromium）
npm run coverage:js   # c8 覆盖率 + 模块级地板棘轮（红线模块退化会被单独拦下）
npm run coverage:py   # coverage.py（语句+分支弧）汇总 5 套后端测试 → scripts/coverage_gate.py 按模块地板对账
npm run build  # Vite 生产构建

cd ../backend
python tests/smoke_engine.py
```

- CI 使用 Node 22 与 Python 3.12；Pull Request 只验证，`main` 分支通过全部门禁后才允许部署。
- `frontend/tests/fixtures/eval_cases.json` 为 31 例脱敏合成 CI 镜像，来源记录在 `_meta.provenance`。
- `frontend/tests/retrieval_eval.mjs` 对 20 条 silver 查询计算 Recall@1/3/5/10、MRR、nDCG@5/10；当前 BM25 基线为 Recall@5=0.95、MRR=0.95、nDCG@5=0.90727。
- 检索指标用于工程回归，不代表诊断准确率或真实临床有效性。
- `frontend/tests/contract_parity.mjs` 用同一 31 组黄金输入分别跑 Functions(JS) 与 FastAPI 镜像(Python)，逐字段比对 dx/workup/report，拦截双端静默漂移。
- **评测卡 / 安全卡**：[`docs/EVAL_CARD.md`](docs/EVAL_CARD.md) —— 能力边界、病种覆盖清单（55 条 · 19 域）、红旗与安全口径、指标日期一页可查。
- **架构与不变式**：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 六段链路图、三条产品红线的代码插入点、JS/Py 双端镜像对账矩阵、检索层实测参数、环境变量与门禁清单（数字均为磁盘实测）。
- **提交前快检**：[`.pre-commit-config.yaml`](.pre-commit-config.yaml) —— `pre-commit install` 后复用仓内既有守卫（版本真值 / 知识库零漂移 / 契约对账 / OpenAPI 漂移 / ESLint / ruff / 类型门禁 / 依赖锁定 / 文本控制字符 九钩子），秒级；全量二十件套仍由 CI 兜底。
- **安全边界与未保障项**：[`SECURITY.md`](SECURITY.md) —— 已实现的控制、明确未提供的保障（无认证/无审计/日志不留存）、漏洞报告渠道。
- **错误契约一览**：[`docs/ERRORS.md`](docs/ERRORS.md) —— 集成方只需这张表就能写对重试分支；由 `npm run test:api` 双向核对（表里的码集合 == openapi 声明、三处文案逐字等于 `limits` 常量），改码不改表或表领先实现都判红。
- **排障手册**：[`docs/PITFALLS.md`](docs/PITFALLS.md) —— 本仓真实踩过的坑按「可 grep 的报错症状 → 根因 → 处置 → 常驻判据」编排；条目必须点名兜住它的判据文件，由 `npm run test:docs` 核对（引用失效即判红）。
- **数据留存与隐私**：[`docs/PRIVACY.md`](docs/PRIVACY.md) —— 服务端零持久化、日志不落请求体、脱敏形态清单、唯一出站为 LLM 供应商（必然携带问诊文本）、明确未提供项；**声明与代码一致性由 `npm run test:privacy` 机器核对**（漂移即判红，非纯文档承诺）。
- **接手与贡献**：[`CONTRIBUTING.md`](CONTRIBUTING.md) —— 双端同步矩阵、提交前必跑门禁、知识库条目与评测集变更规范。

## 部署上线（已上线 ✅）

**线上地址：`https://doctor-ai-dx.pages.dev`**（Cloudflare Pages：前端 dist + functions/ 单次部署，对齐超市web模式）
- 后端 Functions 端点：`/api/cases` `/api/intake/ask` `/api/dx/:id` `/api/workup/:id` `/api/report/:id` `/api/health`
- 密钥：`DEEPSEEK_API_KEY` 走 **Pages secret**（`printf '<key>' | wrangler pages secret put DEEPSEEK_API_KEY --project-name=doctor-ai-dx`），不入库
- 部署命令（cwd = `frontend/`）：
  - `node node_modules/wrangler/bin/wrangler.js pages deploy dist --project-name=doctor-ai-dx --branch=main`
  - ⚠️ **必须带 `--branch=main`**：production 分支是 main，不带则只更新 preview 别名，裸域名不变
  - ⚠️ 代理故障报 `fetch failed` 时：清空 HTTPS_PROXY/HTTP_PROXY 并设 `NO_PROXY=*` 直连（api.cloudflare.com 可直连）
- 线上验证（本仓可跑，无需工作区）：`npm run eval:live`（31 例结构/引用/红旗 + P50/P95/max 时延，报告落 `.eval/`，不入库）
  随后 `npm run perf:gate` 核性能地板线（P95 ≤10s + 全过 + 报告新鲜度 ≤14 天；报告缺失判 UNKNOWN/exit 2 而不是放行）

**离线/本地演示**：`start-demo.ps1`（wrangler pages dev，静态+Functions 一体化，:8788，与线上零漂移）。

## 演示脚本与参赛素材

> 公开仓内已包含 `frontend/tests/` 的无密钥冒烟、31 例引擎评测和 20 例检索分层评测；下列 `../` 相对路径指向工作区中的完整 iCAN 材料与历史报告，随最终提交包提供。

- **iCAN 参赛材料（主）** —— 在参赛工作区的 iCAN大学生创新创业大赛 目录（不随本仓库发布）：应用方案 PDF（20页·官方九类）、来源台账、评审差距矩阵、31例评测、五步截图、视频分镜脚本；冻结交付副本在参赛工作区的 交付物/iCAN-参赛交付物 目录（不随本仓库发布）
- `archive/` —— 旧商业计划书与旧 3 分钟路演稿，**均为非 iCAN 提交材料**；保留仅作历史记录，不用于答辩或评审
- 项目叙事与验收标准 —— 仓内见 `docs/EVAL_CARD.md`（指标卡）与 `docs/ARCHITECTURE.md`（链路与红线插入点）；答辩用的叙事数据卡随参赛提交包提供，不在本仓库内

## 健康自检

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok","llm_mode":"live",...}  → 真实 LLM；"mock-fallback" → 演示数据
```

## API 契约（stateless，问诊历史随请求携带；Functions 与 FastAPI 完全一致）

| 方法 | 路径 | 请求 | 响应关键字段 |
|---|---|---|---|
| GET  | /api/cases | — | 病例列表（含脱敏合成标注） |
| POST | /api/intake/ask | {case_id, history[]} | reply/question, chips[], done, state{symptoms,missing_slots,red_flags,red_flag_details,rounds}, mode |
| POST | /api/dx/{id} | {case_id, history[]} | primary[]{name,prob,strength,reasons,evidence_ids,refs}, differential[], flags[], flag_details[]{name,severity,advice}, evidence[], trace, mode, fallback_reason, **fhir**（FHIR R4 light Bundle） |
| POST | /api/workup/{id} | {case_id, history[], dx?} | essential/suggested/optional[]{item,why,evidence_ids}, evidence_ids[], mode |
| POST | /api/report/{id} | {case_id, history[], dx?} | soap{S,O,A,P}, conclusion, disclaimer, evidence_ids[], mode |
| GET  | /api/health | — | {status, llm_mode: live\|mock-fallback, version} |

> `dx?` 为前端已生成的诊断结果，workup/report 复用它以消除冗余 LLM 串行调用；**红旗一律由后端规则重算，不信任前端**。
> 机器可读契约：[`docs/openapi.json`](docs/openapi.json)（OpenAPI 3.0.3，与实现对账由 `npm run test:api` 守卫；集成方/AI Agent 可直接消费）。
> **HIS 集成**：`/api/dx` 响应含 `data.fhir`——FHIR R4 light Bundle（Patient/Encounter/Condition/Observation/DiagnosticReport），双端逐字节一致、零时钟字段；`icd` 未映射的条目只出 `text` 不编造标准编码；本导出为**只读派生视图**，不改变红旗判定与引用白名单。详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9。
> 版本真值：`backend/app/version.py` == `functions/lib/version.js` == `package.json` == `docs/openapi.json` == 最新 tag，由 `npm run test:version` 五方对账强制（升版本三处同改 + `python scripts/gen_openapi.py` 同步契约版本）。
> 契约基线于 2026-09-24 完成 E2E 复核，两端（Functions / FastAPI）同步实现；公开仓门禁见 `frontend/tests/`，完整线上评测脚本已收进本仓（见下一节的 eval:live），原始报告不入库。

## 边界与已知局限（Limitations）

> 写这一节是因为对标实测发现：同类里做得可信的项目都会把边界写在自己首页
> （`urobot-tw` 明写「本專案目前沒有任何可對外宣稱的準確率」；`Medico` 明写「cases 与 rules 同作者
> ⇒ 测的是内部一致性而非临床有效性」；`MediGenius` 列 5 条 Limitations 并自陈验证阈值是
> unvalidated heuristics）。不写不等于不存在，只等于由别人来发现。

1. **红旗规则层是关键词＋否定前缀的确定性匹配，不是临床 NLP。** 13 条单线索规则＋4 条组合规则
   （`functions/lib/rules.js`），否定处理是启发式（命中点前 4 字查 `无/没有/未/否认…`），
   且刻意**不含**裸 `不`/`排除`/`不支持`——`不能排除心前区闷痛` 若被当阴性就是漏报。
   它既可能漏（同义表述未收进关键词表），也可能误（新关键词与既有否定式回答产生新组合）。
   常驻判据：否定守卫全表探针 `npm run test:negation`（232 条用例由规则表自动派生，双向拦截）。
2. **所有评测数字都是合成病例自洽度，不是真实世界准确率。** 病例、金标准标注、知识库三者同源自产，
   未经任何真实患者、外部临床评审或随访。`docs/EVAL_CARD.md` 每一行都标了口径；
   引用其中任何数字都必须带上这条限定。
3. **知识库只有 55 条，且扩容需要一个本机外部产物。** 语义邻接表由
   `scripts/build_semantic_neighbors.py` 用本地 `BAAI/bge-small-zh-v1.5` ONNX 权重蒸馏，
   而 `semantic_guard` 会以「条目数必须等于知识库条目数＋语料指纹一致」拦住任何未重建的增删
   （这是刻意设计：宁可拦住也不放行一张陈旧表）。**该权重与 `bge_onnx_engine.py` 不随本仓库发布**，
   所以在没有它们的环境里，扩库当前是**做不了**而不是不好做——复现证据：
   `python scripts/build_semantic_neighbors.py` → `FAIL: 未找到 bge_onnx_engine.py（不产出半成品表）` exit 1。
   缺病种清单由 `tests/fixtures/dx_gold.json` 的 `kb_gap` 字段机器给出（现 5 条）。
4. **无弃权/范围外第三态。** 域外输入仍会得到一份自信的诊断列表（实测：问宠物会返回 ACS 待排除）。
   已测得候选阈值与安全性（`npm run probe:ood`：域外 top1 上限 38.604 vs 危急域内下限 57.374），
   但落机制需同时改双端契约、OpenAPI、界面与 E2E 断言面，尚未做。
5. **零持久化、零认证、单用户。** 这是**刻意的**（见 `docs/PRIVACY.md` §7：引入持久化须先改声明再改断言），
   代价是做不到同类已有的复核工作流与审计留痕，因此「医生终审」目前是界面常驻文案而非可验证流程。
6. **维护者 2 人**，bus factor≈1；无 CI 分钟额度之外的自建基础设施。
7. **未取得任何医疗器械注册、HIPAA/GDPR 或等保合规认定**；本项目定位是教学/竞赛原型，
   不得用于临床部署（授权条款见 `LICENSE`）。

## 安全定位（评审叙事）

AI 辅助参考 · 医生终审 · 危险信号规则层强制拦截 · RAG 引用溯源 · 演示环境仅脱敏模拟病例。

## 竞赛用途与授权

- 本仓库公开可查阅，用于 **2026年iCAN大学生创新创业大赛 AI 应用创新挑战赛（软件赛道·高校组）** 参赛评审与学术交流；授权声明见 `LICENSE`（默认保留全部权利）。
- 线上演示：https://doctor-ai-dx.pages.dev （评委浏览器可直接访问）
- 评测可复现：`frontend/tests/`（31 例引擎回归 + 20 例检索分层评测，零密钥离线可跑）；线上 live 评测的原始报告随参赛提交包交付，不在本仓库内（避免读者在本仓里找一个不存在的目录）。
- 模型依赖：DeepSeek（OpenAI 兼容 API，Key 自备）；无 Key 或超时 8s 自动进入**规则引擎降级模式**并在界面明确标注，功能完整可演示。
- 演示病例均为脱敏合成数据，不代表真实患者或真实调研样本。

## 阶段状态

阶段00 行业研究 ✅  阶段01 原型 ✅  阶段02 MVP 初版 ✅（本目录）｜ 阶段03 素材打磨 / 阶段04 网报
