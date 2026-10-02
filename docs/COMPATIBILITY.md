# 兼容性矩阵（COMPATIBILITY）
> 定位：**单一可引用的兼容性入口**。第八十九轮对标发现，此前版本/视口/部署形态信息散在 `playwright.config.mjs` 注释、`mypy.ini`、`README.md` 段与 `docker-compose.yml` 注释里，集成方要拼四个文件才能回答「能不能装在我这儿」。
> 纪律：本文件只写**在盘可复算**的事实，每行给复算命令。文档写了 ≠ 磁盘有 ⇒ 由 `frontend/tests/docs_surface_guard.mjs` 兜住。
> 口径：行数与件数取 `Get-Content | Measure-Object -Line`（不含空行）；提交数取 `git rev-list --count`（**不用 `git log | Measure-Object`，本机该形态返回假值 1**）。

## 1. 运行时版本

| 组件 | 要求 | 依据 | 复算命令 |
|---|---|---|---|
| Node.js | **22+** | CI setup-node、CONTRIBUTING 要求、前端构建链 | `Select-String -Path .github/workflows/ci.yml -Pattern 'node-version'` |
| Python | **3.12+** | `mypy.ini python_version=3.12`、`ruff.toml target-version="py312"`、基础镜像 `python:3.12-slim` | `Select-String -Path mypy.ini,ruff.toml,Dockerfile -Pattern '3.12'` |
| Pages Functions | `compatibility_date = 2024-09-23` | `frontend/wrangler.toml` | `Select-String -Path frontend/wrangler.toml -Pattern 'compatibility_date'` |
| 浏览器（E2E） | **只装 chromium** | AC 口径是双视口，**不是跨浏览器矩阵** | `Select-String -Path frontend/playwright.config.mjs -Pattern 'chromium'` |

> ⚠️ **不兼容声明（写明原因）**：本项目**未做** Safari / Firefox / Edge 的 E2E 覆盖。原因是验收口径定义为「桌面 1440 + 移动 390 双视口无横向溢出、无控制台异常」，不是浏览器兼容矩阵。**集成前若要求多浏览器，须自行补测**——这是已知缺口，不是「支持」。

## 2. 视口

| 视口 | 尺寸 | 覆盖方式 | 复算命令 |
|---|---|---|---|
| 桌面 | 1440×900 | Playwright 项目循环，与移动视口跑同一套 E2E | `Select-String -Path frontend/e2e/app.spec.mjs -Pattern '1440|390'` |
| 移动 | 390×844 | 同上 | 同上 |

E2E 跑的是**生产构建 + `wrangler pages dev`**（不用 vite dev server，因其代理路径线上不存在）——因此视口结论对线上形态有效。复算：`Select-String -Path frontend/e2e/app.spec.mjs -Pattern 'wrangler'`。

## 3. 部署形态与资源需求

| 形态 | 入口 | 端口 | 与线上漂移 | 复算命令 |
|---|---|---|---|---|
| A 演示（推荐） | `bash start-demo.sh` / `powershell -File start-demo.ps1` | 8788 | **零漂移**（同一 `wrangler pages dev`） | `Get-Content start-demo.sh` |
| B 本地双端 | FastAPI + Vite | 8000 + 5173 | 有（Vite 代理 ≠ 线上） | `Select-String -Path frontend/vite.config.js -Pattern 'proxy'` |
| C 容器 | `docker run ghcr.io/lxh113377/doctor-ai-dx:latest` 或 `docker compose up -d` | 8000 | 有（**只编排镜像面**） | `Get-Content docker-compose.yml` |

- **资源需求**：无数据库、无向量服务、无 Redis/ES。权威面＝静态前端 + Pages Functions；镜像面＝单进程 FastAPI（compose 内另起一个 selftest 服务）。
- **生产权威面不是可自托管容器**：`docker-compose.yml` 只编排 FastAPI 镜像面；Pages Functions 面（`frontend/functions/`）没有容器形态。README 与本文件口径一致，属**如实声明**而非缺口。

## 4. 集成形态与延迟档位

| 集成方式 | 可达性 | 依据 |
|---|---|---|
| 页面内异步调用（`/api/dx/:id` 等） | ✅ 推荐 | `frontend/src/views/Dx.jsx` |
| FHIR R4 light 只读派生视图 | ✅ 可用（挂在 `/api/dx` 响应的 `data.fhir`） | `frontend/functions/lib/fhir.js` |
| CDS Hooks 2.0（发现 + 调用） | ✅ 可用（2 个 service，hook=patient-view） | `data/cds_services.json`、`frontend/functions/cds-services/` |
| **同步阻塞调用（医生操作关键路径内）** | ❌ **不可达** | `docs/INTEGRATION.md`：行业惯例秒级、CDS Hooks 建议 500ms 量级；本项目 LLM 单次链路 p95 量级秒级，**设计用法是「页面加载后异步出提示」** |

> ⚠️ **这是集成方最容易踩的一条**：不要把 `/api/dx` 当同步接口用在关键路径上。

## 5. 降级与时限

