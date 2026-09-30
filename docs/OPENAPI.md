# OPENAPI（人类可读派生版）

版本: 1.45.0 ｜ 标题: 医·基层AI辅助诊断系统 API

> 本文件由 `docs/openapi.json` 单向派生，禁止手写契约；契约变更只改 openapi.json 后重跑 `python scripts/gen_openapi.py`。

> 合规声明：演示仅脱敏合成病例；evidence_ids 仅限知识库白名单 kb-001~055；红旗规则层独立于 LLM 不可被模型覆盖

## GET /api/cases

脱敏演示病例列表（3 例合成数据）

tags: clinical

响应码: 200

## POST /api/intake/ask

智能问诊推进（下一追问或置 done；含 state 临床状态抽取）

tags: clinical

响应码: 200 / 400 / 404 / 413 / 422 / 500

## POST /api/dx/{caseId}

辅助诊断（状态抽取→BM25 检索→LLM 生成→确定性校验→红旗兜底→失败降级）

tags: clinical

响应码: 200 / 400 / 404 / 413 / 422 / 500

## POST /api/workup/{caseId}

检查建议（essential/suggested/optional 三组；可复用已生成诊断省一次串行 LLM）

tags: clinical

响应码: 200 / 400 / 404 / 413 / 422 / 500

## POST /api/report/{caseId}

SOAP 病历报告（含免责声明与医生终审定位）

tags: clinical

响应码: 200 / 400 / 404 / 413 / 422 / 500

## GET /api/health

服务与 LLM 模式探活（llm_mode=live|mock-fallback；data.version=发布版本，与 tag 由 version_guard 对账）

tags: system

响应码: 200
