# 贡献指南（CONTRIBUTING）

单作者竞赛项目，但按可接手的方式写清楚：**改哪里、必须同步哪里、提交前必须跑什么**。

## 环境

- Node 22+ / Python 3.12+（`python` 或 `python3` 需在 PATH 上，双端一致性测试要用）
- 前端：`cd frontend && npm ci && npm run dev`（vite 代理到 Functions）
- 后端镜像：`cd backend && pip install -r requirements.txt && python run.py`
- 无 API Key 也能全绿：全链路走 `rule-fallback`，这正是 CI 的口径

## 代码布局与「一处改要同步两处」

线上权威是 **`frontend/functions/lib/*.js`**（Cloudflare Pages Functions）；`backend/app/*.py` 是行为镜像。

| 权威源（改这里） | 镜像（必须同步） | 同步方式 |
|---|---|---|
| `functions/lib/knowledge.js` | `backend/app/knowledge.py` | 跑 `npm --prefix frontend run kb:export`（即 `scripts/export_kb.mjs`）生成，**不要手改 .py 数据** |
| `functions/lib/engine.js` | `backend/app/services/engine.py` | 人工同步 + `contract_parity.mjs` 守门 |
| `functions/lib/rag.js` / `rules.js` / `retriever.js` | `backend/app/rag.py` / `rules.py` / `retriever.py` | 人工同步 + 双端测试守门 |
| `functions/lib/observe.js` | `backend/app/observe.py` | 人工同步（取整/脱敏规则必须两端一致） |

**取整规则**：两端数值输出统一用 half-up（JS `Math.round`，Python `app.rag.round_half_up`）。
不要用「放宽比对容差」掩盖末位差——历史上这样掩盖过一次 `.020313 vs .020312` 的真实漂移。

## 提交前必须全绿

```bash
cd frontend && npm test                       # 二十二件套，含双端契约、配置契约(env)、诊断排序金标准与知识库门禁
cd frontend && npm run lint                   # 静态检查门禁（ESLint + ruff；警告也算红）
cd frontend && npm run typecheck              # Python 类型门禁（mypy 严格档，阈值 fixtures/type_floor.json）
cd frontend && npm run lock                   # 依赖锁定对账（requirements.lock 钉版+哈希 且 Dockerfile 真从锁装）
cd frontend && npm run build && npm run test:e2e   # 端到端浏览器回归（首次先 npx playwright install --with-deps chromium）
cd backend && python tests/smoke_engine.py && python tests/test_api_observe.py
cd frontend && npm run eval:live && npm run perf:gate   # 线上 live 复现 + 性能地板线（需 14 天内新鲜报告与公网可达）
```

CI 会跑同样的东西；`main` 分支保护要求 `build-and-test` 与 `backend-test` 通过。

端到端回归的维护约定（v1.15.0 起）：E2E 刻意**不进** `npm test`（那条链被 c8 整体包裹算覆盖率，混入浏览器进程会污染口径，与 lint 同理，见 `frontend/lint.mjs` 头注）。
它是"三条红线在真实浏览器渲染结果"这一层的唯一常驻证据——改视图、改文案、改样式时，五步链路断言与双视口溢出断言必须同步更新；
新增页面请一并纳入 `e2e/app.spec.mjs` 的"五步全页面"循环（漏掉一页＝把最可能溢出的一半留在盲区，本轮实测就差点这么干）。

静态检查与类型门禁的维护约定（v1.12.0 / v1.13.0 起）：

- 规则集**钉在仓内**（`frontend/eslint.config.mjs`、`仓根 ruff.toml`），不依赖工具默认值。
  实测理由：ruff 0.16 的默认 select 与旧版不同，靠默认值 ⇒ 换工具版本即换判据，本地绿不代表 CI 绿。
- 新增/关闭规则须写**为什么**（现有两处关闭：`require-await` 会误判 fetch 桩与同形 async 签名；
  ruff 不选 `BLE001`/`RUF100` 的理由见 `仓根 ruff.toml` 头注）。禁止用 `// eslint-disable` 批量压告警凑绿。
