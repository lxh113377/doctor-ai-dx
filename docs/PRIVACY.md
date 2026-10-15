# 数据留存与隐私声明（PRIVACY）

> 版本：v1.12.0（第一百零八轮：镜像面新增**缺省关闭**的可选 MySQL 持久化，见 §2/§7）｜ 生成：2026-09-25 ｜ 适用范围：`doctor-ai-dx` 全部运行面（Cloudflare Pages + Functions 权威面、FastAPI 镜像面、本地演示）
> **本声明描述的是实现事实，不构成 HIPAA / GDPR / 个人信息保护法等任何合规认证。** 每条都给出代码位置，可被 `npm run test:privacy` 机器核对；代码一变而本文件未同步，该门禁即判红。

## 1. 一句话结论

**权威面（线上）不存任何患者数据**；数据只在一次请求的生命周期内存在。镜像面（自托管 FastAPI）自第一百零八轮起提供**可选**的 MySQL 持久化，**缺省关闭**（`PERSIST_BACKEND` 不设即不建引擎、不落一行），且只覆盖会话记录与派生语料副本，不含真实患者数据（本项目只用脱敏合成病例）。唯一的对外数据流仍是发给大模型供应商的推理请求，而它**必然包含问诊文本**——这是产品功能的必要代价，本文件如实写明而不隐藏。

## 2. 我们存了什么

**权威面什么都不存；镜像面缺省什么都不存，显式开启后按下表存。**

| 层 | 事实 | 实现位置 |
|---|---|---|
| 服务端会话（权威面） | 无。接口 stateless，问诊历史由前端随请求携带 | `backend/app/models.py` `IntakeAskRequest.history`（注释「由前端随请求携带（stateless）」）、`frontend/functions/api/[[route]].js` 各 `body.history` 透传 |
| 持久化（权威面） | 仅 Cloudflare D1 会话/消息/转人工/满意度（绑定式 serverless 库，见 `docs/DEPLOY_RUNBOOK.md` §6.5 的 TTL 清理）；**不含问诊自由文本以外的患者身份数据** | `frontend/functions/lib/chat_store.js` + `scripts/d1_schema.sql` |
| 持久化（镜像面，**缺省关闭**） | 把 `PERSIST_BACKEND` 置为 `mysql` 时才会写：会话/消息/意图事件/转人工/满意度（与 D1 同构）+ `data/*.json` 语料的派生副本 + 评测报告副本。不设时不建引擎、不写任何行，与未装驱动时行为一致 | `backend/app/db/engine.py`（`current_engine()` 三种关闭态各带可归因 reason）、`backend/app/db/repository.py` |
| 语料权威源 | MySQL 里的语料/评测行**只是派生下游**：权威源仍是 `data/*.json` 与 `eval_report*.json`，`scripts/mysql_load_corpus.py --verify` 逐键指纹对账，库侧手写必被抓 | `scripts/mysql_load_corpus.py` |
| 客户端存储 | 无。不使用 localStorage / sessionStorage / IndexedDB / Cookie | `npm run test:privacy` 由门禁扫描 `frontend/src` 全量源码 |
| 日志 | 只落归因最小集：`req / path / method / ms / kind / msg`；**不写请求体、不写堆栈** | `frontend/functions/api/[[route]].js` 的 `logEvent("error", …)` 字段集与注释；`frontend/functions/lib/observe.js` ↔ `backend/app/observe.py` |
| 日志保留期 | 由运行平台决定：日志只写 stdout，本项目不额外留存、不接第三方日志后端（Sentry/Langfuse/OTLP 均未接入，需外部账号与密钥） | `docs/EVAL_CARD.md` §3「日志留存与集中化」 |
| 持久化保留期（镜像面） | 会话行带 30 天 TTL 语义（与 D1 清理同形）；语料/评测副本随权威源重灌整体替换。**TTL 清理任务属部署方义务**，本仓未内置定时器 | `backend/app/db/repository.py` `TTL_DAYS` |

## 3. 数据会流向谁（唯一出站面）

| 目的地 | 内容 | 传输 | 约束 |
|---|---|---|---|
| LLM 推理服务（默认 DeepSeek 兼容端点，可经 `DEEPSEEK_BASE_URL` 换供应商） | 抽取后的临床状态（患者姓名/年龄/性别/主诉、问诊转录文本、症状槽位、红旗列表）+ 检索到的知识库摘要 | HTTPS POST `/chat/completions` | 单次硬超时 8s（`frontend/functions/lib/engine.js` `AbortSignal.timeout(8000)`）；密钥仅从环境变量读取，绝不写入代码、响应或日志 |

> 换供应商 = 换数据接收方。**接入新模型供应商前必须先完成该供应商的数据处理协议与留存政策评审**，此项无自动化判据可 substitute，属人工/法务环节。

除此之外**无任何第三方遥测**：全仓无埋点、无 analytics、无 beacon、无广告 SDK（`npm run test:privacy` 扫描判定）。

## 4. 主动做的最小化与脱敏

