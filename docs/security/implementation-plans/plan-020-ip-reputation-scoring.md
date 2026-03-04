# Implementation Plan 020: IP Reputation Scoring and Cluster-Aware Rate Limiting

**Story Reference:** [story-020-ip-reputation-scoring.md](../stories/story-020-ip-reputation-scoring.md)
**Priority:** MEDIUM-TERM
**Severity:** MEDIUM
**Components:** packages/server, packages/server-vps
**Estimated Effort:** 5-7 days

---

## 1. Summary

This plan implements a multi-tier IP reputation scoring system with federation-wide threat intelligence sharing to address the current limitations where:
- CF Worker rate limiting is per-isolate and lost on eviction
- VPS server rate limiting is per-process and lost on restart
- No cross-server reputation sharing across the federation
- No behavioral analysis or progressive response to repeat offenders
- No escalation for IPs that persistently hit rate limits

The implementation is divided into 4 phases:
1. **Phase 1**: Durable reputation on CF Worker (using Cache API)
2. **Phase 2**: VPS persistent reputation (using SQLite)
3. **Phase 3**: Federation threat sharing (via SWIM gossip protocol)
4. **Phase 4**: CF Worker aggregation of VPS threat intelligence

Each phase delivers incremental value and can be deployed independently.

---

## 2. Files to Modify

### 2.1 New Files to Create

#### Phase 1: CF Worker Reputation
- `/home/meywd/zajel-ddos/packages/server/src/reputation.js` - IP reputation manager using Cache API
- `/home/meywd/zajel-ddos/packages/server/tests/reputation.test.js` - Unit tests for reputation scoring

#### Phase 2: VPS Reputation
- `/home/meywd/zajel-ddos/packages/server-vps/src/reputation/ip-reputation.ts` - VPS reputation manager
- `/home/meywd/zajel-ddos/packages/server-vps/migrations/003_ip_reputation.sql` - SQLite schema for reputation
- `/home/meywd/zajel-ddos/packages/server-vps/tests/unit/reputation.test.ts` - Unit tests for VPS reputation

#### Phase 3: Federation Threat Sharing
- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/threat-intel.ts` - Threat intelligence gossip message handling
- `/home/meywd/zajel-ddos/packages/server-vps/tests/unit/threat-intel.test.ts` - Unit tests for threat sharing

#### Phase 4: CF Worker Aggregation
- `/home/meywd/zajel-ddos/packages/server/src/threat-aggregator.js` - Aggregates threat data from VPS heartbeats
- `/home/meywd/zajel-ddos/packages/server/tests/threat-aggregator.test.js` - Unit tests for aggregation

### 2.2 Files to Modify

#### Phase 1: CF Worker Integration
- `/home/meywd/zajel-ddos/packages/server/src/index.js` (lines 32-44)
  - Integrate reputation manager
  - Apply progressive rate limits based on reputation score

- `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js` (lines 1-57)
  - Add reputation-aware rate limit calculation
  - Expose method to record rate limit violations

#### Phase 2: VPS Integration
- `/home/meywd/zajel-ddos/packages/server-vps/src/index.ts` (lines 313-332)
  - Integrate reputation manager for connection tracking
  - Record connection rejections

- `/home/meywd/zajel-ddos/packages/server-vps/src/client/handler.ts` (lines 262-313)
  - Record rate limit hits and invalid requests in reputation system
  - Query reputation score before applying rate limits

- `/home/meywd/zajel-ddos/packages/server-vps/src/storage/sqlite.ts` (entire file)
  - Add reputation storage methods

- `/home/meywd/zajel-ddos/packages/server-vps/src/storage/interface.ts`
  - Add reputation interface methods

#### Phase 3: Federation Integration
- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/federation-manager.ts` (lines 1-539)
  - Add threat intelligence message type
  - Wire threat intelligence handler

- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/gossip/protocol.ts`
  - Add THREAT_INTEL message type to gossip protocol

#### Phase 4: Heartbeat Extension
- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`
  - Extend heartbeat payload with threat data

- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
  - Process and store threat data from heartbeats
  - Expose threat data to Worker entry point

---

## 3. Implementation Steps

### Phase 1: CF Worker Durable Reputation (Cache API)

#### Step 1.1: Create IP Reputation Manager

**File:** `/home/meywd/zajel-ddos/packages/server/src/reputation.js`

```javascript
/**
 * IP Reputation Manager
 *
 * Tracks IP behavior across time using Cloudflare's Cache API for
 * cross-isolate persistence. Implements progressive rate limiting
 * based on accumulated reputation score.
 */

/**
 * Reputation scoring rules:
 * - Rate limit hit: +2 points
 * - Connection rejected: +3 points
 * - Invalid request (malformed JSON, NaN, expired nonce): +5 points
 * - Successful attestation: -1 point (good behavior credit)
 *
 * Score tiers:
 * - 0-5: Normal rate limits
 * - 5-15: Reduced limits (50% of normal)
 * - 15-30: Heavily restricted (10% of normal)
 * - 30+: Temporary block (5 minutes)
 */

const SCORE_DECAY_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in ms
const SCORE_DECAY_FACTOR = 0.5; // Halve the score every 24 hours
const REPUTATION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export class IPReputationManager {
  constructor(cacheApi) {
    this.cache = cacheApi;
    this.localScores = new Map(); // Hot cache for current isolate
  }

  /**
   * Get the current reputation score for an IP address.
   * Checks local cache first, then Cache API.
   *
   * @param {string} ip - IP address
   * @returns {Promise<number>} Current reputation score (0 = clean)
   */
  async getScore(ip) {
    // Check local cache
    const localEntry = this.localScores.get(ip);
    if (localEntry) {
      // Apply time-based decay
      const decayedScore = this._applyDecay(localEntry.score, localEntry.updatedAt);
      if (decayedScore !== localEntry.score) {
        localEntry.score = decayedScore;
        localEntry.updatedAt = Date.now();
      }
      return decayedScore;
    }

    // Check Cache API
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const cached = await this.cache.match(cacheKey);
    if (cached) {
      const data = await cached.json();
      const decayedScore = this._applyDecay(data.score, data.updatedAt);

      // Update local cache
      this.localScores.set(ip, {
        score: decayedScore,
        updatedAt: Date.now(),
      });
      return decayedScore;
    }

    // New IP - no reputation data
    return 0;
  }

  /**
   * Increment reputation score for an IP address.
   *
   * @param {string} ip - IP address
   * @param {number} points - Points to add (positive = worse reputation)
   * @param {number} [ttlSeconds] - Cache TTL (default: 7 days)
   * @returns {Promise<number>} New score
   */
  async incrementScore(ip, points, ttlSeconds = REPUTATION_TTL) {
    const current = await this.getScore(ip);
    const newScore = Math.max(0, current + points); // Never go below 0
    const now = Date.now();

    // Update local cache
    this.localScores.set(ip, {
      score: newScore,
      updatedAt: now,
    });

    // Persist to Cache API (shared across isolates)
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const response = new Response(
      JSON.stringify({
        score: newScore,
        updatedAt: now,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${ttlSeconds}`,
        },
      }
    );
    await this.cache.put(cacheKey, response);

    return newScore;
  }

  /**
   * Get rate limit tier based on reputation score.
   *
   * @param {number} score - Reputation score
   * @param {{limit: number, windowMs: number}} baseTier - Base rate limit config
   * @returns {{limit: number, windowMs: number, blocked: boolean}} Adjusted rate limit
   */
  getRateLimit(score, baseTier) {
    if (score >= 30) {
      // Temporary block: 0 requests allowed for 5 minutes
      return { limit: 0, windowMs: 300000, blocked: true };
    }
    if (score >= 15) {
      // Heavily restricted: 10% of normal
      return {
        limit: Math.max(1, Math.floor(baseTier.limit * 0.1)),
        windowMs: baseTier.windowMs,
        blocked: false,
      };
    }
    if (score >= 5) {
      // Reduced limits: 50% of normal
      return {
        limit: Math.floor(baseTier.limit * 0.5),
        windowMs: baseTier.windowMs,
        blocked: false,
      };
    }
    // Normal limits
    return { ...baseTier, blocked: false };
  }

  /**
   * Apply time-based decay to a score.
   * Score halves every 24 hours without new events.
   *
   * @private
   * @param {number} score - Current score
   * @param {number} updatedAt - Timestamp of last update (ms)
   * @returns {number} Decayed score
   */
  _applyDecay(score, updatedAt) {
    const now = Date.now();
    const elapsed = now - updatedAt;
    const decayPeriods = elapsed / SCORE_DECAY_INTERVAL;

    if (decayPeriods < 1) {
      // Less than 24 hours - no decay
      return score;
    }

    // Apply exponential decay: score * (0.5 ^ decayPeriods)
    const decayed = score * Math.pow(SCORE_DECAY_FACTOR, decayPeriods);
    return Math.max(0, Math.floor(decayed));
  }

  /**
   * Prune local cache to prevent unbounded memory growth.
   * Call periodically (e.g., every N requests).
   */
  pruneLocalCache() {
    // Keep only the most recent 1000 entries
    if (this.localScores.size > 1000) {
      const entries = Array.from(this.localScores.entries());
      entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      this.localScores = new Map(entries.slice(0, 1000));
    }
  }
}
```

#### Step 1.2: Integrate Reputation Manager into CF Worker

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Before (lines 26-44):**
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, env);

    // Rate limiting: 100 requests per minute per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { allowed } = rateLimiter.check(ip, 100, 60000);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Too Many Requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Periodically prune stale rate limit entries (every ~100 requests)
    if (Math.random() < 0.01) {
      rateLimiter.prune();
    }
```