- 关闭规则不等于关闭问题：判据本身要能被反例证明"会红"（注入违例文件跑 `npm run lint` 应 rc=1）。
- 类型门禁**零豁免**：`mypy.ini` 不允许出现 per-module `disable_error_code`；确需豁免必须在 `fixtures/type_floor.json` 写明理由并附实测。告警太多时的正确做法是修生成物/生成器（第十五轮 26 条里 19 条即如此），而不是调低阈值。

## 三条不能碰的红线

1. **危险信号规则层必须独立于 LLM，命中结果不可被模型覆盖。**
2. **全界面持续显示「AI 辅助参考 · 医生终审」**，不得写成"替代医生"。
3. **只用脱敏合成病例**；接入真实患者数据需要先有伦理审查与脱敏协议，当前形态禁止。

补充约束：未回链到可核验来源的量化事实不得进入方案、视频和答辩。

## 知识库条目 PR 规范

新增/修改 `knowledge.js` 条目须满足 `frontend/tests/kb_guard.mjs` 的全部断言：

- `id` 顺延为 `kb-0NN`，不得跳号或复用；`title/source/scope/section/condition/text` 非空。
- `year` 为 4 位数字且在 1990–当前年；`keywords` ≥3 且组内不重复。
- `icd`：有对应编码则填 ICD-10 形态（组合条目用 `;` 并列），**没有就显式写 `null`**，不要留空串。
  该字段是初筛映射，未经临床复核不得作为编码依据。
- `url`：只填**人工核验过、确实指向该出处**的 https 地址。禁止填写推测性/生成式链接。
  门禁按溯源棘轮守门（未链条数只准减少、深链条数只准增加），改基线数字须在 PR 描述里说明依据。
- 若新增了症状线索词，`SYMPTOM_TO_KB` 是唯一词表来源——`detectSymptoms` 的探针直接由它派生，
  不要再在引擎里加硬编码探针清单。

## 评测集变更规范

- `frontend/tests/fixtures/retrieval_cases.json` 每次改动必须更新 `_meta.provenance`（谁标注、依据什么、是否合成）。
- 地板线（`retrieval_baseline.json`）**只准收紧不准放宽**；`--write-baseline` 会覆盖该检索器的历史最高值，用前先看 diff。
- 训练/生产数据禁止写入评测专用文件；评测集不构成临床验证，指标一律标注 "silver 标注"。

## 提交与发布

- 提交说明写「为什么」，一次提交一件事；`feat` / `fix` / `test` / `docs` / `chore` 前缀。
- 版本号走 SemVer + tag，并同步 `CHANGELOG.md` 与 `docs/EVAL_CARD.md` 的版本锚点。
- **依赖口径（第十八轮起）**：`backend/requirements.txt` 是**声明面**（写区间，给人读）；
  `backend/requirements.lock` 是**安装面**（uv 按 Linux/glibc 解析 + 全量 sha256），容器与 CI 一律从锁安装并开 `--require-hashes`。
  改声明面后必须重跑锁生成（命令就写在锁文件头注里）：
  `cd backend && uv pip compile requirements.txt --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes -o requirements.lock`
  然后 `python scripts/lock_guard.py` 对账。**Windows 本机不要直接装这份锁**（uvloop 无 Windows 轮，属预期失败），本机仍用 `pip install -r requirements.txt`。
- **错误码与对外文案口径（第二十二轮起）**：改 `frontend/functions/lib/limits.js` 里任一 `*_MESSAGE` 常量或状态码，必须同步 `docs/ERRORS.md` 与 `docs/openapi.json`（后者由 `npm run test:api` 双向核对：文档码集合 == 契约声明、文案逐字等于常量）。新增 POST 路由时还要在 `scripts/gen_error_matrix.py` 的 `ROUTES` 里登记并重生成矩阵（`python scripts/gen_error_matrix.py`），否则 `error_parity_guard` 的覆盖面判据会指名它没被测。
- **环境变量口径**：新增任何 `os.getenv("X")` / `env?.X` 读取，必须同步写进 `backend/.env.example`，
  否则 `npm run test:env` 判红（反向也一样：示例里留一个代码不读的键同样判红）。