1. **日志字段白名单**：只落上述 6 个键，请求体与堆栈一律不落（代码内有显式注释）。
2. **出站前脱敏**（`frontend/functions/lib/observe.js` ↔ `backend/app/observe.py`，双端模式表由门禁逐条比对，实测 7/7 用例输出逐字相同）：
   - 密钥形态：`sk-…`、`Bearer …`、以及环境里真实 Key 的字面量 → `[已脱敏]`
   - 内部结构：`file://…`、盘符/常见根路径、`at fn (…)` 栈帧 → `[内部路径]`
   - **患者可识别信息（v1.11.0 新增）**：中国大陆手机号 11 位形态、18 位身份证号形态 → `[已脱敏]`
   - 截断：任何被脱敏的文本上限 300 字符
   - 边界约束是刻意的：13 位毫秒时间戳内含满足手机号模式的 11 位子串，两侧都加了负向断言，避免"假脱敏"掩盖真实问题（实测 `时间戳 1758777600000` 不被误伤）。
3. **响应面**：错误只回医生可理解文案 + 故障编号（`故障编号 ${requestId}`），不外泄堆栈/路径/密钥。
4. **密钥生命周期**：`.env` / `.env.*` 在 `.gitignore` 内，仓库只保留空值模板 `backend/.env.example`；`current_api_key()` 实时读进程环境，防止 lru_cache 快照导致新写入的密钥漏脱敏。

## 5. 演示与评测数据

- 界面演示仅 3 例**合成病例**；评测集 31 例与检索集 50/20 例均为合成或口语化改写，**不含任何真实患者数据**（项目红线）。
- FHIR 导出对每位患者强制打 `syntheticCase = true` 扩展（`frontend/functions/lib/fhir.js`），供下游系统区分演示数据与真实数据。
- 知识库语料仅引用公开临床路径/指南/共识的**标题与要点摘要**，不含未授权全文（`frontend/functions/lib/knowledge.js` 头注释；回链域名由 `kb_guard` 离线白名单 + `link_health` 联网核验双重守门）。

## 6. 明确未提供（试点前必须补齐，不得据此声明用于真实患者）

| 缺项 | 影响 | 备注 |
|---|---|---|
| 认证与授权 | 任何能访问该 URL 的人都能调用；无用户身份、无租户隔离 | 竞赛/演示可接受，真实部署不可 |
| 审计日志 | 无法回答"谁在何时看了哪个病例" | 监管与医院内控的基本项 |
| 数据主体请求（DSR）流程 | 无删除/导出/更正通道 | 权威面因本就不存个人数据，**当前**无个人数据可删除；镜像面**开启持久化后**，会话行的删除通道 = 按 conversation_id 删（`backend/app/db/repository.py` 清理语义），**完整的 DSR 流程仍属部署方义务**，试点前必须先补 |
| 静态加密 | 权威面 D1 由平台侧负责；镜像面 MySQL **不做应用层加密**，静态加密（磁盘/TDE/传输 TLS）由私有化部署方在库侧配置，开启持久化前必须先落实 | `MYSQL_URL` 支持 `ssl_*` 参数（pymysql 原生），但本仓不做默认值——密钥与证书属部署方资产 |
| LLM 供应商数据处理协议 | 未签署任何 DPA | 试点前必办 |
| 伦理审查与知情同意 | 未开展 | 真实试点前置条件 |

## 7. 持久化条款（第一百零八轮起生效；取代原「将来引入时」的预案）

原 §7 是预案，第一百零八轮已把它兑现成实现 + 判据，逐条对账：

1. ~~§2「什么都不存」失效 → 必须写明存什么/多久/加密/访问主体/删除机制/保留期~~ → **已写入 §2**（存什么/保留期）与 §6（加密与 DSR 义务）。
2. ~~DSR 一项从"不适用"变为必做~~ → **§6 已改**：镜像面开启持久化后 DSR 属部署方必做项；权威面口径不变。
3. ~~`npm run test:privacy` 的"零持久化"断言必须被替换为"持久化白名单 + 加密断言"，禁止直接删断言凑绿~~ → **已照此实现**（`frontend/tests/privacy_guard.mjs`）：① 权威面与前端仍**零持久化、零豁免**；② 镜像面命中持久化原语的文件必须**全部**落在 `backend/app/db/` 白名单内（白名单外命中即红）；③ 白名单非空时必须证明开关**缺省关闭**（`PERSIST_BACKEND` 缺省 `off` 且非 `mysql` 即提前返回）——装进依赖锁 ≠ 接进运行链路。对照组负向断言同步改口径（白名单外三类全零），旧「persistence 全零」口径已按第 3 条预案替换而非删除。

**红线不变式（第一百零八轮不改变它）**：任何持久化面都不得让它能覆盖红旗判定或引用白名单——红旗规则层仍独立于 LLM 与存储（`data/red_flag_rules.json` 单源，库里那份只是派生副本）。

## 8. 复现核验

```bash
cd frontend && npm run test:privacy      # 声明 ↔ 代码一致性门禁（含反例实测）
node tests/privacy_guard.mjs             # 单独跑
```

联系人/安全漏洞报告渠道见 [`SECURITY.md`](../SECURITY.md)。
