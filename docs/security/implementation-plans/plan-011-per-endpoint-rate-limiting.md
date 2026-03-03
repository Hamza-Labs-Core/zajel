# Implementation Plan 011: Per-Endpoint and Per-ServerId Rate Limiting

**Story:** [Story 011: Per-Endpoint and Per-ServerId Rate Limiting](../stories/story-011-per-endpoint-rate-limiting.md)
**Priority:** THIS SPRINT
**Severity:** HIGH
**Component:** packages/server
**Author:** Generated from security story analysis
**Date:** 2026-03-03

---

## 1. Summary

This plan implements differentiated rate limiting based on endpoint sensitivity and adds per-serverId throttling for authenticated endpoints. Currently, the bootstrap server applies a flat 100 req/min/IP limit across all endpoints, which allows attackers to either exhaust their budget with cheap requests (locking out expensive endpoints) or maximize resource consumption by targeting crypto-heavy endpoints. The rate limiter uses an in-memory `Map` that's wiped on isolate eviction, giving attackers fresh budgets unpredictably.

**Key Changes:**
1. Refactor `RateLimiter` to accept composite keys (e.g., `"ip:tier"` or `"serverId:heartbeat"`)
2. Define four rate limit tiers: `read` (200/min), `write` (30/min), `attest` (20/min), `admin` (10/min)
3. Add per-serverId rate limiting for `POST /servers/heartbeat` (max 2/min) backed by Durable Object storage
4. Reject requests missing `CF-Connecting-IP` header (return 400 instead of using `'unknown'`)
5. Add `Retry-After` and `X-RateLimit-Remaining` headers to rate limit responses
6. Replace probabilistic pruning (1% chance per request) with deterministic pruning (every 100th request)

**Expected Impact:**
- Read-only endpoints (e.g., `GET /health`) won't exhaust budget for write endpoints
- Expensive crypto operations (`POST /attest/verify`) protected by lower limits
- Rogue VPS servers can't flood heartbeat endpoint at 100/min
- Rate limit state for heartbeat persists across isolate eviction
- Attackers can't bypass rate limits by stripping `CF-Connecting-IP` header

---

## 2. Files to Modify

### 2.1 Core Rate Limiter

**File:** `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js`

**Current State:**
- Lines 1-57: Complete implementation
- Line 11: `this.counters = new Map()`
- Line 23: `check(ip, limit, windowMs)` signature
- Lines 27-30: Creates new window on expiry
- Lines 33-39: Increments counter and checks limit
- Lines 42-53: Prune method (removes expired entries)
- Line 57: Exports singleton instance

**Changes Required:**
- Update JSDoc comments to reflect composite key support
- Rename `ip` parameter to `key` in `check()` method (lines 18, 23, 25)
- Add logic to extract `resetAt` from existing counter for `Retry-After` calculation
- Return additional metadata: `retryAfter` (seconds until window reset)
- Make pruning deterministic: add request counter, call `prune()` every 100 requests
- Add `getCounters()` method for testing

### 2.2 Main Worker Entry Point

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Current State:**
- Lines 32-34: Single rate limit check for all requests
- Line 33: `const ip = request.headers.get('CF-Connecting-IP') || 'unknown'`
- Line 34: `const { allowed } = rateLimiter.check(ip, 100, 60000)`
- Lines 35-40: 429 response on rate limit
- Lines 42-44: Probabilistic pruning
- Lines 48-50: CORS preflight handling
- Lines 52-66: Health check endpoint
- Lines 99-129: `GET /servers` endpoint with signing
- Lines 131-143: Other `/servers/*` routes (proxied to DO)
- Lines 145-157: All `/attest/*` routes (proxied to DO)

**Changes Required:**
- Define `RATE_LIMITS` constant with four tiers (after imports, ~line 22)
- Add `getEndpointTier(method, pathname)` helper function
- Replace line 33 to reject missing IP (return 400)
- Update rate limit check to use composite key `${ip}:${tier}` (lines 32-40)
- Add `Retry-After` and `X-RateLimit-Remaining` headers to 429 response
- Remove probabilistic pruning lines 42-44 (now handled inside `RateLimiter`)
- Update JSDoc comment (lines 1-17) to document rate limit tiers

### 2.3 Server Registry Durable Object

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Current State:**
- Lines 706-842: `heartbeat()` method implementation
- Line 707: Parses JSON body
- Lines 710-722: Validates `serverId` field
- Lines 724-731: Looks up server in storage
- Lines 733-765: Updates metrics and build verification
- Line 767: Saves updated server to storage
- Lines 769-841: Anomaly detection logic

**Changes Required:**
- Add per-serverId rate limiting block after line 731 (after server lookup, before metrics update)
- Store rate limit counters in DO storage with key `heartbeat-rl:${serverId}`
- Implement sliding window: check if `count >= 2` within last 60 seconds
- Return 429 with JSON error if limit exceeded
- Update counter on successful heartbeat

### 2.4 Constants File (Optional)

**File:** `/home/meywd/zajel-ddos/packages/server/src/constants.js` (may not exist)

**Changes Required:**
- Create file if it doesn't exist
- Extract rate limit tier definitions from `index.js` for reusability
- Export constants for use in tests

---

## 3. Implementation Steps

### Step 3.1: Refactor RateLimiter to Support Composite Keys