- **版本真值链（升版本必做四步）**：① 同改 `backend/app/version.py` + `functions/lib/version.js` + `frontend/package.json` 三处 → ② `python scripts/gen_openapi.py`（外科同步契约版本，禁手改/全量重写 `docs/openapi.json`）→ ③ `npm run test:version` 五方对账绿 → ④ 打 tag `vX.Y.Z`。`/api/health` 的 `version` 字段即以此链为源。
  - ④ **必须是附注 tag**（`git tag -a vX.Y.Z -m "…"`）：`git push --follow-tags` **只推附注 tag**，轻量 tag 会静默留在本机——实测这样"推送成功"后 `git ls-remote --tags` 查不到本轮 tag，且 `release.yml`（tag 触发）根本没被唤起。发布后自查两行：`git ls-remote --tags origin refs/tags/vX.Y.Z` 有输出、`gh run list --workflow "Release artifacts (tag)"` 有该 tag 的 run。
  - 本机复现 CI 出包（跨环境逐字节一致，实测 SHA256 全等）：`TZ=UTC0 git -c core.autocrlf=false archive --format=zip --mtime=$(git log -1 --format=%ct <tag>) -o out.zip <tag>`，再用 `python scripts/release_repro_check.py --ref <tag> --against out.zip` 判定。行尾与时区两个成因的来龙去脉见 `docs/ARCHITECTURE.md` 门禁表同名行。
- **后端测试套件清单**：唯一源是 `backend/tests/suite.json`；执行一律走 `python backend/selftest.py`（`--coverage` 供覆盖率链）。**不要在 CI/compose/package.json 里再抄一份清单**——`scripts/suite_guard.py` 会把漏挂与回潮都判红（第十八轮真实踩过：新增 `test_limits.py` 后镜像 selftest 与 coverage:py 各抄的旧清单都没挂上）。
- **发布镜像**：打 tag 后由 `release.yml` 推 `ghcr.io/lxh113377/doctor-ai-dx:<tag>` 与 `:latest`；作业内还有一步**匿名**读 manifest 的实证（不带任何凭据换 token），拉不到就判红——评审要能一条命令拉下来。判据的 `Accept` 必须含 **OCI index** 类型：`build-push-action` 推上去的是 index 而非单 manifest，只列 manifest 两类会收到 `404 MANIFEST_UNKNOWN: OCI index found, but Accept header does not support OCI indexes`（v1.18.0 就因这个误判成"包是私有"，实为判据自身缺陷，见 `CHANGELOG.md` 的 1.18.1）。改 Dockerfile 后必须本地 `docker build -t probe backend && docker run --rm --entrypoint python probe selftest.py` 复验（`COPY selftest.py` 漏了就是"镜像发布出去跑不起自证"）。
- **Release 正文由机器产出**：`release.yml` 从 `CHANGELOG.md` 取 `## [<版本>]` 小节拼成 `NOTES.md` 再 `gh release create --notes-file`。小节缺失或正文 <200 字符**直接判红**（宁可不发，也不发一个只有占位话的 Release）。所以**升版本必须同轮写 CHANGELOG**，且正文不再需要（也不允许）发布后手工二次编辑。
- **线上部署口径（2026-09-25 实测）**：CI 的 deploy 作业受仓库变量 `AUTO_DEPLOY` 控制——未设时作业 **显式 skipped**（不冒充已部署，也不误红徽章）；
  配好 `CLOUDFLARE_API_TOKEN` secret 后置 `AUTO_DEPLOY=true` 即由 CI 接管，届时缺 Token 会 **判红**（fail-closed 已实测，禁止改回静默跳过）。
  部署后 CI 会校验 `线上 /api/health 的 version == backend/app/version.py`（10 次重试），把「作业绿」升级为「线上真值绿」。
  手工部署坑：`wrangler pages deploy` **不得重定向 stdout**（重定向会让 wrangler 判定非交互环境并拒绝使用缓存 OAuth，实测报
  `it's necessary to set a CLOUDFLARE_API_TOKEN`；直接执行即成功）。
