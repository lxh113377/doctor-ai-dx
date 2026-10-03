# 对话面补丁账本（chat patch ledger）

> 规矩：**新增表/新增列必须三件套齐备**——① 这里登记一笔；② 实现挂在生成器里（不得改构建期产物）；③ 有回得去的回滚语句。
> 缺任一件不许上线。执行入口一律是 `node scripts/d1_migrate.mjs --upgrade`（打印 ALTER 语句，不自动执行）。

## PATCH-003 · messages 归因六列（r96，2026-10-04）

| 项 | 内容 |
|---|---|
| 状态 | ✅ 已登记 + 已实现 + 已回滚验证（`--check-patch` 绿） |
| 目标 | 让每条助手回复能回答「谁给的 / 为什么这么答 / 花了多久」，使后台低分可归因 |
| 生成器 | `scripts/d1_migrate.mjs`（`SCHEMA_VERSION` 2 → 3） |
| 产物（禁手改） | `scripts/d1_schema.sql` |
| 新增列 | `messages.intent TEXT DEFAULT 'general_medical'`、`confidence REAL DEFAULT 0`、`kb_hits TEXT DEFAULT '[]'`、`source_refs TEXT DEFAULT '[]'`、`provider TEXT DEFAULT 'rule'`、`latency_ms INTEGER DEFAULT 0` |
| 新增索引 | `idx_messages_intent` / `idx_messages_provider` / `idx_messages_created`（后台分布聚合与首响取数，无索引即全表扫） |
| 代码同步 | `frontend/functions/lib/chat_store.js`（`SCHEMA_VERSION`=3、`ATTRIBUTION_FIELDS`、`PROVIDERS`、`STATS_SQL`、`persistTurnBatch` 写入归因列） |
| 判据 | `frontend/tests/stats_reconcile_guard.mjs`（真跑 SQLite 对账，21/21）、`frontend/tests/d1_persist_guard.mjs`（归因列与补丁成对） |
| **影响面** | 存量 v2 库不受 `CREATE TABLE IF NOT EXISTS` 影响，必须显式升级 |

### 为什么不能直接改 `d1_schema.sql`

它是**构建期产物**，`node scripts/d1_migrate.mjs --check` 做逐字节比对，手改必红、而且会被下一次重生成冲掉。改表的唯一正确入口是改生成器。

### 在线升级（apply）

```bash
# 1) 先看现状：确认这些列还不存在（SQLite 没有 ADD COLUMN IF NOT EXISTS，重复执行会以 duplicate column 报错停下）
wrangler d1 execute <DB> --command "PRAGMA table_info(messages);"
# 2) 取升级语句
node scripts/d1_migrate.mjs --upgrade
# 3) 逐条执行（按输出顺序）
# 4) 复验
wrangler d1 execute <DB> --command "SELECT COUNT(*) AS rows_missing_attr FROM messages WHERE provider IS NULL;"
```

### 回滚（rollback）

```bash
node scripts/d1_migrate.mjs --rollback
```

回滚语句是 `ALTER TABLE messages DROP COLUMN <col>`，**六列分别成对**，`node scripts/d1_migrate.mjs --check-patch` 会校验「每条新增都有回滚」，缺一条即红。

### 双向验证结论（2026-10-04 实测）

| 方向 | 命令 | 结果 |
|---|---|---|
| apply 侧 | `node scripts/d1_migrate.mjs --upgrade` | ✅ 输出 6 条 ALTER（不自动执行，符合「CI 机没有 D1」这一事实） |
| rollback 侧 | `node scripts/d1_migrate.mjs --rollback` | ✅ 输出 6 条 DROP，与 apply 逐列名成对 |
| 成对守卫 | `node scripts/d1_migrate.mjs --check-patch` | ✅ `[GATE:d1-patch-pass]` |
| 真跑验证 | `node frontend/tests/stats_reconcile_guard.mjs` | ✅ 21/21：六列在真实 SQLite 中落存读回、六口径 SQL 与暴力扫描逐项相等 |

### 已知限制（写清楚，不许留默认理解）

- 「已结束」尚未落量表： `conversations` 表仍**没有 `closed_at`**，`getStats` 以「存在 feedback 行」作为代理口径（见 `ENDED_PROXY_NOTE`）。因此**一次解决率继承这个代理，不是真实的会话关闭率**；后续若引入 `closed_at`，须同步改写分母口径并在 `stats_reconcile_guard.mjs` 里补一条同形态对账。
- `latency_ms = 0` 表示**未计量**，不表示「零延迟」；统计时被整体剔除，不得参与均值。
