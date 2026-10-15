-- MySQL schema（构建期产物，禁手改）——由 scripts/mysql_schema.py 从 backend/app/db/models.py 生成。
-- 权威源 = ORM metadata；漂移守卫 = python scripts/mysql_schema.py --check（逐字节比对，漂移即红）；
-- 与 D1 单源的结构对账 = python scripts/mysql_schema.py --parity。
-- 会话面（conversations/messages/intent_events/handoffs/feedback）的表名列名与 scripts/d1_schema.sql 全等；
-- 刻意不同的地方只在 models.py 的 dialect_divergence() 名册里逐条登记，名册之外的差异一律判红。

-- 顺序 = 会话面 → 语料面 → 评测面（backend/app/db/models.py 的三个 *_FACE 常量）

CREATE TABLE conversations (
	id VARCHAR(191) NOT NULL, 
	created_at VARCHAR(32) NOT NULL, 
	updated_at VARCHAR(32) NOT NULL, 
	turn_count INTEGER NOT NULL, 
	handed_off INTEGER NOT NULL, 
	satisfaction INTEGER, 
	expires_at VARCHAR(32), 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE messages (
	id VARCHAR(191) NOT NULL, 
	conversation_id VARCHAR(191) NOT NULL, 
	`role` VARCHAR(16) NOT NULL, 
	content TEXT NOT NULL, 
	redacted_hits TEXT NOT NULL, 
	red_flag INTEGER NOT NULL, 
	intent VARCHAR(64), 
	confidence FLOAT, 
	kb_hits TEXT, 
	source_refs TEXT, 
	provider VARCHAR(32), 
	latency_ms INTEGER, 
	created_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_messages_role CHECK (role IN ('user','assistant')), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE intent_events (
	id VARCHAR(191) NOT NULL, 
	conversation_id VARCHAR(191) NOT NULL, 
	intent VARCHAR(64) NOT NULL, 
	confidence FLOAT NOT NULL, 
	matched TEXT NOT NULL, 
	created_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE handoffs (
	id VARCHAR(191) NOT NULL, 
	conversation_id VARCHAR(191) NOT NULL, 
	reason_code VARCHAR(64) NOT NULL, 
	reason_text TEXT NOT NULL, 
	context_digest TEXT NOT NULL, 
	status VARCHAR(16) NOT NULL, 
	created_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_handoffs_status CHECK (status IN ('open','assigned','closed')), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE feedback (
	id VARCHAR(191) NOT NULL, 
	conversation_id VARCHAR(191) NOT NULL, 
	score INTEGER NOT NULL, 
	tag VARCHAR(64) NOT NULL, 
	comment TEXT NOT NULL, 
	created_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_feedback_score CHECK (score BETWEEN 1 AND 5), 
	CONSTRAINT uq_feedback_conversation UNIQUE (conversation_id), 
	FOREIGN KEY(conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE corpus_entries (
	source_file VARCHAR(64) NOT NULL, 
	entry_key VARCHAR(191) NOT NULL, 
	seq INTEGER NOT NULL, 
	title VARCHAR(255), 
	payload TEXT(16777215) NOT NULL, 
	payload_sha256 VARCHAR(64) NOT NULL, 
	corpus_sha256 VARCHAR(64) NOT NULL, 
	loaded_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (source_file, entry_key, seq)
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE eval_reports (
	run_id VARCHAR(191) NOT NULL, 
	report_file VARCHAR(191) NOT NULL, 
	report_sha256 VARCHAR(64) NOT NULL, 
	report_date VARCHAR(32), 
	base VARCHAR(191), 
	case_count INTEGER NOT NULL, 
	summary TEXT(16777215) NOT NULL, 
	created_at VARCHAR(32) NOT NULL, 
	PRIMARY KEY (run_id), 
	CONSTRAINT uq_eval_report_identity UNIQUE (report_file, report_sha256)
)ENGINE=InnoDB CHARSET=utf8mb4;

CREATE TABLE eval_case_modes (
	run_id VARCHAR(191) NOT NULL, 
	case_id VARCHAR(191) NOT NULL, 
	mode VARCHAR(32) NOT NULL, 
	abstain INTEGER NOT NULL, 
	cause VARCHAR(191), 
	has_cause_field INTEGER NOT NULL, 
	PRIMARY KEY (run_id, case_id), 
	FOREIGN KEY(run_id) REFERENCES eval_reports (run_id) ON DELETE CASCADE
)ENGINE=InnoDB CHARSET=utf8mb4;
