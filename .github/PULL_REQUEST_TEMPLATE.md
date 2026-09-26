## 变更摘要

<!-- 一个 PR 一个主题；依赖升级请走 Dependabot + 聚合批（见 CONTRIBUTING） -->

## 红线自查（必勾）

- [ ] 红旗规则层保持独立于 LLM，命中结果不可被模型覆盖
- [ ] 全部 `evidence_id` 仍来自知识库白名单（kb-001~055），引用溯源不破坏
- [ ] "AI 辅助参考 · 医生终审"文案与脱敏合成病例口径未动

## 门禁证据（必填输出摘录，只写"已跑"不算）

```
cd frontend && npm test    # 九件套（含双端契约 31/31、API 契约守卫、检索地板线）
python backend/tests/smoke_engine.py
```

- [ ] 涉知识库变更：只改权威 `data/knowledge.json`，再跑 `npm --prefix frontend run kb:export` 重生成两端（`kb:check` 只核不写；手改生成物由 `kb_guard` 判红）
- [ ] 涉 Functions 变更：线上重部署后 `/api/health` 实测 + dx 冒烟通过
- [ ] 涉 schema/输出结构：`contract_parity` 双端一致

## 文档同步

- [ ] 行为/口径变化已更新 `docs/EVAL_CARD.md` 与 `CHANGELOG.md`
