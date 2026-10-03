#!/usr/bin/env node
// D1 schema 迁移：单一 SQL 权威 → scripts/d1_schema.sql，--check 逐字节比对（漂移即红）。
//
// 为什么不用 wrangler d1 migrations：本仓的既有范式是「权威源 + 生成物 + 守卫」（knowledge/red_flag/
// scope/cds/intents 五处都是这个形状）。迁移 SQL 也按这个形状做，好处是干净检出后无需云账号
// 就能验证 schema 与代码里的查询语句是否对得上——CI 里没有 D1，只有文件。
//
// 用法：
//   node scripts/d1_migrate.mjs            写盘 scripts/d1_schema.sql
//   node scripts/d1_migrate.mjs --check     只校验不写盘，漂移 exit 1
//   node scripts/d1_migrate.mjs --print     打印 SQL（配合 wrangler d1 execute 使用）
//   node scripts/d1_migrate.mjs --upgrade   打印 v2→v3 的 ALTER 语句（不自动执行，见 MIGRATIONS 注释）
//   node scripts/d1_migrate.mjs --rollback  打印 v3→v2 的回滚语句
//   node scripts/d1_migrate.mjs --check-patch  校验「每条升级都有成对回滚」+ schema 内归因列齐备
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const OUT = ROOT + "scripts/d1_schema.sql"

export const SCHEMA_VERSION = 3

/**
 * v2 → v3 的在线升级语句（补丁账本三件套的「实现」那一半）。
 *
 * 为什么不能直接把列加进 CREATE TABLE 就了事：`CREATE TABLE IF NOT EXISTS` 对**已存在的库**是空操作，
 * 线上 v2 实例永远不会因此长出归因列。而 SQLite 没有 `ADD COLUMN IF NOT EXISTS`，
 * 所以幂等由**运维执行前的 PRAGMA table_info 核对**保证，
 * 每条 ALTER 前先确认列不存在，重复执行会因 duplicate column name 报错而停下（这是要的失败形态，
 * 不是静默覆盖）。
 *
 * 回滚在本 file 的 ROLLBACKS 里成对给出，**每条 upgrade 必须有回得去的 rollback**，
 * 否则这条补丁不许上线（见 scripts/chat_patch_ledger.md）。
 */
export const MIGRATIONS = [
  "ALTER TABLE messages ADD COLUMN intent TEXT DEFAULT 'general_medical';",
  "ALTER TABLE messages ADD COLUMN confidence REAL DEFAULT 0;",
  "ALTER TABLE messages ADD COLUMN kb_hits TEXT DEFAULT '[]';",
  "ALTER TABLE messages ADD COLUMN source_refs TEXT DEFAULT '[]';",
  "ALTER TABLE messages ADD COLUMN provider TEXT DEFAULT 'rule';",
  "ALTER TABLE messages ADD COLUMN latency_ms INTEGER DEFAULT 0;",
]

export const ROLLBACKS = [
  "ALTER TABLE messages DROP COLUMN latency_ms;",
  "ALTER TABLE messages DROP COLUMN provider;",
  "ALTER TABLE messages DROP COLUMN source_refs;",
  "ALTER TABLE messages DROP COLUMN kb_hits;",
  "ALTER TABLE messages DROP COLUMN confidence;",
  "ALTER TABLE messages DROP COLUMN intent;",
]

