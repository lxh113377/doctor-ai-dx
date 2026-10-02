# 部署与故障处置 Runbook
> 定位：**部署与故障处置的唯一操作入口**。此前这些内容散在 `README.md` 的部署段与 `docs/PITFALLS.md` 的排障手册里——前者是「怎么发上去」，后者是「为什么坏了」，但**没有一份含「回滚到上一版本怎么做」的操作序列**。
> 纪律：本文件只写**在盘可跑**的命令。命令写错会在第一次执行时浪费真实时间，故每节标注复算命令；文档路径不存在由 `scripts/docs_path_guard.py` 与 `frontend/tests/docs_surface_guard.mjs` 兜住。
> 边界：本项目**生产权威面是 Cloudflare Pages + Functions**（`frontend/functions/`），没有容器形态；`docker-compose.yml` 只编排 FastAPI 镜像面。两者都写，别混。

## 0. 三十秒版（先看这张）

| 你要做的事 | 走哪节 |
|---|---|
| 本地跑起来看效果 | §1 形态 A |
| 发一次线上（预览/生产） | §2 |
| 线上刚发完，验一下 | §3 |
| **线上出问题了，先止损** | §4 回滚 |
| 报了个错要定位根因 | §5 故障分诊 |
| 想知道自己机器能不能装 | `docs/COMPATIBILITY.md` |

## 1. 前置条件与本地形态

| 项 | 要求 | 复算命令 |
|---|---|---|
| Node.js | 22+ | `node -v` |
| Python（只用镜像面/脚本时） | 3.12+ | `python -V` |
| 依赖安装 | 前端 | `cd frontend; npm install` |
| 密钥（可选） | `DEEPSEEK_API_KEY` 走 secret，**禁写 `[vars]`** | `Select-String -Path frontend/wrangler.toml -Pattern 'vars'` |

形态 A（**推荐，与线上零漂移**）：`bash start-demo.sh` 或 `powershell -File start-demo.ps1` → http://localhost:8788
形态 B：FastAPI :8000 + Vite :5173（有代理漂移）
形态 C：容器 `docker compose up -d` → :8000（**只编排镜像面**）

## 2. 部署（Cloudflare Pages + Functions）

**顺序（不可跳步）**：

```powershell
# 1) 构建（生产构建，E2E 也跑这一份）
cd frontend; npm install; npm run build

# 2) 本地冒烟：用与线上同一形态起服（不用 vite dev server）
npx wrangler pages dev dist --port 8788

# 3) 判据：测试全绿再发
npm test
python ..\scripts\verify.py

# 4) 发（--branch=main 是硬要求，漏了会发到别的分支）
node node_modules/wrangler/bin/wrangler.js pages deploy dist --project-name=doctor-ai-dx --branch=main
```

| 步骤 | 复算命令 |
|---|---|
| 构建产物存在 | `Get-ChildItem frontend/dist -Recurse -File` |
| wrangler 项目配置 | `Get-Content frontend/wrangler.toml` |
| 线上地址 | https://doctor-ai-dx.pages.dev |

**密钥**：`wrangler pages secret put DEEPSEEK_API_KEY`（**不要**写进 `[vars]` 或提交进仓）。复算：`Select-String -Path frontend/wrangler.toml -Pattern 'secret'`

**发版链上的门禁**：`release.yml` 第 4 步会跑 `scripts/release_ci_gate.py`（四态：GREEN/RED/BLOCKED/UNKNOWN）——**CI 绿不是发版的充分条件**，门禁形态与读数见该脚本 docstring。

## 3. 发完后的验证（三层，逐层收紧）

| 层 | 做什么 | 通过标准 | 命令 |
|---|---|---|---|
| L1 存活 | 打健康端点 | 返回 UP | 复算：`Select-String -Path backend/app/main.py -Pattern 'health'` |
| L2 结构 | 离线评测 | 31/31 结构 + 31/31 引用 | `node ..\iCAN大学生创新创业大赛\03-评测\run_eval.mjs` |
| L3 线上 | 线上评测 + 报告新鲜度 | p95 ≤ 10s、红旗召回全过、mode 全 live | `node scripts/live_eval.mjs` |

