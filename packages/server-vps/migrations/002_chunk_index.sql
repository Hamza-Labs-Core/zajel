-- Zajel VPS Server Chunk Index Schema
-- Version: 002_chunk_index
--
-- Provides chunk-level caching and source tracking for the channel system.
-- The VPS acts as a relay: caching chunks temporarily and tracking which
-- peers have which chunks so it can pull-on-demand and fan-out to requesters.

-- Cached chunk data (temporary disk cache with TTL + LRU eviction)
CREATE TABLE IF NOT EXISTS chunk_cache (
  chunk_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  data BLOB NOT NULL,
  cached_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_accessed INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_channel ON chunk_cache(channel_id);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_last_accessed ON chunk_cache(last_accessed);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_cached_at ON chunk_cache(cached_at);

-- Which peers have which chunks (source tracking for pull-on-demand)
CREATE TABLE IF NOT EXISTS chunk_sources (
  chunk_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  announced_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),

  PRIMARY KEY (chunk_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_chunk_sources_peer ON chunk_sources(peer_id);
CREATE INDEX IF NOT EXISTS idx_chunk_sources_announced ON chunk_sources(announced_at);

-- Update schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (2);
