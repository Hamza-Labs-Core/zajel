-- Security events table for rate limit violations, connection spikes, and attack indicators
CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,        -- 'rate_limit_violation', 'connection_spike', 'bad_client', 'brute_force_attempt'
  timestamp INTEGER NOT NULL,
  server_id TEXT,
  region TEXT,
  source_ip TEXT,                  -- hashed or anonymized IP
  endpoint TEXT,                   -- e.g., '/diagnostics/report', '/pair'
  details TEXT,                    -- JSON blob with event-specific data
  severity TEXT NOT NULL DEFAULT 'medium',  -- 'low', 'medium', 'high', 'critical'
  count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_security_events_type_ts ON security_events(event_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_ts ON security_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type_ts_ip ON security_events(event_type, timestamp, source_ip);
