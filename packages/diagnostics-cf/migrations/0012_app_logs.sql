-- App logs table for Flutter client log uploads
CREATE TABLE IF NOT EXISTS app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_hash TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production',
  timestamp INTEGER NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL DEFAULT 'general',
  message TEXT NOT NULL,
  message_hash TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_app_logs_session ON app_logs(session_hash, timestamp);
CREATE INDEX IF NOT EXISTS idx_app_logs_severity ON app_logs(severity, timestamp);
CREATE INDEX IF NOT EXISTS idx_app_logs_dedup ON app_logs(session_hash, category, message_hash, timestamp);
