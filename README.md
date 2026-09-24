# 医 · 基层AI辅助诊断系统 — v0.3

面向基层医生的 AI 辅助诊断网页端程序。**临床状态抽取 → BM25证据检索 → LLM结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级**，三重保障控制幻觉。

## 架构（双后端同源）

```
frontend/   React 19 + Vite 6（五视图 SPA：选病例 → 问诊 → 诊断 → 检查 → 报告）
  functions/  Cloudflare Pages Functions —— 线上权威后端（与前端一次部署）
backend/    FastAPI —— 同一链路的 Python 镜像（可选本地运行，满足 FastAPI 栈要求）
```

- **线上 = Functions**：`https://doctor-ai-dx.pages.dev`，前端 dist + functions/ 单次部署。
- **两端镜像**：`backend/app/{knowledge,rules,rag,retriever}.py` 与 `functions/lib/{knowledge,rules,rag,retriever}.js` 逻辑一致；`knowledge.py` 由 `../iCAN大学生创新创业大赛/03-评测/export_kb.mjs` 从 `knowledge.js` 自动生成，保证知识库数据零漂移。
- `rules` 危险信号规则引擎（不依赖 LLM，可解释可测试，命中即强制转诊，**优先级高于模型不可覆盖**）
- `rag` BM25 + 医学术语同义词扩展检索，输出带 `id/source/year/url/scope` 的证据
- `retriever` 检索器适配边界；当前默认且唯一启用原 BM25，后续可增加混合检索，BM25 始终保留为安全回退
- `engine` 确定性校验：非法 `evidence_id` 直接拒绝；无 Key / 超时 / JSON 非法 → 明确标注 `mode=rule-fallback` 降级
- `llm` DeepSeek（OpenAI 兼容）；单次硬超时 8s

## 启动（本地演示，二选一）

```bash
# 方式A（推荐·与线上零漂移）：wrangler 同时托管 dist + functions
cd frontend && npm install && npm run build
node node_modules/wrangler/bin/wrangler.js pages dev dist --port 8788 --local
# 打开 http://127.0.0.1:8788 ；或直接 powershell -File start-demo.ps1

# 方式B（FastAPI 栈）：起 Python 后端 + Vite 前端
cd backend && cp .env.example .env   # 有 DeepSeek Key 则填入；无 Key 走 rule-fallback
python -m pip install -r requirements.txt && python run.py   # :8000
cd ../frontend && npm install && npm run dev                 # :5173，/api 代理到 8000
```

> 无 DeepSeek Key 时两端均自动进入**规则引擎降级模式**并在界面明确标注，功能完整可演示（AC-OBS-07）。

## 自动化验证（无需 LLM Key）

```bash
cd frontend
npm test       # 22 项冒烟 + 31 例引擎评测 + 检索分层回归 + 31 例双端契约比对（契约需本机 Python）
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
- **安全边界与未保障项**：[`SECURITY.md`](SECURITY.md) —— 已实现的控制、明确未提供的保障（无认证/无审计/日志不留存）、漏洞报告渠道。
- **接手与贡献**：[`CONTRIBUTING.md`](CONTRIBUTING.md) —— 双端同步矩阵、提交前必跑门禁、知识库条目与评测集变更规范。

## 部署上线（已上线 ✅）

**线上地址：`https://doctor-ai-dx.pages.dev`**（Cloudflare Pages：前端 dist + functions/ 单次部署，对齐超市web模式）
- 后端 Functions 端点：`/api/cases` `/api/intake/ask` `/api/dx/:id` `/api/workup/:id` `/api/report/:id` `/api/health`
- 密钥：`DEEPSEEK_API_KEY` 走 **Pages secret**（`printf '<key>' | wrangler pages secret put DEEPSEEK_API_KEY --project-name=doctor-ai-dx`），不入库
- 部署命令（cwd = `frontend/`）：
  - `node node_modules/wrangler/bin/wrangler.js pages deploy dist --project-name=doctor-ai-dx --branch=main`
  - ⚠️ **必须带 `--branch=main`**：production 分支是 main，不带则只更新 preview 别名，裸域名不变
  - ⚠️ 代理故障报 `fetch failed` 时：清空 HTTPS_PROXY/HTTP_PROXY 并设 `NO_PROXY=*` 直连（api.cloudflare.com 可直连）