**After:**
```javascript
import { IPReputationManager } from './reputation.js';

// Singleton reputation manager (per isolate, but backed by Cache API)
let reputationManager = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, env);

    // Initialize reputation manager lazily (uses Cloudflare Cache API)
    if (!reputationManager) {
      reputationManager = new IPReputationManager(caches.default);
    }

    // Get client IP
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) {
      // No IP header - reject request (prevent 'unknown' counter sharing)
      return new Response(
        JSON.stringify({ error: 'Bad Request: Missing client IP' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Check reputation score and get adjusted rate limits
    const reputationScore = await reputationManager.getScore(ip);
    const baseTier = { limit: 100, windowMs: 60000 };
    const rateLimit = reputationManager.getRateLimit(reputationScore, baseTier);

    if (rateLimit.blocked) {
      // IP is temporarily blocked due to high reputation score
      return new Response(
        JSON.stringify({
          error: 'Too Many Requests',
          message: 'Temporarily blocked due to abusive behavior. Try again later.',
          retryAfter: Math.floor(rateLimit.windowMs / 1000),
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.floor(rateLimit.windowMs / 1000)),
            ...corsHeaders,
          },
        }
      );
    }

    // Apply reputation-adjusted rate limit
    const { allowed, remaining } = rateLimiter.check(ip, rateLimit.limit, rateLimit.windowMs);
    if (!allowed) {
      // Rate limit hit - increment reputation score
      await reputationManager.incrementScore(ip, 2); // +2 points for rate limit hit

      return new Response(
        JSON.stringify({
          error: 'Too Many Requests',
          remaining: 0,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Remaining': '0',
            ...corsHeaders,
          },
        }
      );
    }

    // Periodically prune local caches (every ~100 requests)
    if (Math.random() < 0.01) {
      rateLimiter.prune();
      reputationManager.pruneLocalCache();
    }
```

#### Step 1.3: Record Events in Reputation System

Add reputation score increments throughout the Worker:

**In attestation verification (after line 150):**
```javascript
// In AttestationRegistryDO verify endpoint
if (invalidRequest) {
  // Record invalid request in reputation system
  if (env.REPUTATION_ENABLED !== 'false') {
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip && reputationManager) {
      await reputationManager.incrementScore(ip, 5); // +5 for invalid request
    }
  }
  return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
}

// After successful attestation
if (attestationSuccess) {
  // Reward good behavior
  if (env.REPUTATION_ENABLED !== 'false') {
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip && reputationManager) {
      await reputationManager.incrementScore(ip, -1); // -1 for successful attestation
    }
  }
}
```

---

### Phase 2: VPS Persistent Reputation (SQLite)

#### Step 2.1: Create SQLite Schema for Reputation

**File:** `/home/meywd/zajel-ddos/packages/server-vps/migrations/003_ip_reputation.sql`

```sql
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
CREATE TABLE IF NOT EXISTS ip_reputation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'rate_limit_hit', 'connection_rejected', 'invalid_request', 'successful_attestation'
  points_delta INTEGER NOT NULL, -- Points added/subtracted
  score_before INTEGER NOT NULL,
  score_after INTEGER NOT NULL,
  metadata TEXT, -- JSON string for additional context
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_ip ON ip_reputation_events(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_type ON ip_reputation_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_events_created ON ip_reputation_events(created_at);

-- Update schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (3);
```

#### Step 2.2: Add Reputation Methods to Storage Interface

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/storage/interface.ts`

**Add to interface (after existing methods):**
```typescript
export interface Storage {
  // ... existing methods ...

  // IP Reputation
  getReputation(ip: string): Promise<IPReputationEntry | null>;
  incrementReputation(ip: string, points: number, eventType: string, metadata?: Record<string, unknown>): Promise<number>;
  getTopOffenders(limit: number): Promise<IPReputationEntry[]>;
  cleanupOldReputationEvents(olderThanMs: number): Promise<number>;
}

export interface IPReputationEntry {
  ipAddress: string;
  reputationScore: number;
  lastUpdated: number;
  totalEvents: number;
  rateLimitHits: number;
  connectionRejects: number;
  invalidRequests: number;
  successfulAttestations: number;
  createdAt: number;
}
```

#### Step 2.3: Implement Reputation Methods in SQLite Storage

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/storage/sqlite.ts`

