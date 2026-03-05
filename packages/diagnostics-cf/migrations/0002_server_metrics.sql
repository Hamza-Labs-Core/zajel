-- Server metrics table for VPS push data
-- Each VPS server pushes a snapshot every 60 seconds

CREATE TABLE IF NOT EXISTS server_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  region TEXT,
  timestamp INTEGER NOT NULL,
  connections_total INTEGER NOT NULL,
  connections_relay INTEGER NOT NULL,
  connections_signaling INTEGER NOT NULL,
  entropy_active_codes INTEGER,
  entropy_collision_risk TEXT,
  federation_alive_members INTEGER,
  federation_total_members INTEGER,
  message_rate_per_second REAL,
  message_rate_per_minute REAL,
  cpu_percent REAL,
  memory_mb REAL,
  uptime_seconds INTEGER
);

-- Index for efficient queries by server and time
CREATE INDEX IF NOT EXISTS idx_server_metrics_server_time
  ON server_metrics(server_id, timestamp DESC);