- 线上验证：`node ../iCAN大学生创新创业大赛/03-评测/live_eval.mjs`（31例结构/引用/红旗 + P95 时延，2026-09-16 全绿）

**离线/本地演示**：`start-demo.ps1`（wrangler pages dev，静态+Functions 一体化，:8788，与线上零漂移）。

## 演示脚本与参赛素材

> 公开仓内已包含 `frontend/tests/` 的无密钥冒烟、31 例引擎评测和 20 例检索分层评测；下列 `../` 相对路径指向工作区中的完整 iCAN 材料与历史报告，随最终提交包提供。

- **iCAN 参赛材料（主）** —— 见 `../iCAN大学生创新创业大赛/`：应用方案 PDF（20页·官方九类）、来源台账、评审差距矩阵、31例评测、五步截图、视频分镜脚本；冻结交付副本在 `../交付物/iCAN-参赛交付物/`
- `archive/` —— 旧商业计划书与旧 3 分钟路演稿，**均为非 iCAN 提交材料**；保留仅作历史记录，不用于答辩或评审
- 项目叙事与答辩数据卡 —— 见 `../memory/08-ac-obs.md`

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
| POST | /api/dx/{id} | {case_id, history[]} | primary[]{name,prob,strength,reasons,evidence_ids,refs}, differential[], flags[], flag_details[]{name,severity,advice}, evidence[], trace, mode, fallback_reason |
| POST | /api/workup/{id} | {case_id, history[], dx?} | essential/suggested/optional[]{item,why,evidence_ids}, evidence_ids[], mode |
| POST | /api/report/{id} | {case_id, history[], dx?} | soap{S,O,A,P}, conclusion, disclaimer, evidence_ids[], mode |
| GET  | /api/health | — | {status, llm_mode: live\|mock-fallback} |

> `dx?` 为前端已生成的诊断结果，workup/report 复用它以消除冗余 LLM 串行调用；**红旗一律由后端规则重算，不信任前端**。
> 契约基线于 2026-09-24 完成 E2E 复核，两端（Functions / FastAPI）同步实现；公开仓门禁见 `frontend/tests/`，完整线上评测见工作区 `../iCAN大学生创新创业大赛/03-评测/`。

## 安全定位（评审叙事）

AI 辅助参考 · 医生终审 · 危险信号规则层强制拦截 · RAG 引用溯源 · 演示环境仅脱敏模拟病例。

## 竞赛用途与授权

- 本仓库公开可查阅，用于 **2026年iCAN大学生创新创业大赛 AI 应用创新挑战赛（软件赛道·高校组）** 参赛评审与学术交流；授权声明见 `LICENSE`（默认保留全部权利）。
- 线上演示：https://doctor-ai-dx.pages.dev （评委浏览器可直接访问）
- 评测可复现：`frontend/tests/`（31 例引擎回归 + 20 例检索分层评测）；完整线上评测与原始报告见工作区 `../iCAN大学生创新创业大赛/03-评测/`
- 模型依赖：DeepSeek（OpenAI 兼容 API，Key 自备）；无 Key 或超时 8s 自动进入**规则引擎降级模式**并在界面明确标注，功能完整可演示。
- 演示病例均为脱敏合成数据，不代表真实患者或真实调研样本。

## 阶段状态

阶段00 行业研究 ✅  阶段01 原型 ✅  阶段02 MVP 初版 ✅（本目录）｜ 阶段03 素材打磨 / 阶段04 网报
