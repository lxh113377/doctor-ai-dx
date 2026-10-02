# examples/ — 最小可运行示例（r91，S9）

面向外部贡献者与集成方：不改引擎、不接数据库、零密钥，把对话面的确定性链路跑起来。

## 1. 直接跑（Node 22+，仓根执行）

```bash
node examples/chat_basic.mjs
```

输出三次对话的完整裁决（红旗 / 退费追问 / 医疗问诊+引用），全部走
`frontend/functions/lib/chat.js` 的 `handleChat`——与线上 `/api/chat` 同一份判定代码，
无网络、无 D1、无 API Key。

## 2. 示例清单

| 文件 | 演示什么 | 关键点 |
|---|---|---|
| `chat_basic.mjs` | 三类意图 + 红旗旁路 + 槽位追问 | `handleChat` 是唯一入口；`mode` 恒为 `deterministic` |

## 3. 集成方最小契约

- 请求：`POST /api/chat`，body `{ text, history?, conversation_id? }`（`history` 为
  `{role, content}` 数组，`conversation_id` 首轮可空）。
- 响应：`{ code: 0, data }`；`data.mode === "deterministic"` 表示本判定面不经任何模型；
  `data.answer.citations` 只含白名单内的知识库条目。
- 红线：`data.red_flag` 非空时，`answer.text` 是规则层逐字直出的急诊/转诊提示，
  **调用方不得改写、不得截断**，必须完整展示给医生。

## 4. 常见误区

- 不要在 `text` 里塞超过 2000 字（422）；`history` 超过 64 条同样会被拒。
- `conversation_id` 自备时请用你自己的唯一前缀；留空则由系统生成。
- D1 未绑定时 `data.persisted === false`——这是**如实降级**，不是错误；需要持久化请按
  `docs/DEPLOY_RUNBOOK.md` 绑定 D1。
