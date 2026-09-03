# 医 · AI 医生辅助诊断系统 — MVP v0.2

面向基层医生的 AI 辅助诊断网页端程序。**LLM + RAG 混合引擎 + 危险信号规则层**三重保障。

## 架构

```
frontend/   React 19 + Vite 6（五视图 SPA：选病例 → 问诊 → 诊断 → 检查 → 报告）
backend/    FastAPI（问诊编排 / 规则层 / RAG 检索 / LLM 可插拔）
```

- `backend/app/rules.py`    危险信号规则引擎（不依赖 LLM，可解释可测试）
- `backend/app/knowledge.py`+`rag.py`  医学知识库 RAG 轻量检索（Jaccard 相关度，可换向量库）
- `backend/app/services/llm.py`  DeepSeek（OpenAI 兼容）接入；**未配置 Key 自动降级内置演示数据**

## 启动

```bash
# 0) 一键演示（推荐，现场零配置）
powershell -ExecutionPolicy Bypass -File start-demo.ps1
# 自动：起后端(8000) + 前端静态托管(5173) + 打开浏览器

# 1) 后端（默认 8000）
cd backend
cp .env.example .env        # 有 DeepSeek Key 则填入；无 Key 走 mock 降级
python -m pip install -r requirements.txt
python run.py               # 或 python -m uvicorn app.main:app --port 8000

# 2) 前端（默认 5173，/api 已代理到 8000）
cd frontend
npm install
npm run dev                 # 打开 http://localhost:5173
```

> 本机构键提示：`~/.npmrc` 配了 `proxy=http://127.0.0.1:7897`——Clash 开启时 npm 直接可用；
> 若代理未开，npm 安装会卡在 ECONNREFUSED，用 `npm install --proxy="" --https-proxy="" --noproxy="*"` 覆盖（或临时改 .npmrc）。

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

## API 契约（shape 即前端 api.js 依赖）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | /api/cases | 病例列表 |
| POST | /api/intake/ask | {case_id, answer, history} → 下一问/完成 |
| POST | /api/dx/{id} | 问诊汇总 → 诊断结论（红旗+鉴别+引用） |
| GET  | /api/workup/{id} | 检查建议（必查/建议/可选） |
| GET  | /api/report/{id}  | SOAP 病历报告 |

## 安全定位（评审叙事）

AI 辅助参考 · 医生终审 · 危险信号规则层强制拦截 · RAG 引用溯源 · 演示环境仅脱敏模拟病例。

## 阶段状态

阶段00 行业研究 ✅  阶段01 原型 ✅  阶段02 MVP 初版 ✅（本目录）｜ 阶段03 素材打磨 / 阶段04 网报