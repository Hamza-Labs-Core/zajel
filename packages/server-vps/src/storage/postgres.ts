/**
 * PostgreSQL Storage Implementation
 *
 * Persistent storage using node-postgres (pg) for cloud deployments.
 * Implements the same Storage interface as SQLiteStorage, using
 * PostgreSQL-specific syntax (BYTEA, SERIAL, $N params, RETURNING).
 */

import pg from 'pg';
import type { Pool as PoolType, PoolConfig } from 'pg';
import { createHash } from 'crypto';
import type { Storage, StorageStats, IPReputationEntry } from './interface.js';
import type {
  DailyPointEntry,
  HourlyTokenEntry,
  RelayEntry,
  VectorClock,
  MembershipEntry,
  ServerIdentity,
} from '../types.js';

// Parse BIGINT (OID 20) as number instead of string.
// Safe for millisecond timestamps until year ~287396.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

const { Pool } = pg;

export class PostgresStorage implements Storage {
  private pool: PoolType;

  constructor(connectionString: string, poolConfig?: Partial<PoolConfig>) {
    this.pool = new Pool({
      connectionString,
      max: poolConfig?.max ?? 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env['ZAJEL_PG_SSL'] === 'true'
        ? { rejectUnauthorized: false }
        : undefined,
      ...poolConfig,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Server Identity ──────────────────────────────────

  async saveIdentity(identity: ServerIdentity): Promise<void> {
    await this.pool.query(
      `INSERT INTO server_identity (id, public_key, private_key, ephemeral_id)
       VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         public_key = EXCLUDED.public_key,
         private_key = EXCLUDED.private_key,
         ephemeral_id = EXCLUDED.ephemeral_id`,
      [Buffer.from(identity.publicKey), Buffer.from(identity.privateKey), identity.ephemeralId],
    );
  }

  async loadIdentity(): Promise<ServerIdentity | null> {
    const { rows } = await this.pool.query(
      `SELECT public_key, private_key, ephemeral_id FROM server_identity WHERE id = 1`,
    );
    if (rows.length === 0) return null;

    const row = rows[0];
    const publicKey = new Uint8Array(row.public_key);
    const privateKey = new Uint8Array(row.private_key);
    const serverId = `ed25519:${Buffer.from(publicKey).toString('base64url')}`;

    const { sha256 } = await import('@noble/hashes/sha256');
    const { bytesToHex } = await import('@noble/hashes/utils');
    const hash = sha256(publicKey);
    const nodeId = bytesToHex(hash.slice(0, 20));

    return { serverId, nodeId, ephemeralId: row.ephemeral_id, publicKey, privateKey };
  }

  // ── Daily Points ─────────────────────────────────────

  async saveDailyPoint(entry: DailyPointEntry): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO daily_points (point_hash, peer_id, dead_drop, relay_id, expires_at, created_at, updated_at, vector_clock)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (point_hash, peer_id) DO UPDATE SET
         dead_drop = EXCLUDED.dead_drop,
         relay_id = EXCLUDED.relay_id,
         expires_at = EXCLUDED.expires_at,
         updated_at = EXCLUDED.updated_at,
         vector_clock = EXCLUDED.vector_clock`,
      [entry.pointHash, entry.peerId, entry.deadDrop, entry.relayId,
       entry.expiresAt, entry.createdAt || now, now, JSON.stringify(entry.vectorClock || {})],
    );
  }

  async getDailyPoints(pointHash: string): Promise<DailyPointEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM daily_points WHERE point_hash = $1 AND expires_at > $2`,
      [pointHash, Date.now()],
    );
    return rows.map(mapDailyPoint);
  }

  async getDailyPointsByPeer(peerId: string): Promise<DailyPointEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM daily_points WHERE peer_id = $1 AND expires_at > $2`,
      [peerId, Date.now()],
    );
    return rows.map(mapDailyPoint);
  }

  async deleteDailyPoint(pointHash: string, peerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM daily_points WHERE point_hash = $1 AND peer_id = $2`, [pointHash, peerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteDailyPointsByPeer(peerId: string): Promise<number> {
    const res = await this.pool.query(`DELETE FROM daily_points WHERE peer_id = $1`, [peerId]);
    return res.rowCount ?? 0;
  }

  async deleteExpiredDailyPoints(beforeTimestamp: number): Promise<number> {
    const res = await this.pool.query(`DELETE FROM daily_points WHERE expires_at < $1`, [beforeTimestamp]);
    return res.rowCount ?? 0;
  }

  async getDailyPointStats(): Promise<{ totalEntries: number; uniquePoints: number }> {
    const now = Date.now();
    const total = await this.pool.query(`SELECT COUNT(*) as count FROM daily_points WHERE expires_at > $1`, [now]);
    const unique = await this.pool.query(`SELECT COUNT(DISTINCT point_hash) as count FROM daily_points WHERE expires_at > $1`, [now]);
    return { totalEntries: parseInt(total.rows[0].count), uniquePoints: parseInt(unique.rows[0].count) };
  }

  // ── Hourly Tokens ────────────────────────────────────

  async saveHourlyToken(entry: HourlyTokenEntry): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO hourly_tokens (token_hash, peer_id, relay_id, expires_at, created_at, vector_clock)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token_hash, peer_id) DO UPDATE SET
         relay_id = EXCLUDED.relay_id,
         expires_at = EXCLUDED.expires_at,
         vector_clock = EXCLUDED.vector_clock`,
      [entry.tokenHash, entry.peerId, entry.relayId, entry.expiresAt, entry.createdAt || now, JSON.stringify(entry.vectorClock || {})],
    );
  }

  async getHourlyTokens(tokenHash: string): Promise<HourlyTokenEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM hourly_tokens WHERE token_hash = $1 AND expires_at > $2`, [tokenHash, Date.now()],
    );
    return rows.map(mapHourlyToken);
  }

  async getHourlyTokensByPeer(peerId: string): Promise<HourlyTokenEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM hourly_tokens WHERE peer_id = $1 AND expires_at > $2`, [peerId, Date.now()],
    );
    return rows.map(mapHourlyToken);
  }

  async deleteHourlyToken(tokenHash: string, peerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM hourly_tokens WHERE token_hash = $1 AND peer_id = $2`, [tokenHash, peerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteHourlyTokensByPeer(peerId: string): Promise<number> {
    const res = await this.pool.query(`DELETE FROM hourly_tokens WHERE peer_id = $1`, [peerId]);
    return res.rowCount ?? 0;
  }

  async deleteExpiredHourlyTokens(beforeTimestamp: number): Promise<number> {
    const res = await this.pool.query(`DELETE FROM hourly_tokens WHERE expires_at < $1`, [beforeTimestamp]);
    return res.rowCount ?? 0;
  }

  async getHourlyTokenStats(): Promise<{ totalEntries: number; uniqueTokens: number }> {
    const now = Date.now();
    const total = await this.pool.query(`SELECT COUNT(*) as count FROM hourly_tokens WHERE expires_at > $1`, [now]);
    const unique = await this.pool.query(`SELECT COUNT(DISTINCT token_hash) as count FROM hourly_tokens WHERE expires_at > $1`, [now]);
    return { totalEntries: parseInt(total.rows[0].count), uniqueTokens: parseInt(unique.rows[0].count) };
  }

  // ── Relay Registry ───────────────────────────────────

  async saveRelay(relay: RelayEntry): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO relays (peer_id, max_connections, connected_count, public_key, registered_at, last_update)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (peer_id) DO UPDATE SET
         max_connections = EXCLUDED.max_connections,
         connected_count = EXCLUDED.connected_count,
         public_key = EXCLUDED.public_key,
         last_update = EXCLUDED.last_update`,
      [relay.peerId, relay.maxConnections, relay.connectedCount, relay.publicKey, relay.registeredAt || now, now],
    );
  }

  async getRelay(peerId: string): Promise<RelayEntry | null> {
    const { rows } = await this.pool.query(`SELECT * FROM relays WHERE peer_id = $1`, [peerId]);
    if (rows.length === 0) return null;
    return mapRelay(rows[0]);
  }

  async getAllRelays(): Promise<RelayEntry[]> {
    const { rows } = await this.pool.query(`SELECT * FROM relays`);
    return rows.map(mapRelay);
  }

  async getAvailableRelays(excludePeerId: string, maxCapacityRatio: number, limit: number): Promise<RelayEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM relays
       WHERE peer_id != $1
         AND CAST(connected_count AS REAL) / max_connections < $2
       ORDER BY RANDOM()
       LIMIT $3`,
      [excludePeerId, maxCapacityRatio, limit],
    );
    return rows.map(mapRelay);
  }

  async updateRelayLoad(peerId: string, connectedCount: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE relays SET connected_count = $1, last_update = $2 WHERE peer_id = $3`,
      [connectedCount, Date.now(), peerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteRelay(peerId: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM relays WHERE peer_id = $1`, [peerId]);
    return (res.rowCount ?? 0) > 0;
  }

  // ── Known Servers (Federation) ───────────────────────

  async saveServer(server: MembershipEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO known_servers (server_id, node_id, endpoint, public_key, status, incarnation, last_seen, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (server_id) DO UPDATE SET
         node_id = EXCLUDED.node_id,
         endpoint = EXCLUDED.endpoint,
         public_key = EXCLUDED.public_key,
         status = EXCLUDED.status,
         incarnation = EXCLUDED.incarnation,
         last_seen = EXCLUDED.last_seen,
         metadata = EXCLUDED.metadata`,
      [server.serverId, server.nodeId, server.endpoint, Buffer.from(server.publicKey),
       server.status, server.incarnation, server.lastSeen, JSON.stringify(server.metadata || {})],
    );
  }

  async upsertServer(server: MembershipEntry): Promise<void> {
    await this.saveServer(server);
  }

  async getServer(serverId: string): Promise<MembershipEntry | null> {
    const { rows } = await this.pool.query(`SELECT * FROM known_servers WHERE server_id = $1`, [serverId]);
    if (rows.length === 0) return null;
    return mapServer(rows[0]);
  }

  async getAllServers(): Promise<MembershipEntry[]> {
    const { rows } = await this.pool.query(`SELECT * FROM known_servers`);
    return rows.map(mapServer);
  }

  async getServersByStatus(status: string): Promise<MembershipEntry[]> {
    const { rows } = await this.pool.query(`SELECT * FROM known_servers WHERE status = $1`, [status]);
    return rows.map(mapServer);
  }

  async updateServerStatus(serverId: string, status: string, incarnation: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE known_servers SET status = $1, incarnation = $2, last_seen = $3 WHERE server_id = $4`,
      [status, incarnation, Date.now(), serverId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteServer(serverId: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM known_servers WHERE server_id = $1`, [serverId]);
    return (res.rowCount ?? 0) > 0;
  }

  // ── Membership Snapshot ──────────────────────────────

  async saveMembershipSnapshot(snapshot: object): Promise<void> {
    await this.pool.query(
      `INSERT INTO membership_snapshot (id, snapshot, updated_at)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(snapshot), Date.now()],
    );
  }

  async loadMembershipSnapshot(): Promise<object | null> {
    const { rows } = await this.pool.query(`SELECT snapshot FROM membership_snapshot WHERE id = 1`);
    return rows.length > 0 ? JSON.parse(rows[0].snapshot) as object : null;
  }

  // ── Vector Clocks ────────────────────────────────────

  async saveVectorClock(key: string, clock: VectorClock): Promise<void> {
    await this.pool.query(
      `INSERT INTO vector_clocks (key, clock, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET clock = EXCLUDED.clock, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(clock), Date.now()],
    );
  }

  async getVectorClock(key: string): Promise<VectorClock | null> {
    const { rows } = await this.pool.query(`SELECT clock FROM vector_clocks WHERE key = $1`, [key]);
    return rows.length > 0 ? JSON.parse(rows[0].clock) as VectorClock : null;
  }

  async deleteVectorClock(key: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM vector_clocks WHERE key = $1`, [key]);
    return (res.rowCount ?? 0) > 0;
  }

  // ── Chunk Cache ──────────────────────────────────────

  async cacheChunk(chunkId: string, channelId: string, data: Buffer): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO chunk_cache (chunk_id, channel_id, data, cached_at, last_accessed, access_count)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (chunk_id) DO UPDATE SET
         data = EXCLUDED.data,
         channel_id = EXCLUDED.channel_id,
         cached_at = EXCLUDED.cached_at,
         last_accessed = EXCLUDED.last_accessed,
         access_count = 0`,
      [chunkId, channelId, data, now, now],
    );
  }

  async getCachedChunk(chunkId: string): Promise<{ data: Buffer; channelId: string } | null> {
    const { rows } = await this.pool.query(
      `UPDATE chunk_cache SET last_accessed = $1, access_count = access_count + 1
       WHERE chunk_id = $2
       RETURNING data, channel_id`,
      [Date.now(), chunkId],
    );
    if (rows.length === 0) return null;
    return { data: rows[0].data, channelId: rows[0].channel_id };
  }

  async getCachedChunkIdsByChannel(channelId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT chunk_id FROM chunk_cache WHERE channel_id = $1`, [channelId],
    );
    return rows.map((r: { chunk_id: string }) => r.chunk_id);
  }

  async deleteCachedChunk(chunkId: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM chunk_cache WHERE chunk_id = $1`, [chunkId]);
    return (res.rowCount ?? 0) > 0;
  }

  async cleanupExpiredChunks(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const res = await this.pool.query(`DELETE FROM chunk_cache WHERE cached_at < $1`, [cutoff]);
    return res.rowCount ?? 0;
  }

  async evictLruChunks(maxEntries: number): Promise<number> {
    const countRes = await this.pool.query(`SELECT COUNT(*) as count FROM chunk_cache`);
    const count = parseInt(countRes.rows[0].count);
    if (count <= maxEntries) return 0;

    const toEvict = count - maxEntries;
    const res = await this.pool.query(
      `DELETE FROM chunk_cache WHERE chunk_id IN (
         SELECT chunk_id FROM chunk_cache ORDER BY last_accessed ASC LIMIT $1
       )`, [toEvict],
    );
    return res.rowCount ?? 0;
  }

  async getCachedChunkCount(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) as count FROM chunk_cache`);
    return parseInt(rows[0].count);
  }

  // ── Chunk Sources ────────────────────────────────────

  async saveChunkSource(chunkId: string, peerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chunk_sources (chunk_id, peer_id, announced_at) VALUES ($1, $2, $3)
       ON CONFLICT (chunk_id, peer_id) DO UPDATE SET announced_at = EXCLUDED.announced_at`,
      [chunkId, peerId, Date.now()],
    );
  }

  async getChunkSources(chunkId: string): Promise<Array<{ chunkId: string; peerId: string; announcedAt: number }>> {
    const { rows } = await this.pool.query(
      `SELECT chunk_id, peer_id, announced_at FROM chunk_sources WHERE chunk_id = $1`, [chunkId],
    );
    return rows.map((r: { chunk_id: string; peer_id: string; announced_at: number }) => ({
      chunkId: r.chunk_id, peerId: r.peer_id, announcedAt: r.announced_at,
    }));
  }

  async deleteChunkSourcesByPeer(peerId: string): Promise<number> {
    const res = await this.pool.query(`DELETE FROM chunk_sources WHERE peer_id = $1`, [peerId]);
    return res.rowCount ?? 0;
  }

  async deleteChunkSource(chunkId: string, peerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM chunk_sources WHERE chunk_id = $1 AND peer_id = $2`, [chunkId, peerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async cleanupExpiredChunkSources(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const res = await this.pool.query(`DELETE FROM chunk_sources WHERE announced_at < $1`, [cutoff]);
    return res.rowCount ?? 0;
  }

  // ── IP Reputation ────────────────────────────────────

  async incrementReputation(
    ip: string, points: number, eventType: string, metadata?: Record<string, unknown>,
  ): Promise<number> {
    const now = Date.now();
    const initialScore = Math.max(0, points);

    // Upsert with RETURNING to avoid a second query
    const { rows } = await this.pool.query(
      `INSERT INTO ip_reputation (
         ip_address, reputation_score, last_updated, total_events,
         rate_limit_hits, connection_rejects, invalid_requests, successful_attestations, created_at
       ) VALUES ($1, $2, $3, 1,
         CASE WHEN $4 = 'rate_limit_hit' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'connection_rejected' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'invalid_request' THEN 1 ELSE 0 END,
         CASE WHEN $4 = 'successful_attestation' THEN 1 ELSE 0 END,
         $3
       )
       ON CONFLICT (ip_address) DO UPDATE SET
         reputation_score = GREATEST(0, ip_reputation.reputation_score + $5),
         last_updated = $3,
         total_events = ip_reputation.total_events + 1,
         rate_limit_hits = ip_reputation.rate_limit_hits + CASE WHEN $4 = 'rate_limit_hit' THEN 1 ELSE 0 END,
         connection_rejects = ip_reputation.connection_rejects + CASE WHEN $4 = 'connection_rejected' THEN 1 ELSE 0 END,
         invalid_requests = ip_reputation.invalid_requests + CASE WHEN $4 = 'invalid_request' THEN 1 ELSE 0 END,
         successful_attestations = ip_reputation.successful_attestations + CASE WHEN $4 = 'successful_attestation' THEN 1 ELSE 0 END
       RETURNING reputation_score, total_events`,
      [ip, initialScore, now, eventType, points],
    );

    const scoreAfter = rows[0].reputation_score;
    const scoreBefore = rows[0].total_events > 1 ? scoreAfter - points : 0;

    // Audit log
    const ipHash = createHash('sha256').update(`zajel-rep:${ip}`).digest('hex');
    await this.pool.query(
      `INSERT INTO ip_reputation_events (ip_hash, event_type, points_delta, score_before, score_after, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ipHash, eventType, points, Math.max(0, scoreBefore), scoreAfter, metadata ? JSON.stringify(metadata) : null, now],
    );

    return scoreAfter;
  }

  async getReputation(ip: string): Promise<IPReputationEntry | null> {
    const { rows } = await this.pool.query(`SELECT * FROM ip_reputation WHERE ip_address = $1`, [ip]);
    if (rows.length === 0) return null;
    return mapReputation(rows[0]);
  }

  async getTopOffenders(limit: number): Promise<IPReputationEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ip_reputation ORDER BY reputation_score DESC LIMIT $1`, [limit],
    );
    return rows.map(mapReputation);
  }

  async cleanupOldReputationEvents(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const res = await this.pool.query(`DELETE FROM ip_reputation_events WHERE created_at < $1`, [cutoff]);
    return res.rowCount ?? 0;
  }

  async setReputation(ip: string, score: number): Promise<void> {
    const now = Date.now();
    const safeScore = Math.max(0, score);

    const before = await this.pool.query(
      `SELECT reputation_score FROM ip_reputation WHERE ip_address = $1`, [ip],
    );
    const scoreBefore = before.rows.length > 0 ? before.rows[0].reputation_score : 0;

    await this.pool.query(
      `INSERT INTO ip_reputation (
         ip_address, reputation_score, last_updated, total_events,
         rate_limit_hits, connection_rejects, invalid_requests, successful_attestations, created_at
       ) VALUES ($1, $2, $3, 0, 0, 0, 0, 0, $3)
       ON CONFLICT (ip_address) DO UPDATE SET reputation_score = $2, last_updated = $3`,
      [ip, safeScore, now],
    );

    const ipHash = createHash('sha256').update(`zajel-rep:${ip}`).digest('hex');
    await this.pool.query(
      `INSERT INTO ip_reputation_events (ip_hash, event_type, points_delta, score_before, score_after, metadata, created_at)
       VALUES ($1, 'admin_override', $2, $3, $4, NULL, $5)`,
      [ipHash, safeScore - scoreBefore, scoreBefore, safeScore, now],
    );
  }

  // ── Statistics ───────────────────────────────────────

  async getStats(): Promise<StorageStats> {
    const [daily, hourly, relay, server, dbSize] = await Promise.all([
      this.pool.query(`SELECT COUNT(*) as count FROM daily_points WHERE expires_at > $1`, [Date.now()]),
      this.pool.query(`SELECT COUNT(*) as count FROM hourly_tokens WHERE expires_at > $1`, [Date.now()]),
      this.pool.query(`SELECT COUNT(*) as count FROM relays`),
      this.pool.query(`SELECT COUNT(*) as count FROM known_servers`),
      this.pool.query(`SELECT pg_database_size(current_database()) as size`),
    ]);

    return {
      dailyPoints: parseInt(daily.rows[0].count),
      hourlyTokens: parseInt(hourly.rows[0].count),
      relays: parseInt(relay.rows[0].count),
      servers: parseInt(server.rows[0].count),
      dbSizeBytes: parseInt(dbSize.rows[0].size),
    };
  }
}

// ── Row Mappers ────────────────────────────────────────
// Use bracket notation for index-signature access (tsconfig noPropertyAccessFromIndexSignature)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

function mapDailyPoint(row: Row): DailyPointEntry {
  return {
    id: row['id'],
    pointHash: row['point_hash'],
    peerId: row['peer_id'],
    deadDrop: row['dead_drop'],
    relayId: row['relay_id'],
    expiresAt: row['expires_at'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
    vectorClock: JSON.parse(row['vector_clock']) as VectorClock,
  };
}

function mapHourlyToken(row: Row): HourlyTokenEntry {
  return {
    id: row['id'],
    tokenHash: row['token_hash'],
    peerId: row['peer_id'],
    relayId: row['relay_id'],
    expiresAt: row['expires_at'],
    createdAt: row['created_at'],
    vectorClock: JSON.parse(row['vector_clock']) as VectorClock,
  };
}

function mapRelay(row: Row): RelayEntry {
  return {
    peerId: row['peer_id'],
    maxConnections: row['max_connections'],
    connectedCount: row['connected_count'],
    publicKey: row['public_key'],
    registeredAt: row['registered_at'],
    lastUpdate: row['last_update'],
  };
}

function mapServer(row: Row): MembershipEntry {
  return {
    serverId: row['server_id'],
    nodeId: row['node_id'],
    endpoint: row['endpoint'],
    publicKey: new Uint8Array(row['public_key']),
    status: row['status'],
    incarnation: row['incarnation'],
    lastSeen: row['last_seen'],
    metadata: JSON.parse(row['metadata']),
  };
}

function mapReputation(row: Row): IPReputationEntry {
  return {
    ipAddress: row['ip_address'],
    reputationScore: row['reputation_score'],
    lastUpdated: row['last_updated'],
    totalEvents: row['total_events'],
    rateLimitHits: row['rate_limit_hits'],
    connectionRejects: row['connection_rejects'],
    invalidRequests: row['invalid_requests'],
    successfulAttestations: row['successful_attestations'],
    createdAt: row['created_at'],
  };
}

// ── Schema SQL ─────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS server_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key BYTEA NOT NULL,
  private_key BYTEA NOT NULL,
  ephemeral_id TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS daily_points (
  id SERIAL PRIMARY KEY,
  point_hash TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  dead_drop TEXT,
  relay_id TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  vector_clock TEXT NOT NULL DEFAULT '{}',
  UNIQUE(point_hash, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_points_hash ON daily_points(point_hash);
CREATE INDEX IF NOT EXISTS idx_daily_points_expires ON daily_points(expires_at);
CREATE INDEX IF NOT EXISTS idx_daily_points_peer ON daily_points(peer_id);

CREATE TABLE IF NOT EXISTS hourly_tokens (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  relay_id TEXT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  vector_clock TEXT NOT NULL DEFAULT '{}',
  UNIQUE(token_hash, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_hash ON hourly_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_expires ON hourly_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_hourly_tokens_peer ON hourly_tokens(peer_id);

CREATE TABLE IF NOT EXISTS relays (
  peer_id TEXT PRIMARY KEY,
  max_connections INTEGER NOT NULL DEFAULT 20,
  connected_count INTEGER NOT NULL DEFAULT 0,
  public_key TEXT,
  registered_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  last_update BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_relays_capacity ON relays(connected_count, max_connections);

CREATE TABLE IF NOT EXISTS membership_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS known_servers (
  server_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  incarnation INTEGER NOT NULL DEFAULT 0,
  last_seen BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_known_servers_status ON known_servers(status);
CREATE INDEX IF NOT EXISTS idx_known_servers_node ON known_servers(node_id);

CREATE TABLE IF NOT EXISTS vector_clocks (
  key TEXT PRIMARY KEY,
  clock TEXT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS chunk_cache (
  chunk_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  data BYTEA NOT NULL,
  cached_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  last_accessed BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  access_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_channel ON chunk_cache(channel_id);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_last_accessed ON chunk_cache(last_accessed);
CREATE INDEX IF NOT EXISTS idx_chunk_cache_cached_at ON chunk_cache(cached_at);

CREATE TABLE IF NOT EXISTS chunk_sources (
  chunk_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  announced_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  PRIMARY KEY (chunk_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_chunk_sources_peer ON chunk_sources(peer_id);
CREATE INDEX IF NOT EXISTS idx_chunk_sources_announced ON chunk_sources(announced_at);

CREATE TABLE IF NOT EXISTS ip_reputation (
  ip_address TEXT PRIMARY KEY,
  reputation_score INTEGER NOT NULL DEFAULT 0,
  last_updated BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  total_events INTEGER NOT NULL DEFAULT 0,
  rate_limit_hits INTEGER NOT NULL DEFAULT 0,
  connection_rejects INTEGER NOT NULL DEFAULT 0,
  invalid_requests INTEGER NOT NULL DEFAULT 0,
  successful_attestations INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_score ON ip_reputation(reputation_score);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_updated ON ip_reputation(last_updated);

CREATE TABLE IF NOT EXISTS ip_reputation_events (
  id SERIAL PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  points_delta INTEGER NOT NULL,
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  metadata TEXT,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_hash ON ip_reputation_events(ip_hash);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_type ON ip_reputation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_created ON ip_reputation_events(created_at);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);
INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;
`;