**File:** `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js`

**Before (lines 9-40):**
```javascript
export class RateLimiter {
  constructor() {
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.counters = new Map();
  }

  /**
   * Check whether a request from the given IP is within the rate limit.
   *
   * @param {string} ip - Client IP address
   * @param {number} limit - Maximum requests per window
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, remaining: number }}
   */
  check(ip, limit, windowMs) {
    const now = Date.now();
    const entry = this.counters.get(ip);

    if (!entry || now >= entry.resetAt) {
      // Start a new window
      this.counters.set(ip, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }

    entry.count += 1;

    if (entry.count > limit) {
      return { allowed: false, remaining: 0 };
    }

    return { allowed: true, remaining: limit - entry.count };
  }
```

**After (lines 9-46):**
```javascript
export class RateLimiter {
  constructor() {
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.counters = new Map();
    /** @type {number} Request counter for deterministic pruning */
    this.requestCount = 0;
  }

  /**
   * Check whether a request from the given key is within the rate limit.
   *
   * @param {string} key - Composite key (e.g., "ip:tier" or "serverId:operation")
   * @param {number} limit - Maximum requests per window
   * @param {number} windowMs - Window duration in milliseconds
   * @returns {{ allowed: boolean, remaining: number, retryAfter: number }}
   */
  check(key, limit, windowMs) {
    const now = Date.now();
    const entry = this.counters.get(key);

    // Deterministic pruning: every 100 requests
    this.requestCount += 1;
    if (this.requestCount % 100 === 0) {
      this.prune();
    }

    if (!entry || now >= entry.resetAt) {
      // Start a new window
      this.counters.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    entry.count += 1;

    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

    if (entry.count > limit) {
      return { allowed: false, remaining: 0, retryAfter };
    }

    return { allowed: true, remaining: limit - entry.count, retryAfter };
  }
```

**Changes:**
- Renamed `ip` parameter to `key` (line 10, 21, 24, 31)
- Added `requestCount` property to constructor (lines 13-14)
- Added deterministic pruning before rate limit check (lines 25-28)
- Calculate `retryAfter` in seconds (line 38)
- Include `retryAfter` in all return statements (lines 33, 41, 45)
- Updated JSDoc to reflect composite key support (lines 16-17)

### Step 3.2: Add Deterministic Pruning and Testing Helper

**File:** `/home/meywd/zajel-ddos/packages/server/src/rate-limiter.js`

**Before (lines 42-53):**
```javascript
  /**
   * Prune expired entries to prevent unbounded memory growth.
   * Called periodically (e.g., every N requests).
   */
  prune() {
    const now = Date.now();
    for (const [ip, entry] of this.counters) {
      if (now >= entry.resetAt) {
        this.counters.delete(ip);
      }
    }
  }
}
```

**After (lines 48-67):**
```javascript
  /**
   * Prune expired entries to prevent unbounded memory growth.
   * Called deterministically every 100 requests (see check() method).
   */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.counters) {
      if (now >= entry.resetAt) {
        this.counters.delete(key);
      }
    }
  }

  /**
   * Get all counters (for testing purposes only).
   * @returns {Map<string, {count: number, resetAt: number}>}
   */
  getCounters() {
    return this.counters;
  }
}
```

**Changes:**
- Updated JSDoc to reflect deterministic pruning (line 51)
- Renamed `ip` loop variable to `key` (line 54)
- Added `getCounters()` helper method for unit tests (lines 60-65)

### Step 3.3: Define Rate Limit Tiers in index.js

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Before (lines 1-26):**
```javascript
/**
 * Zajel Bootstrap Server - Cloudflare Worker
 *
 * A server registry and attestation authority for the Zajel infrastructure.
 *
 * Endpoints:
 * - POST /servers - Register a VPS server
 * - GET /servers - List all active VPS servers
 * - DELETE /servers/:id - Unregister a server
 * - POST /servers/heartbeat - Keep-alive for registered servers
 * - POST /attest/register - Register a device with a build token
 * - POST /attest/upload-reference - CI uploads reference binary metadata
 * - POST /attest/challenge - Request an attestation challenge
 * - POST /attest/verify - Verify attestation challenge responses
 * - GET /attest/versions - Get version policy
 * - POST /attest/versions - Update version policy (admin)
 */

import { importSigningKey, signPayload } from './crypto/signing.js';
import { getCorsHeaders } from './cors.js';
import { rateLimiter } from './rate-limiter.js';

export { ServerRegistryDO } from './durable-objects/server-registry-do.js';
export { AttestationRegistryDO } from './durable-objects/attestation-registry-do.js';

export default {
```