**Add at end of class (before closing brace):**
```typescript
  // IP Reputation
  async getReputation(ip: string): Promise<IPReputationEntry | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM ip_reputation WHERE ip_address = ?
    `);
    const row = stmt.get(ip) as any;

    if (!row) return null;

    // Apply time-based decay
    const now = Date.now();
    const elapsed = now - row.last_updated;
    const decayPeriods = elapsed / (24 * 60 * 60 * 1000); // 24 hours
    let score = row.reputation_score;

    if (decayPeriods >= 1) {
      // Halve score every 24 hours
      score = Math.max(0, Math.floor(score * Math.pow(0.5, decayPeriods)));

      // Update decayed score in DB
      if (score !== row.reputation_score) {
        const updateStmt = this.db.prepare(`
          UPDATE ip_reputation
          SET reputation_score = ?, last_updated = ?
          WHERE ip_address = ?
        `);
        updateStmt.run(score, now, ip);
      }
    }

    return {
      ipAddress: row.ip_address,
      reputationScore: score,
      lastUpdated: row.last_updated,
      totalEvents: row.total_events,
      rateLimitHits: row.rate_limit_hits,
      connectionRejects: row.connection_rejects,
      invalidRequests: row.invalid_requests,
      successfulAttestations: row.successful_attestations,
      createdAt: row.created_at,
    };
  }

  async incrementReputation(
    ip: string,
    points: number,
    eventType: string,
    metadata?: Record<string, unknown>
  ): Promise<number> {
    const current = await this.getReputation(ip);
    const scoreBefore = current?.reputationScore || 0;
    const scoreAfter = Math.max(0, scoreBefore + points);
    const now = Date.now();

    // Upsert reputation record
    const upsertStmt = this.db.prepare(`
      INSERT INTO ip_reputation (
        ip_address,
        reputation_score,
        last_updated,
        total_events,
        rate_limit_hits,
        connection_rejects,
        invalid_requests,
        successful_attestations
      )
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(ip_address) DO UPDATE SET
        reputation_score = excluded.reputation_score,
        last_updated = excluded.last_updated,
        total_events = total_events + 1,
        rate_limit_hits = rate_limit_hits + excluded.rate_limit_hits,
        connection_rejects = connection_rejects + excluded.connection_rejects,
        invalid_requests = invalid_requests + excluded.invalid_requests,
        successful_attestations = successful_attestations + excluded.successful_attestations
    `);

    upsertStmt.run(
      ip,
      scoreAfter,
      now,
      eventType === 'rate_limit_hit' ? 1 : 0,
      eventType === 'connection_rejected' ? 1 : 0,
      eventType === 'invalid_request' ? 1 : 0,
      eventType === 'successful_attestation' ? 1 : 0
    );

    // Log event
    const eventStmt = this.db.prepare(`
      INSERT INTO ip_reputation_events (
        ip_address,
        event_type,
        points_delta,
        score_before,
        score_after,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    eventStmt.run(
      ip,
      eventType,
      points,
      scoreBefore,
      scoreAfter,
      metadata ? JSON.stringify(metadata) : null
    );

    return scoreAfter;
  }

  async getTopOffenders(limit: number): Promise<IPReputationEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM ip_reputation
      ORDER BY reputation_score DESC, last_updated DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];

    return rows.map(row => ({
      ipAddress: row.ip_address,
      reputationScore: row.reputation_score,
      lastUpdated: row.last_updated,
      totalEvents: row.total_events,
      rateLimitHits: row.rate_limit_hits,
      connectionRejects: row.connection_rejects,
      invalidRequests: row.invalid_requests,
      successfulAttestations: row.successful_attestations,
      createdAt: row.created_at,
    }));
  }

  async cleanupOldReputationEvents(olderThanMs: number): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM ip_reputation_events
      WHERE created_at < ?
    `);
    const result = stmt.run(Date.now() - olderThanMs);
    return result.changes;
  }
```

#### Step 2.4: Create VPS Reputation Manager

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/reputation/ip-reputation.ts`

```typescript
/**
 * VPS IP Reputation Manager
 *
 * Manages IP reputation scores with persistent SQLite storage.
 * Integrates with the client handler to track behavioral events.
 */

import type { Storage, IPReputationEntry } from '../storage/interface.js';

export interface ReputationTier {
  limit: number;
  windowMs: number;
  blocked: boolean;
}

export class VPSReputationManager {
  constructor(private storage: Storage) {}

  /**
   * Record a reputation event for an IP address.
   *
   * @param ip - IP address
   * @param eventType - Type of event
   * @param metadata - Optional additional context
   * @returns New reputation score
   */
  async recordEvent(
    ip: string,
    eventType: 'rate_limit_hit' | 'connection_rejected' | 'invalid_request' | 'successful_attestation',
    metadata?: Record<string, unknown>
  ): Promise<number> {
    const pointsMap = {
      rate_limit_hit: 2,
      connection_rejected: 3,
      invalid_request: 5,
      successful_attestation: -1,
    };

    const points = pointsMap[eventType];
    return await this.storage.incrementReputation(ip, points, eventType, metadata);
  }

  /**
   * Get reputation score for an IP address.
   * Returns 0 if no record exists.
   */
  async getScore(ip: string): Promise<number> {
    const entry = await this.storage.getReputation(ip);
    return entry?.reputationScore || 0;
  }

  /**
   * Get full reputation entry for an IP address.
   */
  async getEntry(ip: string): Promise<IPReputationEntry | null> {
    return await this.storage.getReputation(ip);
  }

  /**
   * Calculate rate limit tier based on reputation score.
   *
   * Score tiers:
   * - 0-5: Normal
   * - 5-15: Reduced (50%)
   * - 15-30: Heavily restricted (10%)
   * - 30+: Blocked
   */
  getRateLimitTier(score: number, baseLimit: number, windowMs: number): ReputationTier {
    if (score >= 30) {
      return { limit: 0, windowMs: 300000, blocked: true }; // Blocked for 5 minutes
    }
    if (score >= 15) {
      return {
        limit: Math.max(1, Math.floor(baseLimit * 0.1)),
        windowMs,
        blocked: false,
      };
    }
    if (score >= 5) {
      return {
        limit: Math.floor(baseLimit * 0.5),
        windowMs,
        blocked: false,
      };
    }
    return { limit: baseLimit, windowMs, blocked: false };
  }

  /**
   * Check if an IP should be blocked based on reputation.
   */
  async isBlocked(ip: string): Promise<boolean> {
    const score = await this.getScore(ip);
    return score >= 30;
  }

  /**
   * Get top offending IPs for admin dashboard.
   */
  async getTopOffenders(limit = 100): Promise<IPReputationEntry[]> {
    return await this.storage.getTopOffenders(limit);
  }

  /**
   * Clean up old reputation event logs (keep last 30 days).
   */
  async cleanupOldEvents(): Promise<number> {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    return await this.storage.cleanupOldReputationEvents(thirtyDaysMs);
  }
}
```

#### Step 2.5: Integrate Reputation into VPS Index

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/index.ts`

**Add import (after line 27):**
```typescript
import { VPSReputationManager } from './reputation/ip-reputation.js';
```

**Add to createZajelServer function (after line 65):**
```typescript
  // Initialize reputation manager
  const reputationManager = new VPSReputationManager(storage);
  console.log('[Zajel] Reputation manager initialized');
```

**Modify connection handler (lines 316-333):**

**Before:**
```typescript
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Check total connection limit
    const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
    if (totalConnections >= CONNECTION_LIMITS.MAX_TOTAL_CONNECTIONS) {
      ws.close(1013, 'Server at capacity');
      return;
    }

    // Check per-IP connection limit
    const ipCount = ipConnectionCounts.get(clientIp) || 0;
    if (ipCount >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
      ws.close(1013, 'Too many connections from this IP');
      return;
    }
    ipConnectionCounts.set(clientIp, ipCount + 1);
