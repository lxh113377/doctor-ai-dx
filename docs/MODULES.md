# 模块清单（MODULES）

> **本文件是派生物，禁手改**。生成器 `scripts/gen_modules_manifest.py`，改法＝改生成器。
> 现算命令：`python scripts/gen_modules_manifest.py --check`（逐字节比对）。
> 存在的理由：第 98 轮八维开源对标实测 `openmrs/openmrs-core` 以**模块注册表**
> 把「能力外插」变成契约，而本仓 `lib/` 此前**没有**任何模块清单 —— 当时 26 个模块的
> 职责、依赖与生命周期只存在于各文件首句的散文里，无法对账。
>
> 口径：行数 27（现算，随 `--apply` 同步）、字节、导出数、依赖**全部读盘现算**，本表不抄任何手抄数。

<!-- gen_modules_manifest.py:BEGIN -->
## 1. 现算读数

| 模块 | 字节 | 导出数 | 依赖（读盘实抽） | 生成源 | 职责（首句） |
|---|---:|---:|---|---|---|
| `admin_auth.js` | 2,201 | 6 | — | — | 管理后台最小鉴权。 |
| `cds_hooks.js` | 7,513 | 5 | cds_services, data, limits, rules | — | CDS Hooks 2.0 适配层（第八十五轮对标落地；权威面 JS，镜像面 backend/app/services/cds_hooks.py 同形） |
| `cds_http.js` | 2,452 | 4 | observe | — | CDS Hooks 路由族共用的 HTTP 外壳（第八十五轮） |
| `cds_services.js` | 3,042 | 9 | — | data/cds_services.json（export_cds_services.mjs） | CDS Hooks 服务目录（构建期产物，禁手改）——由 scripts/export_cds_services.mjs 从 data/cds_services.json 生成。 |
| `chat.js` | 8,228 | 2 | chat_store, chat_synth, faq, handoff, intent, version | — | /api/chat 编排器：把「红旗闸门 → 意图 → FAQ → 转人工 → 脱敏落库」串成一条确定性链。 |
| `chat_store.js` | 25,931 | 26 | pii | — | D1 持久化门面：会话 / 消息 / 意图事件 / 转挂 / 反馈。 |
| `chat_synth.js` | 6,842 | 3 | intent | — | 确定性话术合成：Agent SDK 不可用、或红旗旁路时，**仍然要给出一段合规回复**。 |
| `clinical_scores.js` | 2,648 | 5 | — | data/clinical_scores.json（export_clinical_scores.mjs） | 临床评分量表表（构建期产物，禁手改）——由 scripts/export_clinical_scores.mjs 从 data/clinical_scores.json 生成。 |
| `data.js` | 5,449 | 4 | — | — | 数据层（脱敏演示病例）——Cloudflare Functions 版 |
| `engine.js` | 27,581 | 11 | data, fhir, knowledge, rag, retriever, rules | — | 诊断引擎：临床状态抽取 → 证据检索(BM25) → LLM 结构化生成 |
| `faq.js` | 2,423 | 2 | rag | — | FAQ 检索封装：把既有 BM25 检索器包装成「可引用的答案包」。 |
| `fhir.js` | 10,810 | 2 | knowledge | — | FHIR R4（light 子集）导出层：把诊断结果映射为标准资源 Bundle， |
| `handoff.js` | 5,961 | 6 | intent | — | 设计取向：**宁可多转，不可硬答**。本项目的红线是「不硬答、不拿未回链结论吓人」， |
| `hybrid_rrf.js` | 2,367 | 2 | — | — | hybrid_rrf.js — RRF 融合层（零新依赖，为 dense 预留接口） |
| `intent.js` | 6,655 | 9 | intents, knowledge, rules | — | 对话面意图识别器。 |
| `intents.js` | 5,977 | 6 | — | data/intents.json（export_intents.mjs） | 意图注册表（构建期产物，禁手改）——由 scripts/export_intents.mjs 从 data/intents.json 生成。 |
| `knowledge.js` | 44,299 | 8 | — | — | 医学知识库（RAG 语料，带完整元数据）+ 同义词表 + 检索加权词 + 症状映射 |
| `limits.js` | 7,065 | 17 | — | — | API 滥用护栏（v1.17.0 第十九轮）——双端同源数值，权威清单 = tests/fixtures/request_limits.json |
| `observe.js` | 3,420 | 6 | — | — | 可观测性：请求标识 + 结构化日志 + 出站前脱敏 |
| `pii.js` | 3,201 | 3 | — | — | 入库前脱敏器（红线 3：演示与留痕只用脱敏合成数据）。 |
| `rag.js` | 10,618 | 8 | knowledge | — | RAG 检索：BM25 + 医学术语同义词扩展 + 红旗加权 |
| `red_flag_rules.js` | 7,284 | 7 | — | data/red_flag_rules.json（export_red_flags.mjs） | 红旗规则表（构建期产物，禁手改）——由 scripts/export_red_flags.mjs 从 data/red_flag_rules.json 生成。 |
| `retriever.js` | 8,756 | 17 | knowledge, rag, semantic_neighbors | — | 检索器边界：可插拔注册表。bm25 = 线上默认（口径不变）；hybrid = BM25+概念通道加权 RRF； |
| `rules.js` | 18,336 | 13 | clinical_scores, red_flag_rules, scope_rules | — | 危险信号规则引擎（红旗拦截层）——独立于 LLM：可解释、可单测，评审安全叙事核心 |
| `scope_rules.js` | 2,810 | 4 | — | data/scope_rules.json（export_scope.mjs） | 适用范围规则（构建期产物，禁手改）——由 scripts/export_scope.mjs 从 data/scope_rules.json 生成。 |
| `semantic_neighbors.js` | 9,896 | 2 | — | 本地 BAAI/bge-small-zh-v1.5 蒸馏产物（build_semantic_neighbors.py） | 语义邻接表（构建期产物，禁手改）——由 scripts/build_semantic_neighbors.py 生成。 |
| `version.js` | 267 | 1 | — | — | 版本单一真值源（后端口径 = backend/app/version.py，二者由 tests/version_guard.mjs 强制同值）。 |

**合计 27 个模块**，其中 **6 个是构建期产物**（生成源列非空），字节合计 242,032。
<!-- gen_modules_manifest.py:END -->

## 约定

| 约定 | 规则 |
|---|---|
| 构建期产物 | 「生成源」列非空的 6 个件由生成器重生，**手改必被 `--check` 判红** |
| 依赖列 | 读 `from "./x.js"` 实抽；`—` 表示零同仓依赖（叶子模块） |
| 新增模块 | 必须同时在本表补一行**职责**（首句）与依赖；`--check` 会发现新增件而本表无行 ⇒ 判红 |
| 变更职责 | 只改首句注释即可，本表随 `--apply` 同步；**不要手改本表** |