> ⚠️ **L3 会因通路间歇而失败**（同面 16:13 得 0/31、19:06 得 31/31）。**不要把单次 0/31 读成「线上死了」**——先按 §5 的「通路间歇」分诊重跑一次。
> 报告不入库（`.eval/` 与 `docs/sbom/` 都在 `.gitignore`），所以**读数只在当次产物里**；引用性能数字必须同时给出落地命令与新鲜度。

## 4. 回滚（先止损，再定位）

**触发条件（任一即回滚，不在生产上debug）**：线上 5xx 持续 > 5 分钟；红旗规则层行为异常（安全相关）；结构/引用判据在 L2 红；知识库导出件与权威源不一致。

**回滚到上一版本**：

> ⚠️ **先纠正一个想当然的写法**：Wrangler CLI **没有** `pages deployment rollback` 子命令。实测命令集只有 `list` / `create`（别名 `deploy`）/ `tail` / `delete`。复算：
> ```powershell
> cd frontend; node node_modules/wrangler/bin/wrangler.js pages deployment --help
> ```
> 所以回滚有两条真实路径，**优先用 A（可追溯、可复算）**：

```powershell
# 路径 A（推荐）：回到上一个 tag 的代码再发一次
cd frontend
git --no-pager tag                       # 找上一个可用 tag
git checkout <上一个 tag>               # 或 git revert <出问题的那次提交>
npm install; npm run build
node node_modules/wrangler/bin/wrangler.js pages deploy dist --project-name=doctor-ai-dx --branch=main
git checkout main                        # 回到主线，避免本地停在 detached HEAD
```

```powershell
# 路径 B：控制台 Rollback（无本地代码改动时用；CLI 无对应子命令）
# Cloudflare Dashboard → Pages → doctor-ai-dx → Production → 选历史 deployment → Rollback to this deployment
# 查历史 deployment id：
cd frontend; node node_modules/wrangler/bin/wrangler.js pages deployment list --project-name=doctor-ai-dx
```

**回滚后必做**：

| 步 | 做什么 | 通过标准 |
|---|---|---|
| 1 | 重跑 L1 存活 | UP |
| 2 | 重跑 L2 离线评测 | 31/31 |
| 3 | 在 commit message 里写明「回滚自 X 至 Y，原因 Z」 | 事后可追溯 |

**回滚不解决的三件事**（必须另立单）：知识库内容错误（改 `data/*.json` 后重新 export 再发）、密钥泄漏（轮换 `DEEPSEEK_API_KEY`，**一次轮换完成并实测生效即收口**）、需要改代码的缺陷（走 §6 常规发版）。

## 5. 故障分诊（症状 → 最可能根因 → 处置）

| 症状 | 先分诊这一步 | 最可能根因 | 处置 | 常驻判据 |
|---|---|---|---|---|
| 线上诊断一直 `rule-fallback` | 看响应的 `fallback_cause` 闭集 | 密钥未注入 / 模型端点不通 | `wrangler pages secret list` 确认 secret 在；重跑 L3 | `scripts/perf_gate.mjs` 第四维「降级原因可归因」 |
| L3 突然 0/31 | **同面重跑一次** | 通路间歇（已知形态） | 重跑；仍红再查 `fallback_cause` 分布 | `scripts/live_freshness_guard.py` 五态 |
| L3 报报告过期 | 看报告 mtime | 距上次跑超过 14 天 | 重跑 `scripts/live_eval.mjs` | `live_freshness_guard.py`（NOT_DUE 不算红） |
| 红旗该报不报 | 查权威源表 | 红旗规则被改坏 | `npm run redflags:export` 重生成，再跑导出件对账 | `frontend/tests/red_flag_table_guard.mjs` |
| 改知识库不生效 | 查生成件 | 忘了跑 export（生成物禁手改） | `npm run kb:export` | `frontend/tests/kb_guard.mjs` |
| 构建产物为空 | `Get-ChildItem frontend/dist` | 构建没跑就发 | 先 `npm run build` | `bundle_size_guard.mjs`（`dist/assets` 缺失即 exit 1） |
| 部署报连不上 | 换通路重试 | 网络/代理 TLS 中断（实测出现过 `TLS connect error`） | **一条路失败先换另一条再下结论**，两条都试过才写「通路不通」 | — |
| 提交被钩子拦红 | 看红因归属 | 判据在审别人的在途改动 / 我方真违规 | 属前者→修判据取数面；属后者→改内容 | 提交链上的 18 钩 |

