-- Add gossip latency columns to server_metrics table
-- Tracks RTT percentiles from SWIM gossip protocol failure detector

ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p50_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p95_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_rtt_p99_ms REAL;
ALTER TABLE server_metrics ADD COLUMN gossip_ping_count INTEGER DEFAULT 0;