```

**After:**
```typescript
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Check reputation-based blocking
    if (clientIp !== 'unknown') {
      const isBlocked = await reputationManager.isBlocked(clientIp);
      if (isBlocked) {
        ws.close(1013, 'Temporarily blocked due to abusive behavior');
        await reputationManager.recordEvent(clientIp, 'connection_rejected', {
          reason: 'reputation_blocked',
        });
        return;
      }
    }

    // Check total connection limit
    const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
    if (totalConnections >= CONNECTION_LIMITS.MAX_TOTAL_CONNECTIONS) {
      ws.close(1013, 'Server at capacity');
      return;
    }

    // Check per-IP connection limit (reputation-adjusted)
    const ipCount = ipConnectionCounts.get(clientIp) || 0;
    let maxConnections = CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP;

    if (clientIp !== 'unknown') {
      const reputationScore = await reputationManager.getScore(clientIp);
      const tier = reputationManager.getRateLimitTier(
        reputationScore,
        CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP,
        60000
      );
      maxConnections = tier.limit;
    }

    if (ipCount >= maxConnections) {
      ws.close(1013, 'Too many connections from this IP');
      if (clientIp !== 'unknown') {
        await reputationManager.recordEvent(clientIp, 'connection_rejected', {
          reason: 'connection_limit',
          count: ipCount,
        });
      }
      return;
    }
    ipConnectionCounts.set(clientIp, ipCount + 1);
```

#### Step 2.6: Integrate Reputation into Client Handler

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/client/handler.ts`

**Add reputation manager to constructor (after line 135):**
```typescript
  private reputationManager: VPSReputationManager | null = null;

  constructor(
    identity: ServerIdentity,
    endpoint: string,
    config: ClientHandlerConfig,
    relayRegistry: RelayRegistry,
    distributedRendezvous: DistributedRendezvous,
    metadata: ServerMetadata = {},
    storage?: Storage,
    attestationConfig?: AttestationConfig,
    federation?: FederationManager,
    reputationManager?: VPSReputationManager  // Add this parameter
  ) {
    super();
    this.identity = identity;
    this.endpoint = endpoint;
    this.config = config;
    this.relayRegistry = relayRegistry;
    this.distributedRendezvous = distributedRendezvous;
    this.metadata = metadata;
    this.reputationManager = reputationManager || null;
```

**Modify checkRateLimit method (lines 262-285):**

**After:**
```typescript
  private async checkRateLimit(ws: WebSocket): Promise<boolean> {
    const now = Date.now();
    let rateLimitInfo = this.wsRateLimits.get(ws);

    if (!rateLimitInfo) {
      rateLimitInfo = { messageCount: 1, windowStart: now };
      this.wsRateLimits.set(ws, rateLimitInfo);
      return true;
    }

    if (now - rateLimitInfo.windowStart >= RATE_LIMIT.WINDOW_MS) {
      rateLimitInfo.messageCount = 1;
      rateLimitInfo.windowStart = now;
      return true;
    }

    rateLimitInfo.messageCount++;

    // Get reputation-adjusted limit
    let maxMessages = RATE_LIMIT.MAX_MESSAGES;
    if (this.reputationManager) {
      const clientId = this.wsToClient.get(ws);
      if (clientId) {
        const client = this.clients.get(clientId);
        if (client?.ip) {
          const score = await this.reputationManager.getScore(client.ip);
          const tier = this.reputationManager.getRateLimitTier(
            score,
            RATE_LIMIT.MAX_MESSAGES,
            RATE_LIMIT.WINDOW_MS
          );
          maxMessages = tier.limit;
        }
      }
    }

    if (rateLimitInfo.messageCount > maxMessages) {
      // Record rate limit hit in reputation system
      if (this.reputationManager) {
        const clientId = this.wsToClient.get(ws);
        if (clientId) {
          const client = this.clients.get(clientId);
          if (client?.ip) {
            await this.reputationManager.recordEvent(client.ip, 'rate_limit_hit', {
              messageCount: rateLimitInfo.messageCount,
              limit: maxMessages,
            });
          }
        }
      }
      return false;
    }

    return true;
  }
```

---

### Phase 3: Federation Threat Sharing (SWIM Gossip)

#### Step 3.1: Create Threat Intelligence Handler

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/federation/threat-intel.ts`

```typescript
/**
 * Threat Intelligence Sharing
 *
 * Extends the SWIM gossip protocol to share IP blocklists and attack
 * patterns across the federation. VPS servers share reputation data
 * to enable cluster-wide defense against distributed attacks.
 */

import type { Storage } from '../storage/interface.js';
import type { VPSReputationManager } from '../reputation/ip-reputation.js';
import { logger } from '../utils/logger.js';

export interface BlockedIP {
  ip: string;
  score: number;
  reason: string;
  expiresAt: number;
  serverId: string; // Which server reported this
}

export interface AttackPattern {
  pattern: string; // e.g., "pair_request_flood", "connection_spam"
  severity: 'low' | 'medium' | 'high';
  detectedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ThreatIntelPayload {
  blockedIPs: BlockedIP[];
  attackPatterns: AttackPattern[];
  timestamp: number;
  serverId: string;
}

export class ThreatIntelManager {
  private reputationManager: VPSReputationManager;
  private serverId: string;

  // Track IPs reported by federation (don't re-gossip our own reports)
  private federatedBlockedIPs: Map<string, BlockedIP> = new Map();

  constructor(reputationManager: VPSReputationManager, serverId: string) {
    this.reputationManager = reputationManager;
    this.serverId = serverId;
  }

  /**
   * Generate threat intelligence payload to share with federation.
   * Called periodically by the gossip protocol.
   */
  async generatePayload(): Promise<ThreatIntelPayload> {
    // Get top offenders from local reputation system
    const topOffenders = await this.reputationManager.getTopOffenders(50);

    // Only share IPs with score >= 20 (medium-high threat)
    const blockedIPs: BlockedIP[] = topOffenders
      .filter(entry => entry.reputationScore >= 20)
      .map(entry => ({
        ip: entry.ipAddress,
        score: entry.reputationScore,
        reason: this._inferReason(entry),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        serverId: this.serverId,
      }));

    // TODO: Implement attack pattern detection
    const attackPatterns: AttackPattern[] = [];

    return {
      blockedIPs,
      attackPatterns,
      timestamp: Date.now(),
      serverId: this.serverId,
    };
  }

  /**
   * Process threat intelligence received from another server.
   * Apply received blocklist to local reputation system.
   */
  async processIncoming(payload: ThreatIntelPayload): Promise<void> {
    if (payload.serverId === this.serverId) {
      // Don't process our own reports
      return;
    }

    logger.info(`[ThreatIntel] Received threat data from ${payload.serverId}: ${payload.blockedIPs.length} IPs`);

    for (const blockedIP of payload.blockedIPs) {
      // Check if IP is already blocked locally
      const localScore = await this.reputationManager.getScore(blockedIP.ip);

      if (localScore < 15) {
        // Local score is low - trust federation report and boost reputation
        const boostPoints = Math.min(15, blockedIP.score / 2); // Half of remote score, max 15
        await this.reputationManager.recordEvent(
          blockedIP.ip,
          'invalid_request', // Use as generic "bad behavior" event
          {
            source: 'federation',
            reportedBy: blockedIP.serverId,
            remoteScore: blockedIP.score,
            reason: blockedIP.reason,
          }
        );

        logger.info(`[ThreatIntel] Boosted reputation for ${blockedIP.ip} based on federation report`);
      }

      // Track federated blocks
      this.federatedBlockedIPs.set(blockedIP.ip, blockedIP);
    }

    // Process attack patterns
    for (const pattern of payload.attackPatterns) {
      logger.warn(`[ThreatIntel] Attack pattern detected by ${payload.serverId}: ${pattern.pattern} (${pattern.severity})`);
      // TODO: Implement pattern-based defenses
    }
  }

