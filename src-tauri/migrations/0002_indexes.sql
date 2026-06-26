-- Secondary indexes (PLAN §5).
CREATE INDEX IF NOT EXISTS idx_sessions_date_earn ON sessions(local_date, earnings_cents);