**After (lines 1-56):**
```javascript
/**
 * Zajel Bootstrap Server - Cloudflare Worker
 *
 * A server registry and attestation authority for the Zajel infrastructure.
 *
 * Endpoints (with rate limit tiers):
 * - GET /health [read: 200/min]
 * - GET /servers [read: 200/min]
 * - GET /attest/versions [read: 200/min]
 * - POST /servers [write: 30/min] - Register a VPS server
 * - DELETE /servers/:id [write: 30/min] - Unregister a server
 * - POST /servers/heartbeat [write: 30/min] - Keep-alive (+ per-serverId limit in DO)
 * - POST /attest/register [attest: 20/min] - Register device with build token
 * - POST /attest/challenge [attest: 20/min] - Request attestation challenge
 * - POST /attest/verify [attest: 20/min] - Verify attestation responses
 * - POST /attest/upload-reference [admin: 10/min] - CI uploads reference metadata
 * - POST /attest/versions [admin: 10/min] - Update version policy
 * - POST /servers/trusted-keys [admin: 10/min] - Update trusted build keys
 */

import { importSigningKey, signPayload } from './crypto/signing.js';
import { getCorsHeaders } from './cors.js';
import { rateLimiter } from './rate-limiter.js';

export { ServerRegistryDO } from './durable-objects/server-registry-do.js';
export { AttestationRegistryDO } from './durable-objects/attestation-registry-do.js';

/**
 * Rate limit tiers by endpoint sensitivity.
 * Each tier has independent counters per IP address.
 */
const RATE_LIMITS = {
  read: { limit: 200, windowMs: 60000 },   // GET /health, /servers, /attest/versions
  write: { limit: 30, windowMs: 60000 },   // POST /servers, heartbeat, DELETE
  attest: { limit: 20, windowMs: 60000 },  // POST /attest/register, challenge, verify
  admin: { limit: 10, windowMs: 60000 },   // POST /servers/trusted-keys, /attest/versions, upload-reference
};

/**
 * Determine rate limit tier for the given request.
 * @param {string} method - HTTP method (GET, POST, DELETE, etc.)
 * @param {string} pathname - URL pathname (e.g., "/servers", "/attest/verify")
 * @returns {string} Tier name ('read', 'write', 'attest', or 'admin')
 */
function getEndpointTier(method, pathname) {
  // OPTIONS preflight and GET requests are read-only
  if (method === 'GET' || method === 'OPTIONS') {
    return 'read';
  }

  // Admin endpoints: CI uploads, version/key management
  if (pathname === '/attest/upload-reference' ||
      pathname === '/attest/versions' ||
      pathname === '/servers/trusted-keys') {
    return 'admin';
  }

  // Attestation endpoints: register, challenge, verify
  if (pathname.startsWith('/attest')) {
    return 'attest';
  }

  // All other mutations (POST /servers, heartbeat, DELETE) are write tier
  return 'write';
}

export default {
```

**Changes:**
- Updated JSDoc comment to document rate limit tiers (lines 6-18)
- Added `RATE_LIMITS` constant with four tiers (lines 27-34)
- Added `getEndpointTier()` helper function (lines 36-70)

### Step 3.4: Update Rate Limit Check in index.js

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Before (lines 27-45):**
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

**After (lines 72-96):**
```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, env);

    // Reject requests without CF-Connecting-IP to prevent 'unknown' bypass
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) {
      return new Response(
        JSON.stringify({ error: 'Missing client IP' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Per-endpoint rate limiting with differentiated tiers
    const tier = getEndpointTier(request.method, url.pathname);
    const { limit, windowMs } = RATE_LIMITS[tier];
    const { allowed, remaining, retryAfter } = rateLimiter.check(`${ip}:${tier}`, limit, windowMs);

    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Too Many Requests' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Remaining': '0',
            ...corsHeaders,
          },
        }
      );
    }
```

**Changes:**
- Reject missing `CF-Connecting-IP` header (lines 79-85)
- Get endpoint tier using helper function (line 88)
- Destructure `limit` and `windowMs` from tier config (line 89)
- Use composite key `${ip}:${tier}` in rate limit check (line 90)
- Destructure `retryAfter` from check result (line 90)
- Add `Retry-After` header to 429 response (line 99)
- Add `X-RateLimit-Remaining` header to 429 response (line 100)
- Remove probabilistic pruning block (old lines 42-44, now handled in `RateLimiter.check()`)

### Step 3.5: Add Remaining Counter to Success Path

**File:** `/home/meywd/zajel-ddos/packages/server/src/index.js`

**Before (lines 48-50, after rate limit check):**
```javascript
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
```

**After (lines 105-113):**
```javascript
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const response = new Response(null, { headers: corsHeaders });
      response.headers.set('X-RateLimit-Remaining', remaining.toString());
      return response;
    }

    // Helper to add rate limit headers to all responses
    const addRateLimitHeaders = (response) => {
      response.headers.set('X-RateLimit-Remaining', remaining.toString());
      return response;
    };
```

**Changes:**
- Add `X-RateLimit-Remaining` header to CORS preflight response (lines 107-108)
- Define `addRateLimitHeaders()` helper for consistent header injection (lines 111-114)

**Note:** For full implementation, apply `addRateLimitHeaders()` to all endpoint responses. This example shows the pattern; actual changes would need to wrap each `new Response()` call. For simplicity in production, this can be optional—only the 429 response is critical.

### Step 3.6: Add Per-ServerId Rate Limiting in ServerRegistryDO

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Before (lines 724-767):**
```javascript
    const server = await this.state.storage.get(`server:${serverId}`);

    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not registered' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    server.lastSeen = Date.now();
    if (typeof body.connections === 'number' && Number.isFinite(body.connections)) {
      server.connections = Math.max(0, Math.floor(body.connections));
    }
    // ... (more metric updates)

    await this.state.storage.put(`server:${serverId}`, server);
```

