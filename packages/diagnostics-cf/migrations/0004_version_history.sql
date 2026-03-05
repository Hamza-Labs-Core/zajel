CREATE TABLE IF NOT EXISTS version_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  active_count INTEGER NOT NULL,
  UNIQUE(time_bucket, app_version)
);
CREATE INDEX IF NOT EXISTS idx_version_history_bucket ON version_history(time_bucket);
