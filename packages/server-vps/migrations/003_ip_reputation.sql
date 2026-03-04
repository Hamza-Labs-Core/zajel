-- IP Reputation Tracking
-- Version: 003_ip_reputation
--
-- Persistent storage for IP reputation scores across process restarts.
-- Tracks behavioral events (rate limits, rejections, invalid requests)
-- and accumulates reputation scores with time-based decay.

CREATE TABLE IF NOT EXISTS ip_reputation (
  ip_address TEXT PRIMARY KEY,
  reputation_score INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  total_events INTEGER NOT NULL DEFAULT 0,
  rate_limit_hits INTEGER NOT NULL DEFAULT 0,
  connection_rejects INTEGER NOT NULL DEFAULT 0,
  invalid_requests INTEGER NOT NULL DEFAULT 0,
  successful_attestations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ip_reputation_score ON ip_reputation(reputation_score);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_updated ON ip_reputation(last_updated);

-- Reputation event log (for audit and debugging)
-- Privacy: ip_hash stores a SHA-256 hash of the IP address (not the raw IP).
-- The ip_reputation table stores raw IPs because it is the operational lookup
-- table keyed by IP. The event log is the audit trail and only needs the hash
-- for correlation, satisfying the story's privacy acceptance criterion.
CREATE TABLE IF NOT EXISTS ip_reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL, -- SHA-256 hex hash of IP address (privacy control)
  event_type TEXT NOT NULL, -- 'rate_limit_hit', 'connection_rejected', 'invalid_request', 'successful_attestation'
  points_delta INTEGER NOT NULL, -- Points added/subtracted
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  metadata TEXT, -- JSON string for additional context (must NOT contain raw IPs)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_hash ON ip_reputation_events(ip_hash);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_type ON ip_reputation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_created ON ip_reputation_events(created_at);

-- Update schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (3);