  /**
   * Get list of IPs blocked by federation (for admin dashboard).
   */
  getFederatedBlocks(): BlockedIP[] {
    const now = Date.now();
    const active: BlockedIP[] = [];

    for (const [ip, block] of this.federatedBlockedIPs.entries()) {
      if (block.expiresAt > now) {
        active.push(block);
      } else {
        // Clean up expired blocks
        this.federatedBlockedIPs.delete(ip);
      }
    }

    return active;
  }

  /**
   * Infer reason string from reputation entry counters.
   * @private
   */
  private _inferReason(entry: { rateLimitHits: number; connectionRejects: number; invalidRequests: number }): string {
    if (entry.invalidRequests > 10) return 'invalid_request_spam';
    if (entry.rateLimitHits > 20) return 'rate_limit_abuse';
    if (entry.connectionRejects > 15) return 'connection_spam';
    return 'general_abuse';
  }
}
```

#### Step 3.2: Extend Gossip Protocol with Threat Intel Message Type

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/federation/gossip/protocol.ts`

**Add to message types (find the MessageType enum or type definitions):**
```typescript
export interface ThreatIntelMessage {
  type: 'gossip';
  subtype: 'threat_intel';
  data: ThreatIntelPayload;
}

// Add to union type of gossip messages
export type GossipMessage =
  | PingMessage
  | AckMessage
  | StateExchangeMessage
  | ThreatIntelMessage; // Add this
```

#### Step 3.3: Integrate Threat Intel into Federation Manager

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/federation/federation-manager.ts`

**Add import (after line 20):**
```typescript
import { ThreatIntelManager } from './threat-intel.js';
```

**Add to FederationManager class (after line 56):**
```typescript
  private threatIntel: ThreatIntelManager | null = null;
  private threatIntelInterval: NodeJS.Timeout | null = null;
```

**Add method to initialize threat intelligence:**
```typescript
  /**
   * Initialize threat intelligence sharing.
   * Call after reputation manager is available.
   */
  initializeThreatIntel(reputationManager: VPSReputationManager): void {
    this.threatIntel = new ThreatIntelManager(reputationManager, this.identity.serverId);

    // Start periodic threat intel broadcast (every 5 minutes)
    this.threatIntelInterval = setInterval(async () => {
      if (this.threatIntel && !this.isShutdown) {
        const payload = await this.threatIntel.generatePayload();

        // Broadcast to all alive members
        const members = this.gossip.getAliveMembers();
        for (const member of members) {
          try {
            const connection = await this.transport.getConnection(member.endpoint);
            connection.send({
              type: 'gossip',
              subtype: 'threat_intel',
              data: payload,
            });
          } catch (err) {
            // Log but don't fail - threat intel is best-effort
            logger.debug(`[ThreatIntel] Failed to send to ${member.serverId}: ${err}`);
          }
        }
      }
    }, 5 * 60 * 1000); // 5 minutes
  }
```

**Add message handler in setupTransportEvents method:**
```typescript
  private setupTransportEvents(): void {
    // ... existing handlers ...

    this.transport.on('message', async (message: any, serverId: string) => {
      if (message.type === 'gossip' && message.subtype === 'threat_intel') {
        if (this.threatIntel) {
          await this.threatIntel.processIncoming(message.data);
        }
      }
    });
  }
```

**Add cleanup in shutdown method:**
```typescript
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    if (this.threatIntelInterval) {
      clearInterval(this.threatIntelInterval);
      this.threatIntelInterval = null;
    }

    // ... existing shutdown code ...
  }
```

#### Step 3.4: Wire Threat Intel in VPS Server Index

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/index.ts`

**After federation starts (after line 393):**
```typescript
  // Start federation
  await federation.start(federationWss);
  console.log('[Zajel] Federation started');

  // Initialize threat intelligence sharing
  federation.initializeThreatIntel(reputationManager);
  console.log('[Zajel] Threat intelligence sharing enabled');
```

---

### Phase 4: CF Worker Aggregation from VPS Heartbeats

#### Step 4.1: Extend Heartbeat Payload with Threat Data

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`

**Find the heartbeat payload construction and add:**
```typescript
    // Existing heartbeat fields
    const payload = {
      serverId: this.identity.serverId,
      endpoint: this.endpoint,
      connections: metricsCallback().connections,
      // ... other existing fields ...

      // Add threat intelligence
      threatData: await this._getThreatData(),
    };
```

**Add method to BootstrapClient class:**
```typescript
  private async _getThreatData(): Promise<{
    blockedIPs: string[];
    recentAttackPatterns: string[];
  }> {
    // Get top offenders from reputation manager (if available)
    // This requires passing reputation manager to bootstrap client
    // For now, return empty - will be wired in Step 4.2
    return {
      blockedIPs: [],
      recentAttackPatterns: [],
    };
  }
```

#### Step 4.2: Wire Reputation Manager to Bootstrap Client

**File:** `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`

**Modify BootstrapClient constructor to accept reputation manager:**
```typescript
export interface BootstrapClientDeps {
  reputationManager?: VPSReputationManager;
}

export function createBootstrapClient(
  config: ServerConfig,
  identity: ServerIdentity,
  metricsCallback: () => BootstrapMetrics,
  buildManifest: BuildManifest | null,
  deps?: BootstrapClientDeps
): BootstrapClient {
  return new BootstrapClientImpl(
    config,
    identity,
    metricsCallback,
    buildManifest,
    deps?.reputationManager
  );
}
```

**Update _getThreatData implementation:**
```typescript
  private async _getThreatData(): Promise<{
    blockedIPs: string[];
    recentAttackPatterns: string[];
  }> {
    if (!this.reputationManager) {
      return { blockedIPs: [], recentAttackPatterns: [] };
    }

    // Get IPs with score >= 25 (high threat)
    const offenders = await this.reputationManager.getTopOffenders(20);
    const blockedIPs = offenders
      .filter(entry => entry.reputationScore >= 25)
      .map(entry => entry.ipAddress);

    // TODO: Implement attack pattern detection
    const recentAttackPatterns: string[] = [];

    return { blockedIPs, recentAttackPatterns };
  }
```

**Wire in VPS index.ts (modify line 76):**
```typescript
  const bootstrap = createBootstrapClient(
    config,
    identity,
    () => ({
      connections: (clientHandlerRef?.clientCount ?? 0) + (clientHandlerRef?.signalingClientCount ?? 0),
      relayConnections: clientHandlerRef?.clientCount ?? 0,
      signalingConnections: clientHandlerRef?.signalingClientCount ?? 0,
      activeCodes: clientHandlerRef?.getEntropyMetrics().activeCodes ?? 0,
    }),
    buildManifest,
    { reputationManager } // Add this
  );