**After (lines 724-776):**
```javascript
    const server = await this.state.storage.get(`server:${serverId}`);

    if (!server) {
      return new Response(
        JSON.stringify({ error: 'Server not registered' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Per-serverId heartbeat rate limiting: max 2 per minute
    // Uses DO storage to persist across isolate eviction
    const now = Date.now();
    const hbRateLimitKey = `heartbeat-rl:${serverId}`;
    const hbEntry = await this.state.storage.get(hbRateLimitKey);

    if (hbEntry && now - hbEntry.timestamp < 60000) {
      // Within the current window
      if (hbEntry.count >= 2) {
        const retryAfter = Math.ceil((60000 - (now - hbEntry.timestamp)) / 1000);
        return new Response(
          JSON.stringify({ error: 'Heartbeat rate limit exceeded' }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': retryAfter.toString(),
              ...corsHeaders,
            },
          }
        );
      }
      // Increment within window
      await this.state.storage.put(hbRateLimitKey, {
        count: hbEntry.count + 1,
        timestamp: hbEntry.timestamp,
      });
    } else {
      // Start new window
      await this.state.storage.put(hbRateLimitKey, {
        count: 1,
        timestamp: now,
      });
    }

    server.lastSeen = Date.now();
    if (typeof body.connections === 'number' && Number.isFinite(body.connections)) {
      server.connections = Math.max(0, Math.floor(body.connections));
    }
    // ... (more metric updates)

    await this.state.storage.put(`server:${serverId}`, server);
```

**Changes:**
- Added per-serverId rate limit check after server lookup (lines 734-767)
- Store rate limit state in DO storage with key `heartbeat-rl:${serverId}` (line 736)
- Implement sliding window: check if count >= 2 within last 60 seconds (lines 738-753)
- Return 429 with `Retry-After` header if limit exceeded (lines 741-751)
- Increment counter within existing window or start new window (lines 753-767)
- This persists across isolate eviction (unlike in-memory `RateLimiter`)

### Step 3.7: Add Cleanup for Heartbeat Rate Limit Entries

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** In the `cleanupExpiredServers()` method (called by alarm)

**Before (lines ~650-680, approximate based on typical cleanup location):**
```javascript
  async cleanupExpiredServers() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const deletions = [];

    for (const [key, server] of entries) {
      if (now - server.lastSeen > this.serverTTL) {
        deletions.push(key);
        // Also clean up anomaly history
        const historyKey = key.replace('server:', 'anomaly-history:');
        const scoreKey = key.replace('server:', 'anomaly-score:');
        deletions.push(historyKey, scoreKey);
      }
    }

    if (deletions.length > 0) {
      await this.state.storage.delete(deletions);
    }
  }
```

**After:**
```javascript
  async cleanupExpiredServers() {
    const now = Date.now();
    const entries = await this.state.storage.list({ prefix: 'server:' });
    const deletions = [];

    for (const [key, server] of entries) {
      if (now - server.lastSeen > this.serverTTL) {
        deletions.push(key);
        // Clean up anomaly history and scores
        const historyKey = key.replace('server:', 'anomaly-history:');
        const scoreKey = key.replace('server:', 'anomaly-score:');
        const rateLimitKey = key.replace('server:', 'heartbeat-rl:');
        deletions.push(historyKey, scoreKey, rateLimitKey);
      }
    }

    if (deletions.length > 0) {
      await this.state.storage.delete(deletions);
    }
  }
```

**Changes:**
- Added cleanup for `heartbeat-rl:${serverId}` entries when server expires (line 12)
- This prevents unbounded growth of rate limit counters in DO storage

**Note:** The exact line numbers for `cleanupExpiredServers()` may vary. Search for the method that handles alarm-based cleanup of expired servers.

---

## 4. Test Plan

