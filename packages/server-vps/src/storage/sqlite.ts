/**
 * SQLite Storage Implementation
 *
 * Persistent storage using better-sqlite3 for all server data.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import type { Storage, StorageStats } from './interface.js';
import type {
  DailyPointEntry,
  HourlyTokenEntry,
  RelayEntry,
  VectorClock,
  MembershipEntry,
  ServerIdentity,
} from '../types.js';

export class SQLiteStorage implements Storage {
  private db: Database.Database;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async init(): Promise<void> {
    // Run migrations using Database.prototype.exec for SQL execution
    const migrationsDir = join(dirname(new URL(import.meta.url).pathname), '../../migrations');

    const migrations = [
      '001_initial.sql',
      '002_chunk_index.sql',
    ];

    for (const migration of migrations) {
      const migrationFile = join(migrationsDir, migration);
      if (existsSync(migrationFile)) {
        const sql = readFileSync(migrationFile, 'utf-8');
        // Note: This is better-sqlite3's exec method for SQL, not child_process exec
        this.db.exec(sql);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // Server Identity
  async saveIdentity(identity: ServerIdentity): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO server_identity (id, public_key, private_key, ephemeral_id)
      VALUES (1, ?, ?, ?)
    `);
    stmt.run(
      Buffer.from(identity.publicKey),
      Buffer.from(identity.privateKey),
      identity.ephemeralId
    );
  }

  async loadIdentity(): Promise<ServerIdentity | null> {
    const stmt = this.db.prepare(`SELECT * FROM server_identity WHERE id = 1`);
    const row = stmt.get() as {
      public_key: Buffer;
      private_key: Buffer;
      ephemeral_id: string;
    } | undefined;

    if (!row) return null;

    const publicKey = new Uint8Array(row.public_key);
    const privateKey = new Uint8Array(row.private_key);
    const serverId = `ed25519:${row.public_key.toString('base64')}`;

    // Compute node ID from public key
    const { sha256 } = await import('@noble/hashes/sha256');
    const { bytesToHex } = await import('@noble/hashes/utils');
    const hash = sha256(publicKey);
    const nodeId = bytesToHex(hash.slice(0, 20));

    return {
      serverId,
      nodeId,
      ephemeralId: row.ephemeral_id,
      publicKey,
      privateKey,
    };
  }

  // Daily Points
  async saveDailyPoint(entry: DailyPointEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO daily_points (point_hash, peer_id, dead_drop, relay_id, expires_at, created_at, updated_at, vector_clock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(point_hash, peer_id) DO UPDATE SET
        dead_drop = excluded.dead_drop,
        relay_id = excluded.relay_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at,
        vector_clock = excluded.vector_clock
    `);

    const now = Date.now();
    stmt.run(
      entry.pointHash,
      entry.peerId,
      entry.deadDrop,
      entry.relayId,
      entry.expiresAt,
      entry.createdAt || now,
      now,
      JSON.stringify(entry.vectorClock || {})
    );
  }

  async getDailyPoints(pointHash: string): Promise<DailyPointEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM daily_points
      WHERE point_hash = ? AND expires_at > ?
    `);
    const rows = stmt.all(pointHash, Date.now()) as Array<{
      id: number;
      point_hash: string;
      peer_id: string;
      dead_drop: string | null;
      relay_id: string | null;
      expires_at: number;
      created_at: number;
      updated_at: number;
      vector_clock: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      pointHash: row.point_hash,
      peerId: row.peer_id,
      deadDrop: row.dead_drop,
      relayId: row.relay_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
    }));
  }

  async getDailyPointsByPeer(peerId: string): Promise<DailyPointEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM daily_points
      WHERE peer_id = ? AND expires_at > ?
    `);
    const rows = stmt.all(peerId, Date.now()) as Array<{
      id: number;
      point_hash: string;
      peer_id: string;
      dead_drop: string | null;
      relay_id: string | null;
      expires_at: number;
      created_at: number;
      updated_at: number;
      vector_clock: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      pointHash: row.point_hash,
      peerId: row.peer_id,
      deadDrop: row.dead_drop,
      relayId: row.relay_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
    }));
  }

  async deleteDailyPoint(pointHash: string, peerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM daily_points WHERE point_hash = ? AND peer_id = ?`);
    const result = stmt.run(pointHash, peerId);
    return result.changes > 0;
  }

  async deleteDailyPointsByPeer(peerId: string): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM daily_points WHERE peer_id = ?`);
    const result = stmt.run(peerId);
    return result.changes;
  }

  async deleteExpiredDailyPoints(beforeTimestamp: number): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM daily_points WHERE expires_at < ?`);
    const result = stmt.run(beforeTimestamp);
    return result.changes;
  }

  async getDailyPointStats(): Promise<{ totalEntries: number; uniquePoints: number }> {
    const totalStmt = this.db.prepare(`SELECT COUNT(*) as count FROM daily_points WHERE expires_at > ?`);
    const uniqueStmt = this.db.prepare(`SELECT COUNT(DISTINCT point_hash) as count FROM daily_points WHERE expires_at > ?`);
    const now = Date.now();

    const total = totalStmt.get(now) as { count: number };
    const unique = uniqueStmt.get(now) as { count: number };

    return {
      totalEntries: total.count,
      uniquePoints: unique.count,
    };
  }

  // Hourly Tokens
  async saveHourlyToken(entry: HourlyTokenEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO hourly_tokens (token_hash, peer_id, relay_id, expires_at, created_at, vector_clock)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_hash, peer_id) DO UPDATE SET
        relay_id = excluded.relay_id,
        expires_at = excluded.expires_at,
        vector_clock = excluded.vector_clock
    `);

    const now = Date.now();
    stmt.run(
      entry.tokenHash,
      entry.peerId,
      entry.relayId,
      entry.expiresAt,
      entry.createdAt || now,
      JSON.stringify(entry.vectorClock || {})
    );
  }

  async getHourlyTokens(tokenHash: string): Promise<HourlyTokenEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM hourly_tokens
      WHERE token_hash = ? AND expires_at > ?
    `);
    const rows = stmt.all(tokenHash, Date.now()) as Array<{
      id: number;
      token_hash: string;
      peer_id: string;
      relay_id: string | null;
      expires_at: number;
      created_at: number;
      vector_clock: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      tokenHash: row.token_hash,
      peerId: row.peer_id,
      relayId: row.relay_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
    }));
  }

  async getHourlyTokensByPeer(peerId: string): Promise<HourlyTokenEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM hourly_tokens
      WHERE peer_id = ? AND expires_at > ?
    `);
    const rows = stmt.all(peerId, Date.now()) as Array<{
      id: number;
      token_hash: string;
      peer_id: string;
      relay_id: string | null;
      expires_at: number;
      created_at: number;
      vector_clock: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      tokenHash: row.token_hash,
      peerId: row.peer_id,
      relayId: row.relay_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      vectorClock: JSON.parse(row.vector_clock) as VectorClock,
    }));
  }

  async deleteHourlyToken(tokenHash: string, peerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM hourly_tokens WHERE token_hash = ? AND peer_id = ?`);
    const result = stmt.run(tokenHash, peerId);
    return result.changes > 0;
  }

  async deleteHourlyTokensByPeer(peerId: string): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM hourly_tokens WHERE peer_id = ?`);
    const result = stmt.run(peerId);
    return result.changes;
  }

  async deleteExpiredHourlyTokens(beforeTimestamp: number): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM hourly_tokens WHERE expires_at < ?`);
    const result = stmt.run(beforeTimestamp);
    return result.changes;
  }

  async getHourlyTokenStats(): Promise<{ totalEntries: number; uniqueTokens: number }> {
    const totalStmt = this.db.prepare(`SELECT COUNT(*) as count FROM hourly_tokens WHERE expires_at > ?`);
    const uniqueStmt = this.db.prepare(`SELECT COUNT(DISTINCT token_hash) as count FROM hourly_tokens WHERE expires_at > ?`);
    const now = Date.now();

    const total = totalStmt.get(now) as { count: number };
    const unique = uniqueStmt.get(now) as { count: number };

    return {
      totalEntries: total.count,
      uniqueTokens: unique.count,
    };
  }

  // Relay Registry
  async saveRelay(relay: RelayEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO relays (peer_id, max_connections, connected_count, public_key, registered_at, last_update)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        max_connections = excluded.max_connections,
        connected_count = excluded.connected_count,
        public_key = excluded.public_key,
        last_update = excluded.last_update
    `);

    const now = Date.now();
    stmt.run(
      relay.peerId,
      relay.maxConnections,
      relay.connectedCount,
      relay.publicKey,
      relay.registeredAt || now,
      now
    );
  }

  async getRelay(peerId: string): Promise<RelayEntry | null> {
    const stmt = this.db.prepare(`SELECT * FROM relays WHERE peer_id = ?`);
    const row = stmt.get(peerId) as {
      peer_id: string;
      max_connections: number;
      connected_count: number;
      public_key: string | null;
      registered_at: number;
      last_update: number;
    } | undefined;

    if (!row) return null;

    return {
      peerId: row.peer_id,
      maxConnections: row.max_connections,
      connectedCount: row.connected_count,
      publicKey: row.public_key,
      registeredAt: row.registered_at,
      lastUpdate: row.last_update,
    };
  }

  async getAllRelays(): Promise<RelayEntry[]> {
    const stmt = this.db.prepare(`SELECT * FROM relays`);
    const rows = stmt.all() as Array<{
      peer_id: string;
      max_connections: number;
      connected_count: number;
      public_key: string | null;
      registered_at: number;
      last_update: number;
    }>;

    return rows.map(row => ({
      peerId: row.peer_id,
      maxConnections: row.max_connections,
      connectedCount: row.connected_count,
      publicKey: row.public_key,
      registeredAt: row.registered_at,
      lastUpdate: row.last_update,
    }));
  }

  async getAvailableRelays(excludePeerId: string, maxCapacityRatio: number, limit: number): Promise<RelayEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM relays
      WHERE peer_id != ?
        AND CAST(connected_count AS REAL) / max_connections < ?
      ORDER BY RANDOM()
      LIMIT ?
    `);

    const rows = stmt.all(excludePeerId, maxCapacityRatio, limit) as Array<{
      peer_id: string;
      max_connections: number;
      connected_count: number;
      public_key: string | null;
      registered_at: number;
      last_update: number;
    }>;

    return rows.map(row => ({
      peerId: row.peer_id,
      maxConnections: row.max_connections,
      connectedCount: row.connected_count,
      publicKey: row.public_key,
      registeredAt: row.registered_at,
      lastUpdate: row.last_update,
    }));
  }

  async updateRelayLoad(peerId: string, connectedCount: number): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE relays SET connected_count = ?, last_update = ? WHERE peer_id = ?
    `);
    const result = stmt.run(connectedCount, Date.now(), peerId);
    return result.changes > 0;
  }

  async deleteRelay(peerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM relays WHERE peer_id = ?`);
    const result = stmt.run(peerId);
    return result.changes > 0;
  }

  // Known Servers
  async saveServer(server: MembershipEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO known_servers (server_id, node_id, endpoint, public_key, status, incarnation, last_seen, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        node_id = excluded.node_id,
        endpoint = excluded.endpoint,
        public_key = excluded.public_key,
        status = excluded.status,
        incarnation = excluded.incarnation,
        last_seen = excluded.last_seen,
        metadata = excluded.metadata
    `);

    stmt.run(
      server.serverId,
      server.nodeId,
      server.endpoint,
      Buffer.from(server.publicKey),
      server.status,
      server.incarnation,
      server.lastSeen,
      JSON.stringify(server.metadata || {})
    );
  }

  async upsertServer(server: MembershipEntry): Promise<void> {
    // upsertServer is the same as saveServer since we use ON CONFLICT DO UPDATE
    await this.saveServer(server);
  }

  async getServer(serverId: string): Promise<MembershipEntry | null> {
    const stmt = this.db.prepare(`SELECT * FROM known_servers WHERE server_id = ?`);
    const row = stmt.get(serverId) as {
      server_id: string;
      node_id: string;
      endpoint: string;
      public_key: Buffer;
      status: string;
      incarnation: number;
      last_seen: number;
      metadata: string;
    } | undefined;

    if (!row) return null;

    return {
      serverId: row.server_id,
      nodeId: row.node_id,
      endpoint: row.endpoint,
      publicKey: new Uint8Array(row.public_key),
      status: row.status as MembershipEntry['status'],
      incarnation: row.incarnation,
      lastSeen: row.last_seen,
      metadata: JSON.parse(row.metadata),
    };
  }

  async getAllServers(): Promise<MembershipEntry[]> {
    const stmt = this.db.prepare(`SELECT * FROM known_servers`);
    const rows = stmt.all() as Array<{
      server_id: string;
      node_id: string;
      endpoint: string;
      public_key: Buffer;
      status: string;
      incarnation: number;
      last_seen: number;
      metadata: string;
    }>;

    return rows.map(row => ({
      serverId: row.server_id,
      nodeId: row.node_id,
      endpoint: row.endpoint,
      publicKey: new Uint8Array(row.public_key),
      status: row.status as MembershipEntry['status'],
      incarnation: row.incarnation,
      lastSeen: row.last_seen,
      metadata: JSON.parse(row.metadata),
    }));
  }

  async getServersByStatus(status: string): Promise<MembershipEntry[]> {
    const stmt = this.db.prepare(`SELECT * FROM known_servers WHERE status = ?`);
    const rows = stmt.all(status) as Array<{
      server_id: string;
      node_id: string;
      endpoint: string;
      public_key: Buffer;
      status: string;
      incarnation: number;
      last_seen: number;
      metadata: string;
    }>;

    return rows.map(row => ({
      serverId: row.server_id,
      nodeId: row.node_id,
      endpoint: row.endpoint,
      publicKey: new Uint8Array(row.public_key),
      status: row.status as MembershipEntry['status'],
      incarnation: row.incarnation,
      lastSeen: row.last_seen,
      metadata: JSON.parse(row.metadata),
    }));
  }

  async updateServerStatus(serverId: string, status: string, incarnation: number): Promise<boolean> {
    const stmt = this.db.prepare(`
      UPDATE known_servers SET status = ?, incarnation = ?, last_seen = ? WHERE server_id = ?
    `);
    const result = stmt.run(status, incarnation, Date.now(), serverId);
    return result.changes > 0;
  }

  async deleteServer(serverId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM known_servers WHERE server_id = ?`);
    const result = stmt.run(serverId);
    return result.changes > 0;
  }

  // Membership Snapshot
  async saveMembershipSnapshot(snapshot: object): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO membership_snapshot (id, snapshot, updated_at)
      VALUES (1, ?, ?)
    `);
    stmt.run(JSON.stringify(snapshot), Date.now());
  }

  async loadMembershipSnapshot(): Promise<object | null> {
    const stmt = this.db.prepare(`SELECT snapshot FROM membership_snapshot WHERE id = 1`);
    const row = stmt.get() as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as object : null;
  }

  // Vector Clocks
  async saveVectorClock(key: string, clock: VectorClock): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO vector_clocks (key, clock, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET clock = excluded.clock, updated_at = excluded.updated_at
    `);
    stmt.run(key, JSON.stringify(clock), Date.now());
  }

  async getVectorClock(key: string): Promise<VectorClock | null> {
    const stmt = this.db.prepare(`SELECT clock FROM vector_clocks WHERE key = ?`);
    const row = stmt.get(key) as { clock: string } | undefined;
    return row ? JSON.parse(row.clock) as VectorClock : null;
  }

  async deleteVectorClock(key: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM vector_clocks WHERE key = ?`);
    const result = stmt.run(key);
    return result.changes > 0;
  }

  // Chunk Cache
  async cacheChunk(chunkId: string, channelId: string, data: Buffer): Promise<void> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO chunk_cache (chunk_id, channel_id, data, cached_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(chunk_id) DO UPDATE SET
        data = excluded.data,
        channel_id = excluded.channel_id,
        cached_at = excluded.cached_at,
        last_accessed = excluded.last_accessed,
        access_count = 0
    `);
    stmt.run(chunkId, channelId, data, now, now);
  }

  async getCachedChunk(chunkId: string): Promise<{ data: Buffer; channelId: string } | null> {
    const stmt = this.db.prepare(`SELECT data, channel_id FROM chunk_cache WHERE chunk_id = ?`);
    const row = stmt.get(chunkId) as { data: Buffer; channel_id: string } | undefined;
    if (!row) return null;

    // Update last_accessed and access_count
    const updateStmt = this.db.prepare(`
      UPDATE chunk_cache SET last_accessed = ?, access_count = access_count + 1 WHERE chunk_id = ?
    `);
    updateStmt.run(Date.now(), chunkId);

    return { data: row.data, channelId: row.channel_id };
  }

  async getCachedChunkIdsByChannel(channelId: string): Promise<string[]> {
    const stmt = this.db.prepare(`SELECT chunk_id FROM chunk_cache WHERE channel_id = ?`);
    const rows = stmt.all(channelId) as Array<{ chunk_id: string }>;
    return rows.map(row => row.chunk_id);
  }

  async deleteCachedChunk(chunkId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM chunk_cache WHERE chunk_id = ?`);
    const result = stmt.run(chunkId);
    return result.changes > 0;
  }

  async cleanupExpiredChunks(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare(`DELETE FROM chunk_cache WHERE cached_at < ?`);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  async evictLruChunks(maxEntries: number): Promise<number> {
    // Count current entries
    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM chunk_cache`);
    const countResult = countStmt.get() as { count: number };

    if (countResult.count <= maxEntries) return 0;

    const toEvict = countResult.count - maxEntries;
    // Delete the least recently accessed entries
    const stmt = this.db.prepare(`
      DELETE FROM chunk_cache WHERE chunk_id IN (
        SELECT chunk_id FROM chunk_cache ORDER BY last_accessed ASC LIMIT ?
      )
    `);
    const result = stmt.run(toEvict);
    return result.changes;
  }

  async getCachedChunkCount(): Promise<number> {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM chunk_cache`);
    const result = stmt.get() as { count: number };
    return result.count;
  }

  // Chunk Sources
  async saveChunkSource(chunkId: string, peerId: string): Promise<void> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO chunk_sources (chunk_id, peer_id, announced_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chunk_id, peer_id) DO UPDATE SET
        announced_at = excluded.announced_at
    `);
    stmt.run(chunkId, peerId, now);
  }

  async getChunkSources(chunkId: string): Promise<Array<{ chunkId: string; peerId: string; announcedAt: number }>> {
    const stmt = this.db.prepare(`SELECT chunk_id, peer_id, announced_at FROM chunk_sources WHERE chunk_id = ?`);
    const rows = stmt.all(chunkId) as Array<{ chunk_id: string; peer_id: string; announced_at: number }>;
    return rows.map(row => ({
      chunkId: row.chunk_id,
      peerId: row.peer_id,
      announcedAt: row.announced_at,
    }));
  }

  async deleteChunkSourcesByPeer(peerId: string): Promise<number> {
    const stmt = this.db.prepare(`DELETE FROM chunk_sources WHERE peer_id = ?`);
    const result = stmt.run(peerId);
    return result.changes;
  }

  async deleteChunkSource(chunkId: string, peerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM chunk_sources WHERE chunk_id = ? AND peer_id = ?`);
    const result = stmt.run(chunkId, peerId);
    return result.changes > 0;
  }

  async cleanupExpiredChunkSources(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare(`DELETE FROM chunk_sources WHERE announced_at < ?`);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  // Statistics
  async getStats(): Promise<StorageStats> {
    const dailyCount = this.db.prepare(`SELECT COUNT(*) as count FROM daily_points WHERE expires_at > ?`).get(Date.now()) as { count: number };
    const hourlyCount = this.db.prepare(`SELECT COUNT(*) as count FROM hourly_tokens WHERE expires_at > ?`).get(Date.now()) as { count: number };
    const relayCount = this.db.prepare(`SELECT COUNT(*) as count FROM relays`).get() as { count: number };
    const serverCount = this.db.prepare(`SELECT COUNT(*) as count FROM known_servers`).get() as { count: number };

    let dbSizeBytes: number | undefined;
    try {
      const stats = statSync(this.dbPath);
      dbSizeBytes = stats.size;
    } catch {
      // Intentionally ignored: dbSizeBytes is optional, stats may fail if file
      // is locked or on certain filesystems. Returning undefined is acceptable.
    }

    return {
      dailyPoints: dailyCount.count,
      hourlyTokens: hourlyCount.count,
      relays: relayCount.count,
      servers: serverCount.count,
      dbSizeBytes,
    };
  }
}
