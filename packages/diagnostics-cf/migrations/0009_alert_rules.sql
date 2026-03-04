-- Migration 0009: Alert Rules and Alert History tables
-- Supports US-8.4 Alert Rule Management

CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  condition_type TEXT NOT NULL,       -- 'error_rate', 'server_offline', 'attack_detected', 'ai_issue', 'error_spike', 'rate_limit_violations'
  threshold_value REAL,
  threshold_unit TEXT,                -- 'per_hour', 'minutes', 'multiplier'
  severity TEXT NOT NULL,             -- 'info', 'warning', 'critical'
  channels TEXT NOT NULL,             -- JSON array: ['dashboard', 'email', 'webhook']
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_minutes INTEGER DEFAULT 60,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_triggered_at INTEGER
);

CREATE TABLE alert_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  triggered_at INTEGER NOT NULL,
  message TEXT NOT NULL,
  channels_notified TEXT NOT NULL,    -- JSON array
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);

CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled, created_at DESC);
CREATE INDEX idx_alert_history_rule ON alert_history(rule_id, triggered_at DESC);
