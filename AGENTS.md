# AGENTS.md — 面向 AI 编码代理与新贡献者的仓库入口

> 本文件是**仓库内**的操作性入口：给"第一次打开这个仓的 AI/人"看的。
> 为什么要单独一份：对标实测（2026-09-26）——`infiniflow/ragflow` 仓根带 agent 指引文件与 `.agents/`
> 目录，外加 GitHub 的 copilot 指引；`openemr/openemr` 也带 copilot 指引；我方此前为零。评审与协作者
> 现在用 agent 读仓，没有这一层就只能靠猜"哪条命令是权威、哪份文档是现状、什么不许改"。
> 与其它文件的分工：`README.md` 讲"这是什么"，`docs/` 讲"为什么这样设计"，本文件只讲"动手时该怎么跑、什么不许改"。

## 1. 这个仓在做什么

基层医生常见病多发病的 AI 辅助诊断系统（2026 iCAN 参赛源码）。一条主链路：

```
脱敏病例 → 临床状态抽取 → BM25 证据检索 → LLM 结构化生成 → 确定性校验 → 红旗规则兜底 → 失败安全降级
```

同一套逻辑有两个镜像面，**必须逐字段一致**：

| 面 | 位置 | 用途 |
|---|---|---|
| 权威面（线上） | `frontend/functions/lib/*.js` | Cloudflare Pages + Functions，DeepSeek live |
| 镜像面（可自托管） | `backend/app/*.py` | FastAPI，零密钥时规则降级；容器与离线评测用这一面 |

## 2. 动手前必读的三条产品红线

这三条不是风格偏好，是**医疗安全叙事**，改任何一条都要停下来：

1. **红旗规则层独立于 LLM**：命中结果不可被模型覆盖（`functions/lib/rules.js` ↔ `app/rules.py`）。
2. **全界面常驻「AI 辅助参考 · 医生终审」**：不得出现"替代医生"类表述（E2E 有负向断言）。
3. **只用脱敏合成病例**：禁止接入真实患者数据；知识条目只收录公开指南的标题与要点摘要。

对外错误文案只能出现医生可理解的话，不展示堆栈与内部阈值（`docs/ERRORS.md` + `tests/error_parity_guard.mjs`）。

## 3. 该跑哪些命令

```bash
cd frontend && npm ci          # 安装（锁文件是权威，不要 npm install 顺手升版）
npm test                       # 二十二件套守卫（含诊断排序金标准与否定守卫全表探针）；零密钥、零网络、确定性
npm run probe:ood                # 域外可分性测量（**看守件、不进 npm test**：只报告不阻断）
npm run coverage:js            # c8 + 模块级地板（地板清单单一源 tests/fixtures/coverage_floor.json）
npm run test:e2e               # Playwright 双视口（1440×900 / 390×844）+ 三条红线在场与负向断言
npm run lint:js                # ESLint --max-warnings=0（警告也算红）
cd .. && npm --prefix frontend run typecheck     # mypy（零豁免档，阈值 fixtures/type_floor.json）
npm --prefix frontend run lock                   # 依赖锁对账（钉版 + sha256 + Dockerfile 真从锁装）
npm --prefix frontend run deps:check             # import↔声明面、非 optional peer↔package-lock
npm --prefix frontend run smoke:live             # 打线上：version 对账 + 404/413 契约 + 三条红线在场
npm --prefix frontend run actions                # Actions 钉版与最小权限（本机离线档）
python backend/selftest.py     # 镜像面自证（套件清单唯一真相源 backend/tests/suite.json）
```

改完提交前跑 `pre-commit run --all-files`（12 个钩，与 CI 同源判据，不是另一套标准）。

## 4. 改 X 之前先知道 Y（本仓最容易踩的六条）

- **改任何一面的行为 ⇒ 另一面同改**。双端对账守卫会红：`contract_parity` / `retriever_parity` / `error_parity_guard` / `fhir_guard` / `kb_guard`。期望值写在 `frontend/tests/fixtures/*.json`，**不要**改 fixture 数字来让它绿——fixture 与生成器之间也有漂移判据。
- **不要新增第二份真值**。版本号、套件清单、错误矩阵、发布正文阈值、limits 阈值都各有唯一来源（见 `docs/ARCHITECTURE.md` 的对账矩阵）。要加就改生成器。
- **知识库方向：`frontend/functions/lib/knowledge.js` 是权威源，`backend/app/knowledge.py` 是生成物**（第二十四轮实测生成器后校正：本文件此前把方向写反，会引导贡献者去改生成物）。改 JS 后跑 `npm --prefix frontend run kb:export` 重生成，手改 .py 数据必被 `kb_guard` 的双端全等判据抓。
  **但增删条目还要过语义邻接表这一关**（第二十五轮实测记）：`semantic_guard` 要求表的条目数与语料指纹跟 `knowledge.js` 全等，重建表得跑 `python scripts/build_semantic_neighbors.py --engine-dir <含 bge_onnx_engine.py 与 ONNX 权重的目录>`，而该引擎与权重**不在本仓库内**——没有它们，扩库会在守卫处判红且无法自行解除（这是刻意的：宁可拦住也不放行一张陈旧表）。动手扩库前先确认拿得到该产物，否则先把阻塞记进台账而不是硬改。
- **工作流/Dockerfile/compose 也有判据**（`infra-lint`：actionlint + hadolint + compose config + codespell）。所有 `uses:` 必须钉 40 位提交号并带版本注释，顶层必须有 `permissions:`，checkout 必须 `persist-credentials: false`——由 `scripts/action_pin.py` 机器核（升级 action 时跑 `python scripts/action_pin.py --resolve --apply`）。
- **控制字符会静默毁掉判据**：往 JS/Py 源码里写正则时，`\b`/`\1` 经多层转义可能落成裸 `0x08`/`0x01`，于是"永不匹配的死判据"仍显示通过。`scripts/check_text_hygiene.py` 兜这一类，别靠记忆。
- **升版必须重算两份锁**（x86_64 与 arm64）且同刻：`python scripts/recompile_locks.py`。uv 有 in-source 缓存，同一句命令分两次跑会出不同结果。

## 5. 发布与验收口径

- 打 tag `vX.Y.Z` ⇒ `.github/workflows/release.yml` 先跑全部门禁，绿了才产出源码包 + 双端 SBOM + SHA256SUMS + 多架构镜像（`linux/amd64`、`linux/arm64`）并挂 Release。本机 `git archive` 重建的包与 Release 资产**逐字节相同**是硬判据（`scripts/release_repro_check.py`）。
- 「发布完成」的判据是**远端可见物**（tag 在 origin、run success、Release 资产在），不是本机提交成功。
- 护栏把发布拦下来＝这是成功而不是故障：不绕过、不放宽阈值，如实报"未发 + 拦在哪"。
- 已知边界与在办事项见 `docs/PITFALLS.md`（每条坑必须写出"哪条常驻判据在守它"，写不出的不许进手册）。

## 6. 许可

自定义参赛授权（见 `LICENSE`）：公开可查阅、用于评审与学术交流，**不得**用于商业产品、临床部署或二次分发。因此 GitHub 的 license 字段会显示 `Other`——这是刻意选择，不是漏配 `LICENSE` 文件。
