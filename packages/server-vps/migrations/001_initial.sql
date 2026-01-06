-- Zajel VPS Server Database Schema
-- Version: 001_initial

-- Server identity (singleton - only one row)
CREATE TABLE IF NOT EXISTS server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key BLOB NOT NULL,
  private_key BLOB NOT NULL,
  ephemeral_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Daily meeting points for peer discovery
CREATE TABLE IF NOT EXISTS daily_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_hash TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  dead_drop TEXT,
  relay_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  vector_clock TEXT NOT NULL DEFAULT '{}',

  UNIQUE(point_hash, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_points_hash ON daily_points(point_hash);
CREATE INDEX IF NOT EXISTS idx_daily_points_expires ON daily_points(expires_at);
CREATE INDEX IF NOT EXISTS idx_daily_points_peer ON daily_points(peer_id);

-- Hourly tokens for live peer matching
CREATE TABLE IF NOT EXISTS hourly_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  relay_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  vector_clock TEXT NOT NULL DEFAULT '{}',

  UNIQUE(token_hash, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_hash ON hourly_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_expires ON hourly_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_peer ON hourly_tokens(peer_id);

-- Local relay registry (peers using this server as relay)
CREATE TABLE IF NOT EXISTS relays (
  peer_id TEXT PRIMARY KEY,
  max_connections INTEGER NOT NULL DEFAULT 20,
  connected_count INTEGER NOT NULL DEFAULT 0,
  public_key TEXT,
  registered_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_update INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_relays_capacity ON relays(connected_count, max_connections);

-- Federation membership snapshot (for recovery after restart)
CREATE TABLE IF NOT EXISTS membership_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Known servers in the federation
CREATE TABLE IF NOT EXISTS known_servers (
  server_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  public_key BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  incarnation INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_known_servers_status ON known_servers(status);
CREATE INDEX IF NOT EXISTS idx_known_servers_node ON known_servers(node_id);

-- Vector clocks for conflict resolution
CREATE TABLE IF NOT EXISTS vector_clocks (
  key TEXT PRIMARY KEY,
  clock TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Insert initial schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