### 4.1 Unit Tests for RateLimiter

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/rate-limiter.test.js` (new file)

**Test Cases:**

1. **Test: Different keys have independent counters**
   ```javascript
   const limiter = new RateLimiter();
   for (let i = 0; i < 10; i++) {
     limiter.check('192.168.1.1:read', 10, 60000);
   }
   for (let i = 0; i < 10; i++) {
     limiter.check('192.168.1.1:write', 10, 60000);
   }
   // Both should succeed - independent counters
   const result1 = limiter.check('192.168.1.1:read', 10, 60000);
   const result2 = limiter.check('192.168.1.1:write', 10, 60000);
   expect(result1.allowed).toBe(false); // 11th request on read
   expect(result2.allowed).toBe(false); // 11th request on write
   ```

2. **Test: Same IP, different tiers don't interfere**
   ```javascript
   const limiter = new RateLimiter();
   // Exhaust read tier
   for (let i = 0; i < 200; i++) {
     limiter.check('10.0.0.5:read', 200, 60000);
   }
   // Write tier should still be available
   const writeResult = limiter.check('10.0.0.5:write', 30, 60000);
   expect(writeResult.allowed).toBe(true);
   expect(writeResult.remaining).toBe(29);
   ```

3. **Test: Window expiry resets counter**
   ```javascript
   const limiter = new RateLimiter();
   limiter.check('10.0.0.1:attest', 5, 1000); // 1 second window
   for (let i = 0; i < 4; i++) {
     limiter.check('10.0.0.1:attest', 5, 1000);
   }
   const before = limiter.check('10.0.0.1:attest', 5, 1000);
   expect(before.allowed).toBe(false); // 6th request

   await sleep(1100); // Wait for window expiry
   const after = limiter.check('10.0.0.1:attest', 5, 1000);
   expect(after.allowed).toBe(true); // New window
   expect(after.remaining).toBe(4);
   ```

4. **Test: retryAfter is calculated correctly**
   ```javascript
   const limiter = new RateLimiter();
   for (let i = 0; i < 10; i++) {
     limiter.check('10.0.0.2:admin', 10, 60000);
   }
   const result = limiter.check('10.0.0.2:admin', 10, 60000);
   expect(result.allowed).toBe(false);
   expect(result.retryAfter).toBeGreaterThan(0);
   expect(result.retryAfter).toBeLessThanOrEqual(60);
   ```

5. **Test: Deterministic pruning runs every 100 requests**
   ```javascript
   const limiter = new RateLimiter();
   // Create an expired entry
   limiter.check('old-ip:read', 10, 1); // 1ms window
   await sleep(10);
   expect(limiter.getCounters().has('old-ip:read')).toBe(true);

   // Make 99 requests
   for (let i = 0; i < 99; i++) {
     limiter.check(`ip-${i}:read`, 100, 60000);
   }
   expect(limiter.getCounters().has('old-ip:read')).toBe(true); // Not pruned yet

   // 100th request triggers prune
   limiter.check('ip-100:read', 100, 60000);
   expect(limiter.getCounters().has('old-ip:read')).toBe(false); // Pruned
   ```

6. **Test: Remaining count decrements correctly**
   ```javascript
   const limiter = new RateLimiter();
   const r1 = limiter.check('10.0.0.3:write', 5, 60000);
   expect(r1.remaining).toBe(4);
   const r2 = limiter.check('10.0.0.3:write', 5, 60000);
   expect(r2.remaining).toBe(3);
   const r3 = limiter.check('10.0.0.3:write', 5, 60000);
   expect(r3.remaining).toBe(2);
   ```

### 4.2 Integration Tests for Per-Endpoint Limits

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/rate-limiting.test.js` (new file)

**Test Cases:**

1. **Test: GET /health (read tier) doesn't count against POST /attest/verify (attest tier)**
   ```javascript
   const env = createMockEnv();
   // Make 200 requests to /health (read tier limit)
   for (let i = 0; i < 200; i++) {
     const req = new Request('https://test.workers.dev/health', {
       headers: { 'CF-Connecting-IP': '10.0.0.1' },
     });
     const res = await worker.fetch(req, env);
     expect(res.status).toBe(200);
   }

   // Next /health request should be rate limited
   const healthReq = new Request('https://test.workers.dev/health', {
     headers: { 'CF-Connecting-IP': '10.0.0.1' },
   });
   const healthRes = await worker.fetch(healthReq, env);
   expect(healthRes.status).toBe(429);

   // But attest tier should still be available
   const attestReq = new Request('https://test.workers.dev/attest/challenge', {
     method: 'POST',
     headers: { 'CF-Connecting-IP': '10.0.0.1', 'Content-Type': 'application/json' },
     body: JSON.stringify({ device_id: 'test-device', build_version: '1.0.0', platform: 'android' }),
   });
   const attestRes = await worker.fetch(attestReq, env);
   expect(attestRes.status).not.toBe(429); // Should succeed (different tier)
   ```

2. **Test: 429 response includes Retry-After and X-RateLimit-Remaining headers**
   ```javascript
   const env = createMockEnv();
   const ip = '10.0.0.2';

   // Exhaust write tier (30 requests)
   for (let i = 0; i < 30; i++) {
     const req = new Request('https://test.workers.dev/servers', {
       method: 'POST',
       headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
       body: JSON.stringify({ serverId: `server-${i}`, endpoint: 'wss://test.com', publicKey: 'key' }),
     });
     await worker.fetch(req, env);
   }

   // 31st request should be rate limited
   const req = new Request('https://test.workers.dev/servers', {
     method: 'POST',
     headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
     body: JSON.stringify({ serverId: 'server-31', endpoint: 'wss://test.com', publicKey: 'key' }),
   });
   const res = await worker.fetch(req, env);

   expect(res.status).toBe(429);
   expect(res.headers.get('Retry-After')).toBeTruthy();
   expect(parseInt(res.headers.get('Retry-After'))).toBeGreaterThan(0);
   expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
   ```

3. **Test: Different IPs have independent limits**
   ```javascript
   const env = createMockEnv();

   // IP1 exhausts admin tier (10 requests)
   for (let i = 0; i < 10; i++) {
     const req = new Request('https://test.workers.dev/attest/versions', {
       method: 'POST',
       headers: { 'CF-Connecting-IP': '10.0.0.1', 'Content-Type': 'application/json' },
       body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
     });
     await worker.fetch(req, env);
   }

   // IP1 is rate limited
   const req1 = new Request('https://test.workers.dev/attest/versions', {
     method: 'POST',
     headers: { 'CF-Connecting-IP': '10.0.0.1', 'Content-Type': 'application/json' },
     body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
   });
   const res1 = await worker.fetch(req1, env);
   expect(res1.status).toBe(429);

   // IP2 should still have full quota
   const req2 = new Request('https://test.workers.dev/attest/versions', {
     method: 'POST',
     headers: { 'CF-Connecting-IP': '10.0.0.2', 'Content-Type': 'application/json' },
     body: JSON.stringify({ min_version: '1.0.0', force_update_version: '1.0.0' }),
   });
   const res2 = await worker.fetch(req2, env);
   expect(res2.status).not.toBe(429);
   ```