```

#### Step 4.3: Create Threat Aggregator for CF Worker

**File:** `/home/meywd/zajel-ddos/packages/server/src/threat-aggregator.js`

```javascript
/**
 * Threat Intelligence Aggregator
 *
 * Aggregates threat data from VPS server heartbeats and provides
 * fleet-wide IP blocklists to the CF Worker reputation system.
 */

export class ThreatAggregator {
  constructor(doStub) {
    this.doStub = doStub;
  }

  /**
   * Process threat data from a VPS heartbeat.
   * Called by ServerRegistryDO when processing heartbeats.
   *
   * @param {string} serverId - VPS server ID
   * @param {object} threatData - Threat intelligence from VPS
   */
  async processThreatData(serverId, threatData) {
    if (!threatData || !threatData.blockedIPs) return;

    // Store aggregated threat data in DO storage
    // This allows cross-request access to fleet-wide blocklists
    await this.doStub.fetch(
      new Request('https://internal/threat-intel/update', {
        method: 'POST',
        body: JSON.stringify({
          serverId,
          blockedIPs: threatData.blockedIPs,
          attackPatterns: threatData.recentAttackPatterns || [],
          timestamp: Date.now(),
        }),
      })
    );
  }

  /**
   * Get aggregated blocked IPs from all VPS servers.
   * Used by reputation manager to boost scores for IPs blocked fleet-wide.
   *
   * @returns {Promise<string[]>} List of blocked IP addresses
   */
  async getBlockedIPs() {
    const response = await this.doStub.fetch(
      new Request('https://internal/threat-intel/blocked-ips')
    );
    const data = await response.json();
    return data.blockedIPs || [];
  }

