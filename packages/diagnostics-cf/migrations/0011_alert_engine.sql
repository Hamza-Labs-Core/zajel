-- Migration 0011: Alert engine enhancements
-- Add is_default flag to alert_rules and delivery tracking to alert_history

ALTER TABLE alert_rules ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

ALTER TABLE alert_history ADD COLUMN delivery_status TEXT DEFAULT 'sent';
ALTER TABLE alert_history ADD COLUMN delivery_error TEXT;

CREATE INDEX IF NOT EXISTS idx_alert_rules_default ON alert_rules(is_default);
CREATE INDEX IF NOT EXISTS idx_alert_history_time ON alert_history(triggered_at DESC);
