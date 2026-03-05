-- Notification records (US-8.1, US-8.2, US-8.3)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER,                    -- NULL for manual/system notifications
  severity TEXT NOT NULL,             -- 'info', 'warning', 'critical'
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'error_rate', 'server_offline', 'attack_detected', etc.
  channels_notified TEXT,             -- JSON array of channels that were notified
  created_at INTEGER NOT NULL,
  read_at INTEGER,                    -- NULL = unread
  read_by TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at, created_at DESC);

-- Notification channel configuration
CREATE TABLE IF NOT EXISTS notification_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_type TEXT NOT NULL UNIQUE,  -- 'email', 'webhook', 'dashboard'
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,               -- JSON blob with channel-specific settings
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
