CREATE TABLE IF NOT EXISTS connection_type_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket INTEGER NOT NULL,
  connection_type TEXT NOT NULL,
  active_count INTEGER NOT NULL,
  UNIQUE(time_bucket, connection_type)
);
CREATE INDEX IF NOT EXISTS idx_conn_type_history_bucket ON connection_type_history(time_bucket);
