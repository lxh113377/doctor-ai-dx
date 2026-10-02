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
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const OUT = ROOT + "scripts/d1_schema.sql"

export const SCHEMA_VERSION = 1

// 建表顺序按外键依赖排：先被引用者后引用者。
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  handed_off INTEGER NOT NULL DEFAULT 0,
  satisfaction INTEGER
)`,
  `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  redacted_hits TEXT NOT NULL DEFAULT '[]',
  red_flag INTEGER NOT NULL DEFAULT 0,
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
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_events_conv ON intent_events(conversation_id, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_intent_events_intent ON intent_events(intent)`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_score ON feedback(score)`,
]

const HEADER = [
  "-- D1 schema（构建期产物，禁手改）——由 scripts/d1_migrate.mjs 生成，schema_version=1。",
  "-- 对话面持久化：会话 / 消息 / 意图事件 / 转人工 / 满意度反馈。",
  "-- 漂移守卫：node scripts/d1_migrate.mjs --check（逐字节比对，漂移即红）。",
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