-- Zajel Diagnostics D1 Schema
-- Aggregate tables for error, performance, and network metrics

CREATE TABLE IF NOT EXISTS error_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  error_signature TEXT NOT NULL,
  category TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  sample_message TEXT,
  sample_stack_trace TEXT,
  UNIQUE(time_bucket, error_signature, app_version, platform)
);

CREATE TABLE IF NOT EXISTS performance_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  p50 REAL,
  p95 REAL,
  p99 REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(time_bucket, platform, app_version, metric_name)
);

CREATE TABLE IF NOT EXISTS network_aggregates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_bucket TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  signaling_success_count INTEGER DEFAULT 0,
  signaling_failure_count INTEGER DEFAULT 0,
  webrtc_success_count INTEGER DEFAULT 0,
  webrtc_failure_count INTEGER DEFAULT 0,
  relay_usage_count INTEGER DEFAULT 0,
  direct_p2p_count INTEGER DEFAULT 0,
  avg_latency_ms REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(time_bucket, platform, app_version)
);

CREATE TABLE IF NOT EXISTS client_heartbeats (
  session_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  connection_type TEXT,
  region TEXT,
  last_seen INTEGER NOT NULL,
  session_start INTEGER NOT NULL
);