- 改动影响交付物时，需同步重建源码 ZIP 与最终提交包，并跑 `node work/freeze_check.mjs`、
  `python work/check_delivery_consistency.py`（这两个是**一致性检查工具**，不是改动门槛）。

## 推送之后：CI 结果观察与排障入口

- **报错先查 `docs/PITFALLS.md`**：本仓踩过的坑按「症状（可 grep 的原样报错）→ 根因 → 处置 → 常驻判据」编在目次里，
  并且由 `frontend/tests/docs_link_guard.mjs` 守着——每条都必须点名一个**真实存在**的判据文件（写不出判据的坑不许进手册）。
  新踩的坑要进手册，请连判据一起写，否则该守卫判红。
- 一条命令看本次提交在 Actions 上的真实结果（只读，不改任何状态）：
  `python scripts/ci_watch.py --sha "$(git rev-parse --short HEAD)" --wait 900`
  判定只看远端：`[GATE:ci-watch-pass]`／失败时打印失败作业名 + 首条错误行 + run 链接；
  **一条 run 都没观察到 = rc 2（UNKNOWN），不是通过**——最常见原因是轻量 tag 没推上去（见上方 ④）。
  要机器可读就加 `--json`。
- 可选的 IDE 钩子（把上面的取数变成"push 后自动回灌失败面"）：**需在你本机配置，本仓不代改全局设置**。
  以 Qoder/Trae 的 post-execution hook 为例，把 `Bash(git push*)` 之后接一条
  `python scripts/ci_watch.py --wait 900 --json`，Agent 就能直接拿到 `failed[]` 与错误行原文而不是去猜；
  注意钩子只应做**只读观察**，不要让它自动 `gh run rerun` 或改代码——护栏拦停的发布必须人来复核（既有口径）。

## 依赖维护策略（Dependabot）

- 扫描：npm（frontend）/ pip（backend）/ github-actions 每周检查（`.github/dependabot.yml`）。
- **patch/minor**：可直接对 Dependabot PR 开 auto-merge（仓库已启用；required checks = build-and-test + backend-test，绿后自动 squash 合入）。
- **同文件多 PR 积压**：按"聚合批"处理——自开分支一次覆盖 N 包，PR 描述引用被覆盖编号，合入后关闭原 PR（留言可 `/rerun` 重建）。
- **major**：先查 peer（`npm i` 干跑看 ERESOLVE），框架级升级（如 vite 大版本）单独立项，不混入依赖批；结论写入 PR 评论留痕。
- 自动审计：`.github/workflows/dep-audit.yml` 每周一 npm audit（high 即红）+ pip-audit（观察期报告制，删 `continue-on-error` 一行即转硬门禁）；依赖文件变更的 PR 也会触发。注：本机镜像 registry 无 audit 端点，本地 `npm audit` 不可用属环境限制，以 CI 为准（2026-09-24 实测）。
- 任何依赖变更后：`npm run lint` + `npm test` 二十二件套 + `npm run lock` + `npm run build` + `npm run test:bundle`（体积地板线）+ `npm run sbom && npm run sbom:check` 全绿。
  SBOM 属发布期产物、**刻意不入库**（入库就会造出「陈旧副本 vs 当前 lock」的第二真值）；tag 工作流会重算并连同 SHA256 一起挂到 Release。
  改依赖后本地先跑一遍对账，别等发布期才发现清单漂移。方可合。