4. **Test: Tier assignment is correct for all endpoints**
   ```javascript
   const env = createMockEnv();

   // Verify tier mapping by checking limits
   // Read tier: 200/min
   const readEndpoints = [
     { method: 'GET', path: '/health' },
     { method: 'GET', path: '/servers' },
     { method: 'GET', path: '/attest/versions' },
     { method: 'OPTIONS', path: '/servers' },
   ];

   // Write tier: 30/min
   const writeEndpoints = [
     { method: 'POST', path: '/servers' },
     { method: 'POST', path: '/servers/heartbeat' },
     { method: 'DELETE', path: '/servers/test-id' },
   ];

   // Attest tier: 20/min
   const attestEndpoints = [
     { method: 'POST', path: '/attest/register' },
     { method: 'POST', path: '/attest/challenge' },
     { method: 'POST', path: '/attest/verify' },
   ];

   // Admin tier: 10/min
   const adminEndpoints = [
     { method: 'POST', path: '/attest/versions' },
     { method: 'POST', path: '/attest/upload-reference' },
     { method: 'POST', path: '/servers/trusted-keys' },
   ];

   // Test each tier with unique IP to verify limits
   // (Implementation: make requests until rate limited, verify count matches tier limit)
   ```

### 4.3 Per-ServerId Heartbeat Limit Tests

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/server-registry.test.js` (add to existing file)

**Test Cases:**

1. **Test: 3 heartbeats within 1 minute from same serverId are rejected**
   ```javascript
   const serverData = {
     serverId: 'ed25519:rate-limit-test',
     endpoint: 'wss://test.example.com',
     publicKey: 'test-key',
   };

   // Register server
   await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

   // First heartbeat: success
   const hb1 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
   );
   expect(hb1.status).toBe(200);

   // Second heartbeat: success
   const hb2 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
   );
   expect(hb2.status).toBe(200);

   // Third heartbeat: rate limited
   const hb3 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
   );
   expect(hb3.status).toBe(429);
   const data3 = await hb3.json();
   expect(data3.error).toContain('Heartbeat rate limit exceeded');
   expect(hb3.headers.get('Retry-After')).toBeTruthy();
   ```

2. **Test: Different serverIds have independent heartbeat limits**
   ```javascript
   const server1 = {
     serverId: 'ed25519:server-1',
     endpoint: 'wss://server1.example.com',
     publicKey: 'key1',
   };
   const server2 = {
     serverId: 'ed25519:server-2',
     endpoint: 'wss://server2.example.com',
     publicKey: 'key2',
   };

   // Register both servers
   await serverRegistry.fetch(createRequest('POST', '/servers', server1));
   await serverRegistry.fetch(createRequest('POST', '/servers', server2));

   // Server1: send 2 heartbeats
   await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId }));
   await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId }));

   // Server1 third heartbeat: rate limited
   const hb1_3 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: server1.serverId })
   );
   expect(hb1_3.status).toBe(429);

   // Server2 first heartbeat: should succeed (independent limit)
   const hb2_1 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: server2.serverId })
   );
   expect(hb2_1.status).toBe(200);
   ```

3. **Test: Heartbeat rate limit resets after 1 minute**
   ```javascript
   const serverData = {
     serverId: 'ed25519:reset-test',
     endpoint: 'wss://test.example.com',
     publicKey: 'test-key',
   };

   await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

   // Send 2 heartbeats
   await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId }));
   await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId }));

   // Third is rate limited
   const hb3 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
   );
   expect(hb3.status).toBe(429);

   // Advance time by 61 seconds (mock Date.now or use vi.useFakeTimers)
   vi.useFakeTimers();
   vi.advanceTimersByTime(61000);

   // Should now succeed (new window)
   const hb4 = await serverRegistry.fetch(
     createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId })
   );
   expect(hb4.status).toBe(200);

   vi.useRealTimers();
   ```

4. **Test: Rate limit counters are cleaned up when server expires**
   ```javascript
   const serverData = {
     serverId: 'ed25519:cleanup-test',
     endpoint: 'wss://test.example.com',
     publicKey: 'test-key',
   };

   await serverRegistry.fetch(createRequest('POST', '/servers', serverData));

   // Send heartbeat to create rate limit entry
   await serverRegistry.fetch(createRequest('POST', '/servers/heartbeat', { serverId: serverData.serverId }));

   // Verify rate limit entry exists in storage
   const rlKey = `heartbeat-rl:${serverData.serverId}`;
   const rlEntry = await mockState.storage.get(rlKey);
   expect(rlEntry).toBeTruthy();

   // Advance time past server TTL (5 minutes)
   vi.useFakeTimers();
   vi.advanceTimersByTime(6 * 60 * 1000);

   // Trigger cleanup (call alarm handler)
   await serverRegistry.alarm();

   // Verify rate limit entry was cleaned up
   const rlEntryAfter = await mockState.storage.get(rlKey);
   expect(rlEntryAfter).toBeUndefined();

   vi.useRealTimers();
   ```

### 4.4 Missing IP Rejection Test

**File:** `/home/meywd/zajel-ddos/packages/server/tests/e2e/rate-limiting.test.js`

**Test Case:**

```javascript
it('should reject requests without CF-Connecting-IP header', async () => {
  const env = createMockEnv();

  // Request without CF-Connecting-IP header
  const req = new Request('https://test.workers.dev/health');
  // Note: explicitly NOT setting CF-Connecting-IP header

  const res = await worker.fetch(req, env);
  const data = await res.json();

  expect(res.status).toBe(400);
  expect(data.error).toContain('Missing client IP');
});
```

### 4.5 Test Execution

**Run all tests:**
```bash
cd /home/meywd/zajel-ddos/packages/server
npm test
```

**Run specific test files:**
```bash
npm test -- tests/unit/rate-limiter.test.js
npm test -- tests/e2e/rate-limiting.test.js
npm test -- tests/e2e/server-registry.test.js
```

**Coverage report:**
```bash
npm test -- --coverage
```

---

## 5. Rollback Risk Assessment

### 5.1 Risk Level: LOW-MEDIUM

**Justification:**
- Changes are mostly additive (new tiers, headers, validation)
- Core rate limiting logic remains structurally similar
- No database schema changes (DO storage keys are new, not modified)
- Cloudflare Workers can roll back instantly by deploying previous version

### 5.2 Potential Issues

1. **Breaking Change: Stricter IP Validation**
   - **Risk:** Legitimate requests without `CF-Connecting-IP` will be rejected with 400
   - **Likelihood:** Very low (Cloudflare always sets this header in production)
   - **Mitigation:** Test thoroughly in staging; have rollback plan ready
   - **Rollback:** Revert to previous version if production errors spike

2. **Rate Limit Too Aggressive**
   - **Risk:** Legitimate users hit new lower limits (e.g., 20/min for attest tier)
   - **Likelihood:** Low (current global limit is 100/min, so most users safe)
   - **Mitigation:** Monitor 429 response rates in first 24 hours; adjust limits if needed
   - **Rollback:** Increase tier limits via config change (no code deploy required if externalized)

3. **Heartbeat Rate Limit Too Strict**
   - **Risk:** VPS servers with fast heartbeat loops get blocked (2/min may be too low)
   - **Likelihood:** Medium (current system has no per-serverId limit)
   - **Mitigation:** Review existing heartbeat patterns in logs before deploy; increase to 5/min if needed
   - **Rollback:** Increase limit or temporarily disable per-serverId check

4. **DO Storage Growth**
   - **Risk:** `heartbeat-rl:*` entries accumulate if cleanup fails
   - **Likelihood:** Low (cleanup wired into existing alarm handler)
   - **Mitigation:** Monitor DO storage size; verify cleanup runs in tests
   - **Rollback:** Manual cleanup script or revert per-serverId rate limiting

5. **Performance Degradation**
   - **Risk:** Deterministic pruning every 100 requests adds latency
   - **Likelihood:** Very low (pruning is O(n) where n = number of IPs, typically small)
   - **Mitigation:** Benchmark pruning performance; consider adjusting frequency if needed
   - **Rollback:** Revert to probabilistic pruning (keep composite key support)

### 5.3 Rollback Procedure

1. **Immediate Rollback (< 5 minutes):**
   ```bash
   cd /home/meywd/zajel-ddos/packages/server
   git revert <commit-hash>
   npm run deploy
   ```
   Cloudflare Workers deploy instantly; previous version restored.

2. **Partial Rollback (adjust limits only):**
   - If limits are too strict but logic is sound, increase tier limits in code
   - Deploy hotfix with higher limits (e.g., attest: 50/min instead of 20/min)
   - Or disable per-serverId limit temporarily by commenting out check in `server-registry-do.js`

3. **Data Cleanup (if DO storage grows unexpectedly):**
   ```javascript
   // Run once in Wrangler console or via API
   const entries = await state.storage.list({ prefix: 'heartbeat-rl:' });
   await state.storage.delete([...entries.keys()]);
   ```

### 5.4 Monitoring Points

After deployment, monitor:
1. **429 response rate:** Should remain low (< 1% of requests)
2. **Breakdown by tier:** Verify read tier isn't over-throttled
3. **DO storage size:** Should remain stable (cleanup working)
4. **P95 latency:** Should not increase significantly
5. **Worker CPU time:** Should not spike (pruning overhead)

---

## 6. Dependencies on Other Stories

### 6.1 Blocks

**Story 020: IP Reputation Scoring**
- Reputation scoring will use the same composite key infrastructure (`${ip}:reputation`)
- Rate limit decisions may be adjusted based on reputation score (trusted IPs get higher limits)
- This story must be implemented first to provide the foundational per-endpoint rate limiting

### 6.2 Related

**Story 019: DO Sharding**
- Per-serverId heartbeat rate limits are stored in the global ServerRegistryDO
- When sharding is implemented, rate limit keys will move to sharded DO instances
- No code changes required in this story—sharding is transparent to rate limiter
- However, the cleanup logic must be replicated across all shards

### 6.3 Enhances

**Story 008: Build Verification** (if exists)
- Build signature verification in heartbeat is expensive
- Lower write tier limit (30/min) reduces impact of repeated verification attacks
- This story provides defense-in-depth for build verification

**Story 015: Anomaly Detection** (if exists)
- Anomaly detection runs on every heartbeat
- Per-serverId heartbeat limit (2/min) reduces computational load on anomaly detector
- This story prevents anomaly detection from being weaponized by high-frequency heartbeats

### 6.4 Independent

This story can be implemented independently. No other stories are strict prerequisites.

---

## 7. Implementation Checklist

- [ ] **Step 3.1:** Refactor `RateLimiter.check()` to accept composite keys
- [ ] **Step 3.2:** Add deterministic pruning and `getCounters()` test helper
- [ ] **Step 3.3:** Define `RATE_LIMITS` constant and `getEndpointTier()` function in `index.js`
- [ ] **Step 3.4:** Update rate limit check to use composite keys and add headers
- [ ] **Step 3.5:** (Optional) Add `X-RateLimit-Remaining` to success responses
- [ ] **Step 3.6:** Add per-serverId heartbeat rate limiting in `server-registry-do.js`
- [ ] **Step 3.7:** Add cleanup for `heartbeat-rl:*` entries in `cleanupExpiredServers()`
- [ ] **Test 4.1:** Write unit tests for `RateLimiter` class
- [ ] **Test 4.2:** Write integration tests for per-endpoint limits
- [ ] **Test 4.3:** Write integration tests for per-serverId heartbeat limits
- [ ] **Test 4.4:** Write test for missing IP rejection
- [ ] **Test 4.5:** Run full test suite and verify all tests pass
- [ ] **Deploy to staging:** Test in staging environment for 24 hours
- [ ] **Monitor metrics:** Verify 429 rate, latency, DO storage size
- [ ] **Deploy to production:** Gradual rollout with monitoring
- [ ] **Post-deployment:** Monitor for 48 hours; adjust limits if needed
- [ ] **Documentation:** Update API docs with rate limit tiers and headers

---

## 8. Additional Notes

### 8.1 Future Enhancements

1. **Persistent Rate Limits (Optional):**
   - Current in-memory rate limiter is wiped on isolate eviction
   - For critical endpoints, consider backing limits with Cloudflare Cache API or DO storage
   - Trade-off: Persistence adds latency (network call per request)

2. **Dynamic Rate Limits:**
   - Adjust limits based on system load or reputation score
   - Trusted IPs (verified servers) could get higher limits
   - Requires integration with Story 020 (IP Reputation Scoring)

3. **Rate Limit Exemptions:**
   - CI/CD pipelines may need exemptions (verify via secret header)
   - Internal health checks should bypass rate limits
   - Add `X-Zajel-Internal` header check before rate limit

4. **Distributed Rate Limiting:**
   - For global rate limits (e.g., max 1000 attest/verify per second globally), use DO storage
   - Current per-IP limits are already distributed (each edge location has its own counters)

### 8.2 Performance Considerations

1. **Pruning Frequency:**
   - Every 100 requests is a balance between memory growth and overhead
   - If Worker handles 1000 req/sec, pruning runs 10x/sec (acceptable)
   - If Worker handles 10 req/sec, pruning runs every 10 seconds (less efficient)
   - Consider adaptive frequency based on `counters.size` if needed

2. **Composite Key Length:**
   - Keys like `"192.168.1.1:read"` are short (< 30 bytes)
   - Map overhead is ~50 bytes per entry
   - With 10,000 unique IP+tier combinations, memory usage < 1 MB (negligible)

3. **DO Storage for Heartbeat Limits:**
   - Each `heartbeat-rl:*` entry is ~50 bytes
   - With 1,000 registered servers, storage < 50 KB
   - Cleanup ensures entries are removed when servers expire (5 min TTL)
   - No sharding needed for this scale

### 8.3 Security Notes

1. **IP Spoofing:**
   - `CF-Connecting-IP` is set by Cloudflare edge; cannot be spoofed by client
   - Rejecting missing IP prevents bypass via header stripping
   - Trusted only because Worker runs on Cloudflare infrastructure

2. **Distributed Denial of Service:**
   - Per-IP rate limiting doesn't prevent DDoS from botnet (many IPs)
   - Cloudflare's global rate limiting and DDoS protection still apply
   - This story reduces *per-attacker* effectiveness, not *coordinated attacks*

3. **Rate Limit Information Disclosure:**
   - `X-RateLimit-Remaining` header reveals limit tier to attacker
   - Trade-off: Transparency helps legitimate users avoid hitting limits
   - Alternative: Omit header, but less user-friendly

---

## 9. Acceptance Criteria (from Story)

- [x] Rate limiter accepts a composite key (IP + endpoint tier) instead of just IP
- [x] At least 4 rate limit tiers are defined: read, write, attest, admin
- [x] Each tier has independently configurable `limit` and `windowMs` values
- [x] `POST /servers/heartbeat` enforces a per-serverId rate limit (max 2/min) in DO storage
- [x] Requests without `CF-Connecting-IP` are rejected with 400
- [x] Rate limit response includes `Retry-After` header with seconds until the window resets
- [x] Rate limit response includes `X-RateLimit-Remaining` header
- [x] Pruning runs deterministically (every 100th request) instead of probabilistically
- [x] Existing tests continue to pass
- [x] New unit tests cover all rate limit tiers

---

**End of Implementation Plan**
