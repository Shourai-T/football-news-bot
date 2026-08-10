CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  published_at TEXT,
  excerpt TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE scheduled_runs (
  slot_key TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('running', 'no_candidate', 'draft_sent', 'failed')),
  gemini_requests INTEGER NOT NULL DEFAULT 0 CHECK (gemini_requests BETWEEN 0 AND 1),
  error_summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE daily_usage (
  local_date TEXT PRIMARY KEY,
  gemini_requests INTEGER NOT NULL CHECK (gemini_requests BETWEEN 0 AND 5)
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  body TEXT NOT NULL,
  telegram_message_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE INDEX drafts_status_idx ON drafts(status, created_at);
