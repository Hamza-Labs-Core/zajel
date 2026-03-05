CREATE TABLE IF NOT EXISTS server_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_server_logs_ts ON server_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_server_logs_server ON server_logs(server_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_server_logs_severity ON server_logs(severity, timestamp);