// 建表顺序按外键依赖排：先被引用者后引用者。
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  handed_off INTEGER NOT NULL DEFAULT 0,
  satisfaction INTEGER,
  expires_at TEXT
)`,
  // r96 v3：消息行补六个归因列，回答「这条回答是谁给的 / 为什么这么答 / 花了多久」。
  // 没有它们，后台的低分只能看到「不满意」，永远无法归因到 provider 或延迟。
  `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  redacted_hits TEXT NOT NULL DEFAULT '[]',
  red_flag INTEGER NOT NULL DEFAULT 0,
  intent TEXT DEFAULT 'general_medical',
  confidence REAL DEFAULT 0,
  kb_hits TEXT DEFAULT '[]',
  source_refs TEXT DEFAULT '[]',
  provider TEXT DEFAULT 'rule',
  latency_ms INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS intent_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  matched TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL DEFAULT '',
  context_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','closed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
)`,
  `CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  tag TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
)`,
  // 列表默认按 updated_at 倒序、转人工队列按 (status, created_at) 排 —— 无索引就是全表扫。
  `CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`,
  // r91（S10）TTL：过期清理按 expires_at 扫（见 scripts/d1_cleanup.mjs）。
  `CREATE INDEX IF NOT EXISTS idx_conversations_expires ON conversations(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_events_conv ON intent_events(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_events_intent ON intent_events(intent)`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_score ON feedback(score)`,
  // r96 v3：后台六口径统计要走的三个索引。意图分布/ provider 分布是 GROUP BY 全表聚合，
  // 没索引就是每看一次后台扫一遍全表；首响按 created_at 排序取值同理。
  `CREATE INDEX IF NOT EXISTS idx_messages_intent ON messages(intent)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at ASC)`,
]

const HEADER = [
  `-- D1 schema（构建期产物，禁手改）——由 scripts/d1_migrate.mjs 生成，schema_version=${SCHEMA_VERSION}。`,
  "-- 对话面持久化：会话 / 消息 / 意图事件 / 转人工 / 满意度反馈。",
  "-- TTL（r91 S10）：conversations.expires_at 到期由 scripts/d1_cleanup.mjs 清理（级联删消息/事件/工单/反馈）；",
  "--   v1 时代的存量行 expires_at 为 NULL，视为不过期（不静默删旧数据），需清理由运维显式回填。",
  "-- 漂移守卫：node scripts/d1_migrate.mjs --check（逐字节比对，漂移即红）。",
  "-- r96 v3：messages 增六列归因字段（intent/confidence/kb_hits/source_refs/provider/latency_ms）；",
  "--   存量 v2 库不受 CREATE TABLE 影响，需显式跑 `node scripts/d1_migrate.mjs --upgrade` 取 ALTER 语句，",
  "--   登记与回滚见 scripts/chat_patch_ledger.md。",
  "",
  "PRAGMA foreign_keys = ON;",
  "",
].join("\n")

export function buildSql() {
  return HEADER + STATEMENTS.map((s) => s + ";").join("\n\n") + "\n"
}

function main() {
  const argv = process.argv.slice(2)
  const want = buildSql()
  if (argv.includes("--print")) {
    process.stdout.write(want)
    return 0
  }
  // 补丁账本的执行面：把在线升级/回滚语句打到 stdout，由运维喂给 wrangler d1 execute。
  // 刻意**不自动执行**：本项目 CI/CI 机没有 D1，脚本碰不到线上库，自动执行只会给人「已迁移」的错觉。
  if (argv.includes("--upgrade")) {
    process.stdout.write(`-- v2 → v3 升级（执行前先跑 PRAGMA table_info(messages) 核对列是否已存在）\n${MIGRATIONS.join("\n")}\n`)
    return 0
  }
  if (argv.includes("--rollback")) {
    process.stdout.write(`-- v3 → v2 回滚（按 chat_patch_ledger.md 的执行顺序，逐条执行）\n${ROLLBACKS.join("\n")}\n`)
    return 0
  }
  if (argv.includes("--check-patch")) {
    // 每条升级语句必须有对应的回滚：漏一条回滚的补丁不许上线。
    const upCols = MIGRATIONS.map((s) => /ADD COLUMN (\w+)/.exec(s)?.[1]).filter(Boolean)
    const downCols = ROLLBACKS.map((s) => /DROP COLUMN (\w+)/.exec(s)?.[1]).filter(Boolean)
    const missingRollback = upCols.filter((c) => !downCols.includes(c))
    if (missingRollback.length) {
      console.error(`[GATE:d1-patch-fail] 以下新增列没有回滚语句：${missingRollback.join("/")}`)
      return 1
    }
    const schemaCols = (want.match(/^\s+(intent|confidence|kb_hits|source_refs|provider|latency_ms)\s/gm) || []).length
    if (schemaCols < 6) {
      console.error(`[GATE:d1-patch-fail] schema 里的归因列只有 ${schemaCols} 个（应 6）`)
      return 1
    }
    console.log(`[GATE:d1-patch-pass] ${upCols.length} 列均有成对回滚，且 schema 内归因列齐备`)
    return 0
  }
  if (argv.includes("--check")) {
    let have = ""
    try { have = readFileSync(OUT, "utf8") } catch { have = "" }
    if (have !== want) {
      console.error(`[GATE:d1-schema-fail] scripts/d1_schema.sql 与生成结果不一致（生成 ${want.split("\n").length} 行 / 盘上 ${have.split("\n").length} 行）—— 跑 node scripts/d1_migrate.mjs 重建`)
      return 1
    }
    console.log(`[GATE:d1-schema-pass] schema v${SCHEMA_VERSION} 逐字节一致（statements=${STATEMENTS.length}）`)
    return 0
  }
  writeFileSync(OUT, want, "utf8")
  console.log(`generated: scripts/d1_schema.sql（${STATEMENTS.length} 条语句，schema_version=${SCHEMA_VERSION}）`)
  return 0
}

process.exit(main())