  /**
   * Check if an IP is blocked fleet-wide.
   *
   * @param {string} ip - IP address to check
   * @returns {Promise<boolean>}
   */
  async isBlockedFleetWide(ip) {
    const blockedIPs = await this.getBlockedIPs();
    return blockedIPs.includes(ip);
  }
}
```

#### Step 4.4: Extend ServerRegistryDO to Store Threat Data

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Add internal route handlers:**
```javascript
    // Internal threat intelligence routes (not exposed via CORS)
    if (url.pathname === '/threat-intel/update' && request.method === 'POST') {
      const { serverId, blockedIPs, attackPatterns, timestamp } = await request.json();

      // Store in DO storage with TTL
      const threatKey = `threat:${serverId}`;
      await this.state.storage.put(threatKey, {
        blockedIPs,
        attackPatterns,
        timestamp,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/threat-intel/blocked-ips' && request.method === 'GET') {
      // Aggregate blocked IPs from all VPS servers
      const threatKeys = await this.state.storage.list({ prefix: 'threat:' });
      const allBlockedIPs = new Set();
      const now = Date.now();

      for (const [key, data] of threatKeys.entries()) {
        if (data.expiresAt > now) {
          for (const ip of data.blockedIPs) {
            allBlockedIPs.add(ip);
          }
        } else {
          // Clean up expired threat data
          await this.state.storage.delete(key);
        }
      }

      return new Response(
        JSON.stringify({ blockedIPs: Array.from(allBlockedIPs) }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
```

**Modify heartbeat handler to process threat data:**
```javascript
    if (url.pathname === '/servers/heartbeat' && request.method === 'POST') {
      const { serverId, threatData, ...otherFields } = await request.json();

      // Process threat intelligence if present
      if (threatData) {
        const aggregator = new ThreatAggregator(this.state.id.stub);
        await aggregator.processThreatData(serverId, threatData);
      }

      // ... existing heartbeat processing ...
    }
```

#### Step 4.5: Integrate Fleet-Wide Blocklist into CF Worker Reputation

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Modify reputation check (after line 50):**
```javascript
    // Check reputation score and get adjusted rate limits
    const reputationScore = await reputationManager.getScore(ip);

    // Check fleet-wide blocklist from VPS threat intelligence
    const threatAggregator = new ThreatAggregator(env.SERVER_REGISTRY.idFromName('global'));
    const isBlockedFleetWide = await threatAggregator.isBlockedFleetWide(ip);

    if (isBlockedFleetWide) {
      // IP is blocked across the federation - boost local reputation
      await reputationManager.incrementScore(ip, 10); // +10 points for fleet-wide block

      return new Response(
        JSON.stringify({
          error: 'Forbidden',
          message: 'Access blocked due to abusive behavior detected across the network.',
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
    }
```

---

## 4. Test Plan

### 4.1 Unit Tests

#### Phase 1: CF Worker Reputation
- **Test: Score accumulation** (`packages/server/tests/reputation.test.js`)
  - Record 5 rate limit hits, verify score increases by 10 (5 × 2 points)
  - Record 3 invalid requests, verify score increases by 15 (3 × 5 points)
  - Record 1 successful attestation, verify score decreases by 1

- **Test: Time-based decay**
  - Set score to 30
  - Simulate 24 hours elapsed (mock Date.now)
  - Verify score is halved to 15
  - Simulate another 24 hours
  - Verify score is halved again to 7

- **Test: Progressive rate limits**
  - Score 0: Verify limit is 100 req/min
  - Score 5: Verify limit is 50 req/min (50%)
  - Score 15: Verify limit is 10 req/min (10%)
  - Score 30: Verify limit is 0 (blocked)

- **Test: Cache API persistence**
  - Set score in one isolate (simulate with new IPReputationManager instance)
  - Create new IPReputationManager with same cache
  - Verify score survives across instances

#### Phase 2: VPS Reputation
- **Test: SQLite persistence** (`packages/server-vps/tests/unit/reputation.test.ts`)
  - Record events, close DB, reopen, verify score persists
  - Verify event log is written correctly

- **Test: Reputation event counters**
  - Record 5 rate limit hits
  - Verify `rate_limit_hits` counter is 5
  - Verify `total_events` counter is 5

- **Test: Top offenders query**
  - Create 10 IPs with varying scores
  - Query top 5 offenders
  - Verify correct ordering (highest score first)

#### Phase 3: Federation Threat Sharing
- **Test: Threat payload generation** (`packages/server-vps/tests/unit/threat-intel.test.ts`)
  - Create reputation entries with scores 10, 20, 30
  - Generate threat payload
  - Verify only IPs with score >= 20 are included

- **Test: Incoming threat processing**
  - Receive threat payload from remote server
  - Verify local reputation is boosted for reported IPs
  - Verify federated blocks are tracked

- **Test: Don't process own reports**
  - Generate payload from server A
  - Send to server A
  - Verify server A ignores its own report

#### Phase 4: CF Worker Aggregation
- **Test: Threat data aggregation** (`packages/server/tests/threat-aggregator.test.js`)
  - Submit threat data from 3 VPS servers
  - Query blocked IPs
  - Verify IPs from all 3 servers are returned

- **Test: Threat data expiration**
  - Submit threat data with expiresAt in past
  - Query blocked IPs
  - Verify expired data is not returned

### 4.2 Integration Tests

#### Test: Cross-isolate reputation persistence (CF Worker)
```javascript
// packages/server/tests/e2e/reputation-persistence.test.js
describe('CF Worker reputation persistence', () => {
  it('should survive isolate eviction', async () => {
    // Send 150 requests to trigger rate limit
    for (let i = 0; i < 150; i++) {
      await fetch('https://bootstrap.test/health');
    }

    // Simulate isolate eviction (clear in-memory Map)
    // This is implementation-specific - may need MockWorker helper

    // Verify rate limit still applies (persisted in Cache API)
    const response = await fetch('https://bootstrap.test/health');
    expect(response.status).toBe(429);
  });
});
```

#### Test: Cross-VPS reputation sharing (Federation)
```typescript
// packages/server-vps/tests/e2e/federation-threat-sharing.test.ts
describe('Federation threat sharing', () => {
  it('should share blocked IPs across VPS servers', async () => {
    // Start two VPS servers
    const serverA = await createZajelServer({ network: { port: 8081 } });
    const serverB = await createZajelServer({ network: { port: 8082 } });

    // Connect 50 times to server A from IP 1.2.3.4 (trigger block)
    for (let i = 0; i < 50; i++) {
      await wsConnect('ws://localhost:8081');
    }

    // Wait for gossip cycle (5 minutes simulated)
    await sleep(100); // Use shorter interval in test config

    // Verify server B knows about blocked IP
    const reputationB = await serverB.reputationManager.getScore('1.2.3.4');
    expect(reputationB).toBeGreaterThan(10); // Should be boosted
  });
});
```

#### Test: Progressive rate limiting (VPS)
```typescript
// packages/server-vps/tests/e2e/progressive-rate-limiting.test.ts
describe('Progressive rate limiting', () => {
  it('should reduce limits as reputation degrades', async () => {
    const server = await createZajelServer();

    // Connect and register
    const ws = await wsConnect('ws://localhost:8080');
    await ws.send(JSON.stringify({ type: 'register', peerId: 'test123' }));

    // Send messages at normal rate (100/min) - should succeed
    for (let i = 0; i < 50; i++) {
      await ws.send(JSON.stringify({ type: 'heartbeat' }));
    }

    // Hit rate limit multiple times to degrade reputation
    for (let attempt = 0; attempt < 5; attempt++) {
      for (let i = 0; i < 150; i++) {
        await ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
      await sleep(60000); // Wait for window reset
    }

    // Check reputation score increased
    const ip = '127.0.0.1';
    const score = await server.reputationManager.getScore(ip);
    expect(score).toBeGreaterThan(5);

    // Verify rate limit is now reduced (50% of 100 = 50)
    const tier = server.reputationManager.getRateLimitTier(score, 100, 60000);
    expect(tier.limit).toBe(50);
  });
});
```

### 4.3 Manual Testing

1. **Verify Cache API persistence in CF Worker (local wrangler dev)**
   ```bash
   # Send 150 requests to trigger rate limit
   for i in {1..150}; do curl http://localhost:8787/health; done

   # Restart wrangler dev (simulates isolate eviction)
   # Ctrl+C, then: wrangler dev

   # Verify rate limit still applies
   curl -v http://localhost:8787/health
   # Should return 429
   ```

2. **Verify VPS reputation persistence across restarts**
   ```bash
   # Start VPS server
   npm run dev --workspace=@zajel/server-vps

   # Connect 50 times via websocat
   for i in {1..50}; do websocat ws://localhost:8080 &; done

   # Check reputation (via admin endpoint - requires JWT)
   curl -H "Authorization: Bearer $JWT" http://localhost:8080/admin/reputation/127.0.0.1
   # Should show score > 0

   # Restart server (Ctrl+C, then npm run dev)

   # Check reputation again - should persist
   curl -H "Authorization: Bearer $JWT" http://localhost:8080/admin/reputation/127.0.0.1
   ```

3. **Verify federation threat sharing**
   ```bash
   # Start two VPS servers
   npm run dev --workspace=@zajel/server-vps -- --port 8081
   npm run dev --workspace=@zajel/server-vps -- --port 8082

   # Connect to server A 50 times (trigger high reputation score)
   for i in {1..50}; do websocat ws://localhost:8081 &; done

   # Wait 5 minutes for gossip cycle
   sleep 300

   # Check server B's view of that IP
   curl -H "Authorization: Bearer $JWT" http://localhost:8082/admin/reputation/$IP
   # Should show boosted score from federation report
   ```

---

## 5. Rollback Risk Assessment

### 5.1 Risk Level: LOW-MEDIUM

This implementation has low rollback risk because:
- **Each phase is independent** - Can deploy one phase at a time
- **Feature flags available** - Can disable reputation system via env var
- **Graceful degradation** - If reputation system fails, falls back to standard rate limiting
- **No breaking API changes** - All changes are internal

### 5.2 Risk Factors

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Cache API quota exceeded (CF Worker)** | Low | Medium | Monitor usage, prune aggressively. Cache API has generous limits (no hard quota documented) |
| **SQLite DB growth (VPS)** | Medium | Low | Implement automatic cleanup (30-day event log retention). Monitor DB size. |
| **Gossip bandwidth increase** | Low | Low | Threat intel sent every 5 minutes, payload is small (~50 IPs × 50 bytes = 2.5KB) |
| **False positives blocking legitimate users** | Medium | High | **Critical mitigation**: Implement admin override endpoint, score decay, good behavior credit (-1 for attestation) |
| **Performance impact of async reputation lookups** | Low | Medium | Local cache (in-memory Map) for hot IPs. Cache API is fast (~5-10ms). SQLite reads are ~1ms. |

### 5.3 Rollback Plan

If issues arise after deployment:

#### Phase 1 (CF Worker) Rollback
1. Set env var `REPUTATION_ENABLED=false` in wrangler.toml
2. Redeploy Worker - will skip all reputation checks
3. Rate limiting reverts to original behavior (in-memory only)

#### Phase 2 (VPS) Rollback
1. Remove reputation manager initialization from `index.ts`
2. Revert connection handler to pre-reputation version
3. Server restarts with no reputation checks
4. SQLite tables remain (no data loss) but are unused

#### Phase 3 (Federation) Rollback
1. Comment out `federation.initializeThreatIntel()` call
2. Restart servers - no threat intel messages sent
3. Reputation system continues to work locally

#### Phase 4 (CF Worker Aggregation) Rollback
1. Remove threat aggregator from Worker index
2. Redeploy - heartbeats still work, threat data ignored

### 5.4 Emergency Kill Switch

Add to CF Worker and VPS config:

```javascript
// CF Worker: packages/server/src/index.js
if (env.REPUTATION_EMERGENCY_DISABLE === 'true') {
  // Skip all reputation checks
}
```

```typescript
// VPS: packages/server-vps/src/index.ts
if (process.env.REPUTATION_EMERGENCY_DISABLE === 'true') {
  // Don't initialize reputation manager
}
```

---

## 6. Dependencies on Other Stories

### 6.1 Direct Dependencies

| Story | Relationship | Impact |
|-------|--------------|--------|
| **Story 011: Per-Endpoint Rate Limiting** | **BLOCKING** - Must be implemented first | Story 020 builds on per-endpoint rate limits. The reputation system needs differentiated base tiers (read: 200/min, write: 30/min, attest: 20/min) to apply percentage reductions. Without Story 011, reputation system will use global 100 req/min tier. |

### 6.2 Recommended Dependencies

| Story | Relationship | Impact |
|-------|--------------|--------|
| **Story 015: VPS Reverse Proxy** | Recommended before Phase 2 | Nginx provides first layer of defense (connection limits, SYN flood protection). Reputation system is second layer (application-level). Without nginx, VPS is more vulnerable during reputation bootstrap period. |

### 6.3 Related Stories (No Blocking)

| Story | Relationship | Impact |
|-------|--------------|--------|
| **Story 019: DO Sharding** | Related - reputation data needs sharding | Current implementation uses single global DO for threat aggregation. When Story 019 is implemented, reputation data must be sharded by IP hash to avoid hot partition. |
| **Story 017: Key Transparency Log** | Related - optional audit trail | Reputation score changes could be logged in transparency log for audit. Not required for functionality. |

### 6.4 Implementation Order Recommendation

**Sprint 1:**
1. Complete Story 011 (Per-Endpoint Rate Limiting) - 3 days
2. Begin Story 020 Phase 1 (CF Worker Reputation) - 2 days

**Sprint 2:**
3. Complete Story 020 Phase 2 (VPS Reputation) - 2 days
4. Complete Story 020 Phase 3 (Federation Threat Sharing) - 2 days

**Sprint 3:**
5. Complete Story 020 Phase 4 (CF Worker Aggregation) - 1 day
6. Integration testing and tuning - 2 days

---

## 7. Monitoring and Observability

### 7.1 Metrics to Track

#### CF Worker Metrics
- `reputation_score_distribution` - Histogram of reputation scores
- `reputation_blocks_total` - Counter of IPs blocked due to high score
- `reputation_cache_hits` / `reputation_cache_misses` - Cache API performance
- `reputation_score_changes` - Rate of score increments/decrements

#### VPS Metrics
- `reputation_db_size_bytes` - SQLite DB size
- `reputation_events_total` - Counter by event type
- `threat_intel_messages_sent` / `threat_intel_messages_received` - Gossip activity
- `reputation_top_offenders` - Top 10 IPs by score (for alerting)

### 7.2 Alerts

1. **High false positive rate**
   - Alert if more than 5% of successful attestations come from IPs with score > 15
   - Action: Review reputation thresholds, consider lowering score increments

2. **Reputation DB growth**
   - Alert if VPS SQLite DB exceeds 100MB
   - Action: Verify cleanup is running, consider shorter event log retention

3. **Fleet-wide attack**
   - Alert if more than 100 IPs are blocked fleet-wide simultaneously
   - Action: Review threat intel, consider emergency rate limit increase

### 7.3 Admin Dashboard Additions

Add to VPS admin dashboard (`/admin/reputation`):
- Real-time reputation score distribution graph
- Top 100 offending IPs with event breakdown
- Federated blocks received (which server reported, when)
- Manual override form (set score to 0, add to whitelist)

---

## 8. Future Enhancements (Post-Implementation)

### 8.1 Machine Learning-Based Scoring
- Train model on historical attack patterns
- Predict attack likelihood based on request sequence
- Auto-adjust score thresholds based on attack effectiveness

### 8.2 Geolocation-Based Reputation
- Track reputation by IP + country
- Apply region-specific thresholds (higher tolerance for known mobile networks)

### 8.3 Distributed Rate Limiting Coordination
- Use Cloudflare Durable Objects for true cross-isolate rate limit state
- Real-time rate limit synchronization (not just reputation scoring)

### 8.4 Allowlist for Known Good IPs
- Exempt known enterprise networks, universities from reputation scoring
- Require manual review for allowlist additions

---

## 9. Acceptance Criteria

- [ ] **Phase 1: CF Worker Reputation**
  - [ ] IP reputation scores persist in Cache API across isolate evictions
  - [ ] Rate limit hits increment score by +2 points
  - [ ] Invalid requests increment score by +5 points
  - [ ] Successful attestations decrement score by -1 point
  - [ ] Score >= 30 results in 5-minute block
  - [ ] Score 15-29 applies 10% rate limit
  - [ ] Score 5-14 applies 50% rate limit
  - [ ] Score decays by 50% every 24 hours
  - [ ] Unit tests pass (score accumulation, decay, progressive limits)

- [ ] **Phase 2: VPS Reputation**
  - [ ] IP reputation persists in SQLite across process restarts
  - [ ] Connection rejections increment score by +3 points
  - [ ] Reputation events are logged with metadata
  - [ ] Top offenders query returns highest-scored IPs
  - [ ] Reputation-adjusted connection limits are applied
  - [ ] Reputation-adjusted message rate limits are applied
  - [ ] Unit tests pass (persistence, counters, top offenders)

- [ ] **Phase 3: Federation Threat Sharing**
  - [ ] Threat intelligence payloads are generated every 5 minutes
  - [ ] Only IPs with score >= 20 are shared with federation
  - [ ] Incoming threat intel boosts local reputation scores
  - [ ] Servers don't process their own threat reports
  - [ ] Blocked IPs propagate across federation within one gossip cycle
  - [ ] Unit tests pass (payload generation, incoming processing)

- [ ] **Phase 4: CF Worker Aggregation**
  - [ ] VPS heartbeats include threat data (blocked IPs, attack patterns)
  - [ ] CF Worker aggregates threat data from all VPS servers
  - [ ] Fleet-wide blocklist is queryable via internal DO route
  - [ ] IPs blocked fleet-wide get reputation boost in CF Worker
  - [ ] Threat data expires after 24 hours
  - [ ] Unit tests pass (aggregation, expiration)

- [ ] **Integration & Testing**
  - [ ] Integration test: Reputation survives CF Worker isolate eviction
  - [ ] Integration test: Reputation survives VPS process restart
  - [ ] Integration test: Blocked IP on VPS-A is reported to VPS-B
  - [ ] Integration test: Progressive rate limiting reduces limits as score increases
  - [ ] Manual test: Verify Cache API persistence in wrangler dev
  - [ ] Manual test: Verify SQLite persistence across VPS restarts
  - [ ] Manual test: Verify federation threat sharing with 2 VPS servers

- [ ] **Monitoring**
  - [ ] Reputation metrics exposed in CF Worker (Prometheus/Grafana compatible)
  - [ ] Reputation metrics exposed in VPS admin dashboard
  - [ ] Alerts configured for false positive rate, DB growth, fleet-wide attacks
  - [ ] Admin dashboard shows reputation score distribution and top offenders

- [ ] **Documentation**
  - [ ] README updated with reputation system overview
  - [ ] API documentation for admin override endpoints
  - [ ] Runbook for false positive handling
  - [ ] Rollback procedure documented

---

## 10. Success Metrics

After 30 days of production deployment:

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| **Attack effectiveness reduction** | 80% fewer successful rate limit bypasses | Compare pre/post attack success rate (requests after rate limit hit) |
| **Cross-server attack coordination** | 90% of blocked IPs are blocked fleet-wide within 5 minutes | Track time from local block to federation propagation |
| **False positive rate** | < 0.1% of successful attestations from blocked IPs | Count attestations from IPs with score >= 30 |
| **Memory overhead (CF Worker)** | < 10MB per isolate | Monitor Worker memory usage |
| **DB growth (VPS)** | < 50MB per server after 30 days | Monitor SQLite file size |
| **Latency impact** | < 5ms p95 latency increase | Compare pre/post request latency |

---

**Plan Author:** Claude Opus 4.6
**Plan Date:** 2026-03-03
**Plan Version:** 1.0