| 项 | 值 | 依据 | 复算命令 |
|---|---|---|---|
| LLM 单次硬超时 | 8000 ms（`AbortSignal.timeout`） | `frontend/functions/lib/engine.js` | `Select-String -Path frontend/functions/lib/engine.js -Pattern 'AbortSignal.timeout'` |
| LLM 重试 | **0 次**（失败一律降级并带 `fallback_cause`） | 同上；`docs/KNOWLEDGE_MAINTENANCE.md` | `Select-String -Path docs/KNOWLEDGE_MAINTENANCE.md -Pattern '重试'` |
| 降级原因闭集 | 7 类（`no_key`/`timeout`/`net_error`/`empty`/`bad_json`/`schema` 等） | `engine.js` 的 `LLM_FALLBACK_CAUSES` | `Select-String -Path frontend/functions/lib/engine.js -Pattern 'LLM_FALLBACK_CAUSES'` |
| 入站护栏 | body ≤ 64 KiB；history ≤ 64 条；单条文本 ≤ 2000 字 | `frontend/functions/lib/limits.js` + `frontend/tests/fixtures/request_limits.json` | 阈值单一源＝`frontend/tests/fixtures/request_limits.json` |
| 无 Key 行为 | 两端均 `mode=rule-fallback`，仍可完成诊断/检查/报告 | `docs/PITFALLS.md` | `Select-String -Path docs/PITFALLS.md -Pattern 'rule-fallback'` |
| 慢请求观测阈值 | `SLOW_MS = 8000`（超阈只补 warn 日志，不改响应） | `frontend/functions/lib/observe.js` | `Select-String -Path frontend/functions/lib/observe.js -Pattern 'SLOW_MS'` |

## 6. 已知不兼容项与限制（对外声明面）

> 本节是**给集成方的单页清单**：能做什么、明确不做什么、为什么。定位为「辅助参考 · 医生终审」，不替代执业医生。

| 项 | 状态 | 原因 / 出处 |
|---|---|---|
| 跨浏览器（Safari / Firefox / Edge） | ❌ 未覆盖 | 验收口径只定义双视口，见 §1 |
| 同步阻塞集成 | ❌ 不可达 | 见 §4 |
| 真实患者数据接入 | ❌ 不支持 | 演示仅用脱敏合成病例（项目红线） |
| 医疗器械注册 / HIPAA / GDPR / 等保认定 | ❌ 未取得 | 定位为教学竞赛原型与研究原型 |
| 多机构 / 多租户隔离 | ❌ 未实现 | 零持久化、单用户无状态 |
| 认证 / RBAC / 审计日志 | ❌ 未实现 | 同上；试点前的硬门槛，登记 P2 |
| FHIR 写权限 / CDS Hooks 建议写回 | ❌ 刻意不发 | 只读派生视图；只发规范内字段，无 uuid/links/suggestions/selectionBehavior |
| 跨请求会话状态 | ❌ 无状态 | 每次请求独立；`wrangler.toml` 注明知识库内嵌、无持久化 |
| 语义/向量检索档位 | ⚠️ 默认关闭 | `hybrid`/`semantic` 档 opt-in；语义邻接表需仓外 ONNX 权重，缺失时脚本 fail-closed 不产出（台账 #100） |
| 同步 LLM 重试 / 熔断 / 配额 | ❌ 未实现 | 单次调用 + 8s 超时 + 失败降级，见 §5 |

## 7. 版本与读数的时效性

| 面 | 权威来源 | 时效口径 |
|---|---|---|
| 线上性能读数（P95 等） | 本仓不落该报告（`.eval/` 被 gitignore）；权威副本在**工作区**的评测目录下，`scripts/live_eval.mjs` 现场生成 | **≤14 天**；超期由 `scripts/live_freshness_guard.py` 判红（状态含 NOT_DUE / UNVERIFIED / EMPTY） |
| 覆盖率 / 体积地板 | 判据现算 | 文档不抄百分比（`coverage_floor_guard.mjs` / `bundle_size_guard.mjs`） |
| 提交数 / tag 数 | `git rev-list --count` / `git --no-pager tag` | 现算；**禁用 `git log … | Measure-Object`**（本机返回假值 1） |

## 8. 复算本文件自身的命令

```powershell
cd c:/Users/37533/Desktop/workspace/项目/医/doctor-ai-dx-mvp
Select-String -Path mypy.ini,ruff.toml,Dockerfile -Pattern '3.12'
Select-String -Path frontend/wrangler.toml -Pattern 'compatibility_date'
Select-String -Path frontend/playwright.config.mjs -Pattern 'chromium'
Select-String -Path frontend/functions/lib/engine.js -Pattern 'AbortSignal.timeout'
Select-String -Path frontend/functions/lib/observe.js -Pattern 'SLOW_MS'
python scripts/docs_path_guard.py
python frontend/tests/docs_surface_guard.mjs
```

> 相关文档：`docs/INTEGRATION.md`（三档位与失败语义）、`docs/PITFALLS.md`（症状→根因→处置）、`docs/DEPLOY_RUNBOOK.md`（部署与回滚操作序列）、`docs/PRIVACY.md`（数据留存与换供应商含义）。
> 禁止事项：本文档只写**实测可复算**的结论；任何数字改动必须同步给出复算命令，否则 `docs_surface_guard.mjs` 判红。
