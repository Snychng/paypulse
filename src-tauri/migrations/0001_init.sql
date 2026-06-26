-- PayPulse 薪跳 — initial schema (PLAN §5).
-- local_date is always a LOCAL calendar day (chrono::Local), ISO 'YYYY-MM-DD'.
-- All money is integer cents; all durations integer seconds.

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  start_wall    TEXT NOT NULL,
  end_wall      TEXT,
  local_date    TEXT NOT NULL,            -- a session spanning midnight is split into one row per day
  active_secs   INTEGER NOT NULL DEFAULT 0,
  regular_secs  INTEGER NOT NULL DEFAULT 0,
  overtime_secs INTEGER NOT NULL DEFAULT 0,
  earnings_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_local_date ON sessions(local_date);

CREATE TABLE IF NOT EXISTS day_totals (
  local_date    TEXT PRIMARY KEY,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  active_secs   INTEGER NOT NULL DEFAULT 0,
  overtime_secs INTEGER NOT NULL DEFAULT 0,
  updated_wall  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  monthly_salary_cents      INTEGER NOT NULL DEFAULT 0,
  daily_hours               REAL    NOT NULL DEFAULT 8.0,
  workdays_per_month        INTEGER NOT NULL DEFAULT 22,
  overtime_multiplier_x100  INTEGER NOT NULL DEFAULT 150,   -- 1.5x
  milestones_cents          TEXT    NOT NULL DEFAULT '[]',
  theme                     TEXT    NOT NULL DEFAULT 'system',
  language                  TEXT    NOT NULL DEFAULT 'system',
  currency                  TEXT    NOT NULL DEFAULT 'auto', -- 'auto' follows language (zh→CNY/en→USD)
  notifications_enabled     INTEGER NOT NULL DEFAULT 1,
  autostart_enabled         INTEGER NOT NULL DEFAULT 0,
  windows_icon_number       INTEGER NOT NULL DEFAULT 0,
  transparency_enabled      INTEGER NOT NULL DEFAULT 1,      -- on by default (self-distribute, D5)
  mini_opacity_x100         INTEGER NOT NULL DEFAULT 92,     -- 0.35–1.0 stored ×100
  display_decimals          INTEGER NOT NULL DEFAULT 3       -- hero decimals 0–4 (default 3)
);
INSERT OR IGNORE INTO settings (id) VALUES (1);
