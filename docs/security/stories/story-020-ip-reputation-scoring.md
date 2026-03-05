# Story 020: IP Reputation Scoring and Cluster-Aware Rate Limiting

## Priority: MEDIUM-TERM
## Severity: MEDIUM
## Component: packages/server, packages/server-vps

## Summary

Rate limiting across the Zajel infrastructure is entirely per-isolate and in-memory, with no cross-request reputation tracking and no awareness of coordinated attacks across the federation. The Cloudflare Worker rate limiter (`packages/server/src/rate-limiter.js`) uses an in-memory `Map` that is lost on isolate eviction. The VPS server (`packages/server-vps/src/index.ts`) uses an in-memory `Map<string, number>` for per-IP connection counts that is lost on process restart. Neither system shares reputation data with the other, meaning an attacker who is rate-limited on one VPS server can freely attack another, and an attacker who is blocked on the CF Worker can still connect to VPS servers.

## Current Behavior

**CF Worker rate limiter** (`packages/server/src/rate-limiter.js`, lines 9-57):
```javascript
export class RateLimiter {
  constructor() {
    this.counters = new Map();  // In-memory, lost on isolate eviction
  }

  check(ip, limit, windowMs) {
    // Sliding window per-IP counter
    // No history beyond the current window
    // No reputation score
    // No cross-request learning
  }
}
```
Characteristics:
- Single-window counter: Only tracks requests within the current 60-second window
- No history: Once the window resets, a previously-abusive IP has a clean slate
- No escalation: An IP that repeatedly hits rate limits is treated the same as a first-time visitor
- Isolate-local: Each Worker isolate has its own counter state (Cloudflare may route requests to different isolates)

**VPS connection tracking** (`packages/server-vps/src/index.ts`, lines 313-332):
```typescript
const ipConnectionCounts = new Map<string, number>();

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const ipCount = ipConnectionCounts.get(clientIp) || 0;
  if (ipCount >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections from this IP');
    return;
  }
  ipConnectionCounts.set(clientIp, ipCount + 1);
});
```
Characteristics:
- Connection count only: No message-level or behavioral analysis
- No persistence: Lost on PM2 restart (which happens on memory limit, crash, or deploy)
- No federation awareness: VPS server A doesn't know that IP X was abusive on VPS server B
- No escalation: An IP that reconnects 1000 times (connecting, being rejected, reconnecting) is never banned

**VPS message rate limiting** (`packages/server-vps/src/constants.ts`, lines 30-38):
```typescript
export const RATE_LIMIT = {
  WINDOW_MS: 60000,
  MAX_MESSAGES: 100,
  MAX_PAIR_REQUESTS: 10,
};
```
These limits are applied in the client handler per WebSocket connection, but there is no cross-connection rate limit. An attacker with 50 connections can send 50 * 100 = 5000 messages per minute.

**No federation-level threat sharing**:
The VPS servers communicate via SWIM gossip protocol (`packages/server-vps/src/federation/federation-manager.ts`) for membership management, but there is no mechanism to:
- Share IP blocklists across federation members
- Propagate rate limit state between servers
- Alert other servers about ongoing attacks
- Coordinate response to distributed attacks

## Expected Behavior

1. **IP Reputation System**: Each IP should accumulate a reputation score based on behavior across time:
   - Rate limit hits increase the score
   - Connection rejection events increase the score
   - Invalid request patterns (malformed JSON, NaN injection, expired nonces) increase the score
   - Good behavior (successful attestation, normal messaging patterns) decreases the score
   - Score persists across windows and isolate restarts

2. **Progressive Response**: High-reputation-score IPs face increasingly strict rate limits:
   - Score 0-5: Normal limits
   - Score 5-15: Reduced limits (50% of normal)
   - Score 15-30: Heavily restricted (10% of normal)
   - Score 30+: Temporary block (5 minutes, then recheck)

3. **Federation Threat Sharing**: VPS servers should share threat intelligence:
   - Blocked IPs propagated via gossip protocol
   - Attack patterns (e.g., "rapid pair request flood from IP range") shared as alerts
   - CF Worker aggregates threat data from VPS heartbeats

4. **Cluster-Aware Rate Limiting on CF Worker**: Use Durable Object storage or Cache API for cross-isolate rate limit state, so the same IP gets consistent treatment regardless of which isolate handles the request.

## Root Cause Analysis

The current rate limiting was designed for a single-server deployment model. The in-memory `Map` approach is correct for stateless Workers where "best effort" rate limiting is acceptable. However, as the system evolved into a federated network with multiple VPS servers and a central CF Worker, the rate limiting did not evolve to match.

