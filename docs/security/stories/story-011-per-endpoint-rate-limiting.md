# Story 011: Per-Endpoint and Per-ServerId Rate Limiting

## Priority: THIS SPRINT
## Severity: HIGH
## Component: packages/server

## Summary

The Cloudflare Worker bootstrap server applies a single global rate limit of 100 requests/minute/IP across all endpoints, with no differentiation between cheap endpoints (e.g., `GET /health`) and expensive endpoints (e.g., `POST /attest/verify` which performs Ed25519 signature verification and HMAC computation). The rate limit counters are stored in an in-memory `Map` on a singleton `RateLimiter` instance, which is lost when the Worker isolate is evicted by Cloudflare's runtime. This means an attacker who triggers isolate eviction (or simply waits for it) gets a fresh rate limit budget.

## Current Behavior

**Rate limiter implementation** (`packages/server/src/rate-limiter.js`, lines 9-57):
- The `RateLimiter` class uses an in-memory `Map<string, {count, resetAt}>` (line 11).
- The `check(ip, limit, windowMs)` method applies a single counter per IP address (line 23).
- A singleton instance is exported at line 57: `export const rateLimiter = new RateLimiter()`.

**Usage in the Worker entry point** (`packages/server/src/index.js`, lines 32-34):
```javascript
const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
const { allowed } = rateLimiter.check(ip, 100, 60000);
```
- Every request, regardless of method or endpoint, consumes from the same 100-request/minute budget per IP.
- An attacker can exhaust their budget with 100 `GET /health` requests, then be blocked from legitimate `POST /attest/verify` calls -- or conversely, an attacker can burn all 100 requests on computationally expensive `POST /attest/verify` calls to maximize resource consumption.
- The `CF-Connecting-IP` header falls back to the string `'unknown'` if absent, meaning all requests without this header share a single counter.
- Pruning is probabilistic: `Math.random() < 0.01` on line 43 means stale entries may persist, and memory growth is only addressed ~1% of the time.

**No per-serverId limits**:
- The `POST /servers/heartbeat` endpoint (proxied to the ServerRegistryDO) performs anomaly detection, storage reads/writes, and fleet-wide analysis on every call.
- A rogue VPS server can heartbeat at maximum rate (100/min) with no separate throttle for the heartbeat path.
- `POST /servers` (registration) has the same budget as `GET /servers` (public list), despite the former writing to DO storage.

## Expected Behavior

1. Rate limits should be differentiated by endpoint sensitivity:
   - Read-only public endpoints (`GET /health`, `GET /servers`, `GET /attest/versions`): 200 req/min/IP
   - Write endpoints (`POST /servers`, `POST /servers/heartbeat`, `DELETE /servers/:id`): 30 req/min/IP
   - Attestation endpoints (`POST /attest/register`, `POST /attest/challenge`, `POST /attest/verify`): 20 req/min/IP
   - Admin/CI endpoints (`POST /servers/trusted-keys`, `POST /attest/versions`, `POST /attest/upload-reference`): 10 req/min/IP

2. Authenticated server endpoints should additionally rate limit per `serverId` to prevent a single compromised server from overwhelming the registry.

3. The `'unknown'` IP fallback should be rejected (return 400) rather than sharing a single counter, preventing a trivial bypass where an attacker strips the `CF-Connecting-IP` header (though Cloudflare typically always sets this).

4. Rate limit state should optionally be backed by Durable Object storage or Cloudflare's `Cache` API to survive isolate eviction for critical endpoints.

## Root Cause Analysis

