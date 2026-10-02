# 知识条目维护手册（KNOWLEDGE MAINTENANCE）

> 口径：本手册只讲"改哪里、按什么顺序跑、哪条判据守哪一步"。条目数、映射键数、同义词组数、加权词数、套件数、钩数、链路步数一律不手抄——真值由各自单一源现算（知识库由 `data/knowledge.json` 现算；套件数由 `frontend/package.json` 现算；钩数由 `.pre-commit-config.yaml` 现算；链路步数以 `docs/ARCHITECTURE.md` 图内符号现算），判据见 `frontend/tests/docs_link_guard.mjs`。

## 1. 新增一条知识

1. 只改权威一处：`data/knowledge.json` 的 `entries` 加一项（含 `source` 与 `year`；`url` 只有逐条人工核验可达后才写，禁止批量填猜测链接）。
2. 重生成两端：`frontend/tests/kb_guard.mjs` 指定的导出命令（见 `frontend/package.json` 内 `kb:export` 脚本）单向产出 JS 与 Py 生成物；手改任一端生成物必被三方全等判据抓。
3. 重建语义邻接表：`scripts/build_semantic_neighbors.py`（需外部引擎与权重在场；缺失时扩库为阻塞态，记台账不硬改，见 `docs/ARCHITECTURE.md` 扩展点节）。
4. 跑门禁：`frontend/tests/kb_guard.mjs`（含 schema、孤儿、溯源棘轮、死权重零豁免）与 `frontend/tests/link_health.mjs`（新域名先加白名单再写条目）。

## 2. 审核与撤回

- 审核：`source` 是否为公开指南或教材要点摘要；付费库原文不得入；`condition` 命名与 `scope` 首段域保持与 `docs/EVAL_CARD.md` 病种清单一致（该清单由判据与知识库逐条逐域全等对账，改名不动清单即红）。
- 撤回：从 `entries` 删除对应项后同样走导出与邻接重建；过期撤回流程以本节为准，结论使用前请核对来源年份。
- 加权词规矩：加权词一律取指南侧写法（医生口语侧由同义词表桥接）；每个加权词必须在语料正文真出现，否则恒零分并被零豁免判据拦。

## 3. Provider 失败归因与处置矩阵（实现事实：单次调用、零重试、无熔断）

> 实现唯一源为 `frontend/functions/lib/engine.js` 内的 `callLLM` 与 `llmCauseOf`。本表只陈述**已实现**的行为，且每行给出机器可核的回执锚点：形状是「回执」二字后接仓根相对路径、双冒号、该文件里真实存在的标识，整体用六角括号包住（表下即实例）。由 `docs_link_guard` 逐条核"路径可解析 + 标识在该文件里在场"，指向不存在的实现即判红。
>
> **本节曾有假承诺（2026-10-01 立，2026-10-02 自纠）**：上一版这里写的是「`timeout`／`net_error`／服务端错误类 至多重试一次」，而实测 `engine.js` 全文只有**一处** `fetch` 调用点、无重试环、无熔断——那句话是文档造出来的第二个真值，代码里并不存在。改法是把话降级成事实，而不是把代码改成话：重试会把单次窗口翻倍，与 `docs/EVAL_CARD.md` 现役行的 P95 上限约束直接冲突（读数只认那一行，本文件不抄数值），且线上失败面已由 `fallback_cause` 闭集做到可归因，重试并不能提高"能不能查出来"。

| 失败归因 | 处置 | 回执 |
|---|---|---|
| `no_key` | 不外呼，规则引擎直接出答案 | 〔回执：frontend/tests/live_path_guard.mjs::无 Key 零外呼并降级〕 |
| `timeout`／`net_error` | 一次外呼失败即降级，不重试 | 〔回执：frontend/tests/live_path_guard.mjs::单次调用零重试〕 |
| `http_5xx`／`http_429` 等服务端类 | 同上：单次调用零重试；4xx 按坏请求处理不进引擎 | 〔回执：frontend/tests/live_path_guard.mjs::单次调用零重试〕 |
| `bad_json`／`schema`／`empty`／`truncated`／`content_filter`／未知完成态 | 单次调用零重试后降级（输出非法时重试只会再花一次窗口） | 〔回执：frontend/tests/live_path_guard.mjs::单次调用零重试〕 |
| 归因本身的可信度 | 原因取闭集枚举，塌成一句即判红 | 〔回执：frontend/tests/fixtures/llm_fallback_causes.json::causes〕 |
| 入站越界与坏请求 | 契约层直接拒收，不消耗模型窗口 | 〔回执：frontend/functions/api/[[route]].js::413〕 |

**若将来真要实现重试**：先让 `单次调用零重试` 那组断言变红并改其期望值，同时把本节改写成带预算数字的矩阵（重试次数、总额预算、与 P95 上限的算术关系），两端 `engine.js`／`llm.py` 同改否则 `test:contract` 判红——不许只改文档。

配套纪律：对外响应只给医生可理解文案与 `fallback_reason`；归因闭集只用于内部排障；慢请求阈值与日志脱敏口径见 `docs/ARCHITECTURE.md` 可观测性节。
