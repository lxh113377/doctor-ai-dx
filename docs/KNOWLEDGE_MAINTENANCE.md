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

## 3. Provider 重试与熔断矩阵（行为文档化，不改行为）

> 实现唯一源为 `frontend/functions/lib/engine.js` 内的调用与归因函数；下表逐行对得上该实现，改实现须同步改表。

| 失败归因 | 处置 | 说明 |
|---|---|---|
| `no_key` | 直接降级，不重试 | 无密钥时规则引擎即答案 |
| `timeout`、`net_error`、服务端错误类 | 至多重试一次，且单次硬超时与总额预算不变 | 超预算即降级，不延长链路 |
| `bad_json`、`schema`、`empty`、`truncated`、`content_filter` 及未知完成态 | 直接降级，不重试 | 输出非法或被截断/过滤时重试只会再花一次窗口 |
| 入站越界与坏请求 | 在契约层直接拒收，不进引擎 | 不消耗模型窗口；客户端错误记 warn 级 |

配套纪律：对外响应只给医生可理解文案与 `fallback_reason`；归因闭集只用于内部排障；慢请求阈值与日志脱敏口径见 `docs/ARCHITECTURE.md` 可观测性节。