The rate limiter was designed as a "best-effort defense layer" (as stated in the file's JSDoc comment on line 5) for the initial single-purpose server registry. As the server grew to include attestation, build signing, and anomaly detection, the single 100 req/min/IP limit was never revisited.

The key design issues:
1. **Flat rate structure**: The `check()` method signature accepts `limit` and `windowMs` parameters, but the caller in `index.js` invokes it with fixed values for all paths.
2. **Isolate-local state**: Cloudflare Workers can evict isolates at any time; the in-memory `Map` is wiped, giving every attacker a fresh budget.
3. **No endpoint awareness**: The rate limiter has no concept of request path or method. Adding this in the current architecture requires the caller to use different keys or multiple `RateLimiter` instances.
4. **No serverId tracking**: Authenticated endpoints don't pass the authenticated identity to the rate limiter.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/rate-limiter.js` | 1-57 | Entire rate limiter implementation |
| `packages/server/src/index.js` | 32-34 | Single rate limit check for all endpoints |
| `packages/server/src/index.js` | 42-44 | Probabilistic pruning |
| `packages/server/src/index.js` | 99-157 | All endpoint routing (no per-route limits) |
| `packages/server/src/durable-objects/server-registry-do.js` | 706-841 | Heartbeat handler (expensive, no per-serverId limit) |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 671-822 | Verify handler (crypto-heavy, no separate limit) |

## Reproduction Steps

1. **Exhaust budget with cheap requests**:
   ```bash
   for i in $(seq 1 100); do curl -s https://bootstrap.example.com/health > /dev/null; done
   curl -s https://bootstrap.example.com/attest/challenge  # 429 Too Many Requests
   ```

2. **Maximize compute cost**:
   ```bash
   for i in $(seq 1 100); do
     curl -s -X POST https://bootstrap.example.com/attest/verify \
       -H 'Content-Type: application/json' \
       -d '{"device_id":"test","nonce":"fake","responses":[]}'
   done
   ```
   Each call triggers JSON parsing, DO stub instantiation, storage reads, and potentially HMAC computation.

3. **Isolate eviction bypass**: Wait 30-60 seconds for Cloudflare to evict the idle isolate, then the counter resets.

4. **Unknown IP bypass**: If any path exists where `CF-Connecting-IP` is not set (unlikely on Cloudflare, but possible in dev/test), all such requests share the `'unknown'` key.

## Impact Assessment

- **Resource exhaustion**: An attacker can maximize the cost of their 100 allowed requests by targeting `POST /attest/verify` (Ed25519 + HMAC + DO storage) or `POST /servers/heartbeat` (anomaly detection + fleet analysis).
- **Legitimate user lockout**: A user who makes many read requests (e.g., polling `GET /servers`) gets locked out of write endpoints within the same window.
- **Coordinated attack**: Multiple IPs can each send 100 requests to crypto-heavy endpoints, limited only by Cloudflare's global infrastructure cost protections.
- **Heartbeat flooding**: A compromised VPS server can send 100 heartbeats/minute with manipulated metrics, poisoning anomaly scores for the entire fleet.
- **State loss on eviction**: Rate limits are wiped unpredictably, creating windows where an attacker faces no limits at all.

## Proposed Fix

### 1. Refactor `RateLimiter` to support composite keys

```javascript
// rate-limiter.js
export class RateLimiter {
  constructor() {
    this.counters = new Map();
  }

  /**
   * @param {string} key - Composite key (e.g., "ip:endpoint" or "serverId:heartbeat")
   * @param {number} limit
   * @param {number} windowMs
   */
  check(key, limit, windowMs) {
    // ... same sliding window logic
  }
}
```

### 2. Define per-endpoint rate limit tiers in `index.js`

```javascript
const RATE_LIMITS = {
  read:   { limit: 200, windowMs: 60000 },  // GET /health, GET /servers, GET /attest/versions
  write:  { limit: 30,  windowMs: 60000 },  // POST /servers, heartbeat, DELETE
  attest: { limit: 20,  windowMs: 60000 },  // POST /attest/*
  admin:  { limit: 10,  windowMs: 60000 },  // POST /servers/trusted-keys, POST /attest/versions
};

function getEndpointTier(method, pathname) {
  if (method === 'GET' || method === 'OPTIONS') return 'read';
  if (pathname.startsWith('/attest')) return 'attest';
  if (pathname === '/servers/trusted-keys' || pathname === '/attest/versions') return 'admin';
  return 'write';
}
```

### 3. Apply per-endpoint check

```javascript
const tier = getEndpointTier(request.method, url.pathname);
const { limit, windowMs } = RATE_LIMITS[tier];
const { allowed } = rateLimiter.check(`${ip}:${tier}`, limit, windowMs);
```

### 4. Add per-serverId rate limiting in DO

In `server-registry-do.js`, after authentication:
```javascript
// Per-serverId heartbeat limit: 2 per minute
const hbKey = `heartbeat-rl:${serverId}`;
const hbEntry = await this.state.storage.get(hbKey);
const now = Date.now();
if (hbEntry && now - hbEntry.timestamp < 60000 && hbEntry.count >= 2) {
  return new Response(JSON.stringify({ error: 'Heartbeat rate limit exceeded' }),
    { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
await this.state.storage.put(hbKey, {
  count: (hbEntry && now - hbEntry.timestamp < 60000) ? hbEntry.count + 1 : 1,
  timestamp: (hbEntry && now - hbEntry.timestamp < 60000) ? hbEntry.timestamp : now,
});
```

### 5. Reject unknown IPs

```javascript
const ip = request.headers.get('CF-Connecting-IP');
if (!ip) {
  return new Response(JSON.stringify({ error: 'Missing client IP' }),
    { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
```

## Acceptance Criteria

- [ ] Rate limiter accepts a composite key (IP + endpoint tier) instead of just IP
- [ ] At least 4 rate limit tiers are defined: read, write, attest, admin
- [ ] Each tier has independently configurable `limit` and `windowMs` values
- [ ] `POST /servers/heartbeat` enforces a per-serverId rate limit (max 2/min) in DO storage
- [ ] Requests without `CF-Connecting-IP` are rejected with 400
- [ ] Rate limit response includes `Retry-After` header with seconds until the window resets
- [ ] Rate limit response includes `X-RateLimit-Remaining` header
- [ ] Pruning runs deterministically (e.g., every 100th request) instead of probabilistically
- [ ] Existing tests continue to pass
- [ ] New unit tests cover all rate limit tiers

## Test Requirements

1. **Unit tests for `RateLimiter`**:
   - Verify that different composite keys have independent counters
   - Verify that exceeding one tier doesn't affect another tier for the same IP
   - Verify window expiry resets counters
   - Verify pruning removes all expired entries

2. **Integration tests for per-endpoint limits**:
   - Send requests to different endpoints and verify correct tier assignment
   - Verify 429 response includes `Retry-After` and `X-RateLimit-Remaining`
   - Verify `GET /health` (read tier) doesn't count against `POST /attest/verify` (attest tier)

3. **Per-serverId heartbeat limit test**:
   - Send 3 heartbeats from the same serverId within 1 minute, verify the 3rd is rejected
   - Verify different serverIds have independent limits
   - Verify limit resets after 1 minute

4. **Missing IP rejection test**:
   - Send a request without `CF-Connecting-IP`, verify 400 response

## Dependencies

- Blocks: Story 020 (IP Reputation Scoring) -- reputation scoring will build on the per-endpoint rate limit infrastructure
- Related: Story 019 (DO Sharding) -- rate limit state in DO storage needs to consider the sharding model
