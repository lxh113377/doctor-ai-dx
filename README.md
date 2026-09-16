# 医 · 基层AI辅助诊断系统 — v0.3

面向基层医生的 AI 辅助诊断网页端程序。**临床状态抽取 → BM25证据检索 → LLM结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级**，三重保障控制幻觉。

## 架构（双后端同源）

```
frontend/   React 19 + Vite 6（五视图 SPA：选病例 → 问诊 → 诊断 → 检查 → 报告）
  functions/  Cloudflare Pages Functions —— 线上权威后端（与前端一次部署）
backend/    FastAPI —— 同一链路的 Python 镜像（可选本地运行，满足 FastAPI 栈要求）
```

- **线上 = Functions**：`https://doctor-ai-dx.pages.dev`，前端 dist + functions/ 单次部署。
- **两端镜像**：`backend/app/{knowledge,rules,rag}.py` 与 `functions/lib/{knowledge,rules,rag}.js` 逻辑一致；`knowledge.py` 由 `../iCAN大学生创新创业大赛/03-评测/export_kb.mjs` 从 `knowledge.js` 自动生成，保证知识库数据零漂移。
- `rules` 危险信号规则引擎（不依赖 LLM，可解释可测试，命中即强制转诊，**优先级高于模型不可覆盖**）
- `rag` BM25 + 医学术语同义词扩展检索，输出带 `id/source/year/url/scope` 的证据
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

## 部署上线（已上线 ✅）

**线上地址：`https://doctor-ai-dx.pages.dev`**（Cloudflare Pages：前端 dist + functions/ 单次部署，对齐超市web模式）
- 后端 Functions 端点：`/api/cases` `/api/intake/ask` `/api/dx/:id` `/api/workup/:id` `/api/report/:id` `/api/health`
- 密钥：`DEEPSEEK_API_KEY` 走 **Pages secret**（`printf '<key>' | wrangler pages secret put DEEPSEEK_API_KEY --project-name=doctor-ai-dx`），不入库
- 部署命令（cwd = `frontend/`）：
  - `node node_modules/wrangler/bin/wrangler.js pages deploy dist --project-name=doctor-ai-dx --commit-dirty=true`
  - ⚠️ wrangler4 需先 `pages project create doctor-ai-dx`（不会自动创建）
- 线上验证：`python ../work/e2e_online.py`（E2E 5/5 ALL PASS，2026-09-04）

**离线/本地演示**：`start-demo.ps1`（后端 8000 + 前端 5173）。

## 演示脚本与参赛素材

- `pitch-script-3min.md` —— 3 分钟路演逐字稿（胸痛红旗全流程）
- `business-plan-v0.1.md` —— 商业计划书初稿（九章，待补项目名/组别/团队/财务）
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
| POST | /api/intake/ask | {case_id, history[]} | reply/question, chips[], done, state{symptoms,missing_slots,red_flags,rounds}, mode |
| POST | /api/dx/{id} | {case_id, history[]} | primary[]{name,prob,strength,reasons,evidence_ids,refs}, differential[], flags[], evidence[], trace, mode, fallback_reason |
| POST | /api/workup/{id} | {case_id, history[], dx?} | essential/suggested/optional[]{item,why,evidence_ids}, evidence_ids[], mode |
| POST | /api/report/{id} | {case_id, history[], dx?} | soap{S,O,A,P}, conclusion, disclaimer, evidence_ids[], mode |
| GET  | /api/health | — | {status, llm_mode: live\|mock-fallback} |

> `dx?` 为前端已生成的诊断结果，workup/report 复用它以消除冗余 LLM 串行调用；**红旗一律由后端规则重算，不信任前端**。
> 契约封板于 2026-09-16，两端（Functions / FastAPI）同步实现，冒烟与评测脚本见 `../iCAN大学生创新创业大赛/03-评测/`。

## 安全定位（评审叙事）

AI 辅助参考 · 医生终审 · 危险信号规则层强制拦截 · RAG 引用溯源 · 演示环境仅脱敏模拟病例。

## 竞赛用途与授权

- 本仓库公开可查阅，用于 **2026年iCAN大学生创新创业大赛 AI 应用创新挑战赛（软件赛道·高校组）** 参赛评审与学术交流；授权声明见 `LICENSE`（默认保留全部权利）。
- 线上演示：https://doctor-ai-dx.pages.dev （评委浏览器可直接访问）
- 评测可复现：`../iCAN大学生创新创业大赛/03-评测/`（25 例合成病例 + 离线/线上评测脚本与原始输出）
- 模型依赖：DeepSeek（OpenAI 兼容 API，Key 自备）；无 Key 或超时 8s 自动进入**规则引擎降级模式**并在界面明确标注，功能完整可演示。
- 演示病例均为脱敏合成数据，不代表真实患者或真实调研样本。

## 阶段状态

阶段00 行业研究 ✅  阶段01 原型 ✅  阶段02 MVP 初版 ✅（本目录）｜ 阶段03 素材打磨 / 阶段04 网报