The key architectural gaps are:

1. **No durable state for reputation**: Both the CF Worker and VPS server use in-memory structures. The CF Worker cannot use DO storage for rate limiting (too expensive per-request), and the VPS server has no persistent store for IP reputation (SQLite is used only for federation and rendezvous data).

2. **No cross-server communication for threats**: The SWIM gossip protocol carries membership and health information, but there is no message type for threat intelligence.

3. **No behavioral analysis**: Rate limiting is purely volumetric (count of requests/connections). There is no analysis of request patterns (e.g., scanning different pairing codes, requesting challenges for non-existent devices, submitting invalid HMAC responses).

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/rate-limiter.js` | 1-57 | In-memory rate limiter (no reputation, no persistence) |
| `packages/server/src/index.js` | 32-44 | Rate limit application (single check, no reputation lookup) |
| `packages/server-vps/src/index.ts` | 313-332 | Per-IP connection counter (in-memory, no reputation) |
| `packages/server-vps/src/constants.ts` | 30-38 | Message rate limits (per-connection, not per-IP aggregate) |
| `packages/server-vps/src/federation/federation-manager.ts` | 1-539 | Gossip protocol (no threat sharing messages) |
| `packages/server-vps/src/client/signaling-handler.ts` | 132-215 | Pairing code registration (no behavioral scoring for rapid registrations) |

## Reproduction Steps

1. **Cross-isolate bypass on CF Worker**:
   ```bash
   # Send 100 requests (hits rate limit on isolate A)
   for i in $(seq 1 100); do curl -s https://bootstrap.example.com/health > /dev/null; done
   # Wait for Cloudflare to route to a different isolate (or trigger eviction)
   sleep 30
   # Fresh budget on the new isolate
   curl -s https://bootstrap.example.com/health  # 200 OK
   ```

2. **Cross-VPS attack**:
   ```bash
   # Connect to VPS-A 50 times (max per-IP)
   for i in $(seq 1 50); do websocat ws://vps-a.example.com &; done
   # VPS-A blocks further connections from this IP
   # But VPS-B has no knowledge of the abuse
   for i in $(seq 1 50); do websocat ws://vps-b.example.com &; done
   # 50 more connections accepted
   ```

3. **Reputation reset on restart**:
   ```bash
   # Trigger aggressive behavior that should build up reputation
   for i in $(seq 1 1000); do
     curl -s -X POST https://bootstrap.example.com/attest/verify \
       -d '{"device_id":"fake","nonce":"fake","responses":[]}'
   done
   # PM2 restarts VPS server (or CF isolate evicts)
   # All reputation data is lost
   ```

4. **No escalation**:
   ```bash
   # Hit rate limit 100 times in 100 consecutive windows
   for window in $(seq 1 100); do
     for req in $(seq 1 101); do
       curl -s https://bootstrap.example.com/health > /dev/null
     done
     sleep 60  # Wait for window reset
   done
   # After 10,000+ requests over 100 minutes, the IP is still treated as normal
   ```

## Impact Assessment

- **Distributed attack effectiveness**: An attacker with N IP addresses can multiply their impact by N, as there is no coordination between rate limiters.
- **Federation-wide blind spot**: VPS servers operate independently for rate limiting, allowing an attacker to distribute their attack across the federation without any server knowing the global scope.
- **Reputation-free fresh starts**: Every isolate eviction, process restart, or window reset gives attackers a clean slate, rewarding persistence.
- **Volumetric blindness**: Sophisticated attacks that stay just under rate limits (e.g., 99 requests per minute, every minute, for hours) are invisible to the current system.
- **No incident response**: There is no mechanism to globally block an IP across the federation in response to a detected attack.

## Proposed Fix

### Phase 1: Durable Reputation on CF Worker (using Cache API)

```javascript
// packages/server/src/reputation.js
export class IPReputationManager {
  constructor(cacheApi) {
    this.cache = cacheApi;
    this.localScores = new Map(); // Local cache for hot IPs
  }

  async getScore(ip) {
    // Check local cache first
    if (this.localScores.has(ip)) return this.localScores.get(ip);

    // Check CF Cache API (shared across isolates)
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const cached = await this.cache.match(cacheKey);
    if (cached) {
      const data = await cached.json();
      this.localScores.set(ip, data.score);
      return data.score;
    }
    return 0;
  }

