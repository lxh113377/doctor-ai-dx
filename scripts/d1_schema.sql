-- D1 schema（构建期产物，禁手改）——由 scripts/d1_migrate.mjs 生成，schema_version=2。
-- 对话面持久化：会话 / 消息 / 意图事件 / 转人工 / 满意度反馈。
-- TTL（r91 S10）：conversations.expires_at 到期由 scripts/d1_cleanup.mjs 清理（级联删消息/事件/工单/反馈）；
--   v1 时代的存量行 expires_at 为 NULL，视为不过期（不静默删旧数据），需清理由运维显式回填。
-- 漂移守卫：node scripts/d1_migrate.mjs --check（逐字节比对，漂移即红）。

PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0,
  handed_off INTEGER NOT NULL DEFAULT 0,
  satisfaction INTEGER,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  redacted_hits TEXT NOT NULL DEFAULT '[]',
  red_flag INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intent_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  matched TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL DEFAULT '',
  context_digest TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','closed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  tag TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_expires ON conversations(expires_at);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_intent_events_conv ON intent_events(conversation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_intent_events_intent ON intent_events(intent);

CREATE INDEX IF NOT EXISTS idx_handoffs_status ON handoffs(status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_feedback_score ON feedback(score);