> 复算：`docs/PITFALLS.md` 是「症状→根因→处置」的扩展手册（347 行），本节只放**线上止损路径**。

## 6. 常规发版检查单

- [ ] `npm test` 全绿（29 个 script；`frontend/tests/` 实有 38 个 .mjs，另有 probe 件刻意不进链）
- [ ] `python scripts/verify.py` 全绿
- [ ] 版本号**五方一致**：`frontend/functions/lib/version.js`、`backend/app/version.py`、`frontend/package.json`、`docs/openapi.json`、最新 tag（`frontend/tests/version_guard.mjs` 强制）
- [ ] `CHANGELOG.md` 加版本小节（格式由 `round_wording_guard.py` 约束）
- [ ] 双端契约一致：`node frontend/tests/contract_parity.mjs`
- [ ] 需要发镜像时才跑 SBOM：`npm run sbom`（**注意 cwd**：输出路径相对 `frontend/`，落在仓根 `docs/sbom/`；该目录被 `.gitignore` 排除，**干净检出看不到，必须在文档里说明须本地生成**）

## 6.5 会话数据 TTL 清理（r91 S10 起）

- 会话表 `conversations.expires_at` 默认保留 180 天（单一源 `frontend/functions/lib/chat_store.js::RETENTION_DAYS`），
  到期级联删消息/意图事件/工单/反馈（D1 外键 `ON DELETE CASCADE`）。
- 预览（默认 dry-run，只打印 SQL 与精确 wrangler 命令，不动数据）：
  `node scripts/d1_cleanup.mjs`；自定义保留期 `--days 90`。
- 真删：`node scripts/d1_cleanup.mjs --apply`（需本机 wrangler 已登录 Cloudflare；
  无登录态时脚本以退出码 1 如实报错，**不假装已清理**）。
- 存量口径：schema v1 时代的行 `expires_at` 为 NULL ⇒ **视为不过期**，本脚本绝不碰；
  需要清理旧数据由运维显式回填 `expires_at` 后再跑。复算命令：

```powershell
node scripts/d1_cleanup.mjs          # dry-run
node scripts/d1_cleanup.mjs --apply  # 真删（需登录态）
```

## 7. 本 runbook 的自检命令

```powershell
cd c:/Users/37533/Desktop/workspace/项目/医/doctor-ai-dx-mvp
Get-Content frontend/wrangler.toml
Select-String -Path frontend/wrangler.toml -Pattern 'secret'
Select-String -Path backend/app/main.py -Pattern 'health'
Select-String -Path frontend/functions/lib/observe.js -Pattern 'SLOW_MS'
python scripts/docs_path_guard.py
python frontend/tests/docs_surface_guard.mjs
```

> 纪律：本文件与 `docs/COMPATIBILITY.md`、`docs/PITFALLS.md`、`docs/INTEGRATION.md` 分工——**本文件＝操作序列**（做什么、按什么顺序、怎么回滚）；PITFALLS＝根因手册（为什么坏）；COMPATIBILITY＝能力边界（能不能装）。三者不重复内容，重复即漂移。
> 维护触发：改动部署命令、门禁形态、回滚路径、密钥处理任一项时，**同一提交内**更新本文件与 `CHANGELOG.md`。