  async incrementScore(ip, points, ttlSeconds = 3600) {
    const current = await this.getScore(ip);
    const newScore = current + points;
    this.localScores.set(ip, newScore);

    // Persist to CF Cache (shared across isolates)
    const cacheKey = new Request(`https://reputation.internal/${ip}`);
    const response = new Response(JSON.stringify({ score: newScore, updatedAt: Date.now() }), {
      headers: { 'Cache-Control': `max-age=${ttlSeconds}` },
    });
    await this.cache.put(cacheKey, response);
    return newScore;
  }

  getRateLimit(score, baseTier) {
    if (score >= 30) return { limit: 0, windowMs: 300000 }; // Blocked 5 min
    if (score >= 15) return { limit: Math.floor(baseTier.limit * 0.1), windowMs: baseTier.windowMs };
    if (score >= 5) return { limit: Math.floor(baseTier.limit * 0.5), windowMs: baseTier.windowMs };
    return baseTier;
  }
}
```

### Phase 2: VPS Persistent Reputation (using SQLite)

```typescript
// packages/server-vps/src/reputation/ip-reputation.ts
export class VPSReputationManager {
  constructor(private storage: Storage) {}

  async recordEvent(ip: string, eventType: 'rate_limit_hit' | 'connection_rejected' | 'invalid_request' | 'successful_attestation') {
    const points = {
      rate_limit_hit: 2,
      connection_rejected: 3,
      invalid_request: 5,
      successful_attestation: -1,
    }[eventType];

    await this.storage.incrementReputation(ip, points);
  }

  async getScore(ip: string): Promise<number> {
    return await this.storage.getReputation(ip);
  }
}
```

### Phase 3: Federation Threat Sharing (gossip extension)

```typescript
// New gossip message type: THREAT_INTEL
interface ThreatIntelMessage {
  type: 'gossip';
  subtype: 'threat_intel';
  data: {
    blockedIPs: Array<{ ip: string; score: number; reason: string; expiresAt: number }>;
    attackPatterns: Array<{ pattern: string; severity: 'low' | 'medium' | 'high'; detectedAt: number }>;
  };
}
```

### Phase 4: CF Worker Aggregation from VPS Heartbeats

Extend the heartbeat body to include threat data:
```javascript
// VPS heartbeat payload extension:
{
  serverId: "...",
  connections: 42,
  // ... existing metrics
  threatData: {
    blockedIPs: ["1.2.3.4", "5.6.7.8"],
    recentAttackPatterns: ["pair_request_flood"],
  }
}
```

The CF Worker aggregates this data across all VPS heartbeats and stores it in DO storage for cross-request use.

## Acceptance Criteria

- [ ] CF Worker maintains IP reputation scores in Cache API (survives isolate eviction)
- [ ] Reputation score increases on rate limit hits, invalid requests, and connection rejections
- [ ] Reputation score decreases on successful attestation and normal behavior
- [ ] High-reputation IPs face progressively stricter rate limits (50%, 10%, blocked)
- [ ] VPS server persists IP reputation in SQLite (survives PM2 restart)
- [ ] VPS servers share blocked IP lists via gossip protocol (new message type)
- [ ] CF Worker aggregates threat data from VPS heartbeats
- [ ] Reputation scores decay over time (e.g., halve every 24 hours without new events)
- [ ] An IP blocked on any VPS server is warned/blocked on all VPS servers within one gossip cycle
- [ ] Admin endpoint to view and override reputation scores
- [ ] Reputation data has privacy controls (IP addresses are hashed in stored logs)

## Test Requirements

1. **Score accumulation**: Simulate 10 rate limit hits, verify score increases correctly
2. **Progressive response**: IP at score 0 gets full rate limit; at score 10 gets 50%; at score 20 gets 10%; at score 30 gets blocked
3. **Score decay**: Set score to 30, advance time by 24 hours, verify score halved
4. **Cross-isolate persistence**: Set score on CF Worker, simulate isolate eviction (new Map), verify score survives via Cache API
5. **Cross-VPS sharing**: Block IP on VPS-A, verify VPS-B receives the block via gossip within one cycle
6. **Good behavior credit**: Successful attestation reduces score
7. **False positive recovery**: Manually reset reputation score via admin endpoint

## Dependencies

- Depends on: Story 011 (Per-Endpoint Rate Limiting) -- reputation scoring builds on the per-endpoint rate limit infrastructure
- Depends on: Story 015 (VPS Reverse Proxy) -- nginx rate limiting provides a first layer; reputation scoring is the application-layer second layer
- Related: Story 019 (DO Sharding) -- reputation data needs to be accessible from the correct DO shard
- Related: Story 017 (Transparency Log) -- reputation score changes could be logged in the transparency log for audit
