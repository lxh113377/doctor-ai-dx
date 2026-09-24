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
| `functions/lib/knowledge.js` | `backend/app/knowledge.py` | 跑 `node ../../iCAN大学生创新创业大赛/03-评测/export_kb.mjs` 生成，**不要手改 .py 数据** |
| `functions/lib/engine.js` | `backend/app/services/engine.py` | 人工同步 + `contract_parity.mjs` 守门 |
| `functions/lib/rag.js` / `rules.js` / `retriever.js` | `backend/app/rag.py` / `rules.py` / `retriever.py` | 人工同步 + 双端测试守门 |
| `functions/lib/observe.js` | `backend/app/observe.py` | 人工同步（取整/脱敏规则必须两端一致） |

**取整规则**：两端数值输出统一用 half-up（JS `Math.round`，Python `app.rag.round_half_up`）。
不要用「放宽比对容差」掩盖末位差——历史上这样掩盖过一次 `.020313 vs .020312` 的真实漂移。

## 提交前必须全绿

```bash
cd frontend && npm test                       # 七件套，含双端契约与知识库门禁
cd backend && python tests/smoke_engine.py && python tests/test_api_observe.py
node ../../work/perf_gate.mjs                 # 性能地板线（需 14 天内新鲜 live 报告）
```

CI 会跑同样的东西；`main` 分支保护要求 `build-and-test` 与 `backend-test` 通过。

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
- 改动影响交付物时，需同步重建源码 ZIP 与最终提交包，并跑 `node work/freeze_check.mjs`、
  `python work/check_delivery_consistency.py`（这两个是**一致性检查工具**，不是改动门槛）。

## 依赖维护策略（Dependabot）

- 扫描：npm（frontend）/ pip（backend）/ github-actions 每周检查（`.github/dependabot.yml`）。
- **patch/minor**：可直接对 Dependabot PR 开 auto-merge（仓库已启用；required checks = build-and-test + backend-test，绿后自动 squash 合入）。
- **同文件多 PR 积压**：按"聚合批"处理——自开分支一次覆盖 N 包，PR 描述引用被覆盖编号，合入后关闭原 PR（留言可 `/rerun` 重建）。
- **major**：先查 peer（`npm i` 干跑看 ERESOLVE），框架级升级（如 vite 大版本）单独立项，不混入依赖批；结论写入 PR 评论留痕。
- 任何依赖变更后：`npm test` 九件套 + `npm run build` + `npm run test:bundle`（体积地板线）全绿方可合。
