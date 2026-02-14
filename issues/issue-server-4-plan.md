# Plan: No rate limiting on any endpoint enables denial of service

**Issue**: issue-server-4.md
**Severity**: HIGH
**Area**: Server
**Files to modify**:
- `packages/server/src/index.js`
- `packages/server/src/durable-objects/relay-registry-do.js`
- `packages/server/src/durable-objects/server-registry-do.js`
- `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

There is zero rate limiting anywhere in the codebase:
- **HTTP endpoints** in `index.js` (lines 24-146): All requests are processed unconditionally.
- **WebSocket messages** in `relay-registry-do.js` (lines 98-111): Every message is parsed and handled with no throttling.
- **Attestation endpoints**: `POST /attest/challenge` (attestation-registry-do.js line 311) creates nonce entries that persist 5 minutes each.
- **Server registry**: `POST /servers` (server-registry-do.js line 62) allows unlimited registrations.

Cloudflare Workers billing is per-request, so attack traffic directly increases costs.

## Fix Steps

1. **Add per-IP HTTP rate limiting in `index.js`** using a simple in-memory counter (or Cloudflare's built-in rate limiting if available):
   - Create a `packages/server/src/rate-limiter.js` utility module.
   - Implement a sliding window counter using a Map with IP keys and `{count, resetAt}` values.
   - Export `checkRateLimit(ip, limit, windowMs)` returning `{allowed: boolean, remaining: number}`.
   - Apply it in the main `fetch()` handler before routing:
     ```js
     const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
     const { allowed } = rateLimiter.check(ip, 100, 60000); // 100 req/min
     if (!allowed) {
       return new Response('Too Many Requests', { status: 429, headers: corsHeaders });
     }
     ```

2. **Add per-connection WebSocket message rate limiting in `relay-registry-do.js`**:
   - Add a `wsMessageCounts` Map tracking message count per WebSocket.
   - In `webSocketMessage()` (line 98), increment and check:
     ```js
     const count = (this.wsMessageCounts.get(ws) || 0) + 1;
     this.wsMessageCounts.set(ws, count);
     if (count > 200) { // 200 messages per window
       ws.close(4429, 'Rate limit exceeded');
       return;
     }
     ```
   - Reset counters periodically in the `alarm()` handler (line 50).

3. **Add per-device challenge rate limiting in `attestation-registry-do.js`**:
   - In `handleChallenge()` (line 311), after looking up the device, check how many active nonces exist for this `device_id`:
     ```js
     const activeNonces = await this.state.storage.list({ prefix: 'nonce:' });
     let deviceNonceCount = 0;
     for (const [, value] of activeNonces) {
       if (value.device_id === device_id) deviceNonceCount++;
     }
     if (deviceNonceCount >= 5) {
       return this.jsonResponse({ error: 'Too many active challenges' }, 429, corsHeaders);
     }
     ```

4. **Consider using Cloudflare Rate Limiting rules** (configured in `wrangler.toml` or dashboard) as an additional layer for the HTTP endpoints.

## Testing

- Verify that requests within the rate limit succeed normally.
- Verify that exceeding the rate limit returns 429 for HTTP or closes WebSocket with appropriate code.
- Test that rate limits reset after the window expires.
- Test that different IPs have independent rate limits.
- Load test to verify the rate limiter itself does not become a bottleneck.

## Risk Assessment

- **False positives**: Aggressive rate limits could affect legitimate high-traffic peers (e.g., relays with many connections). Tune limits based on expected usage patterns.
- **In-memory state**: Rate limit counters are lost if the Worker isolate is evicted. This is acceptable as a best-effort defense; for stricter guarantees, use Durable Object storage or Cloudflare's native rate limiting.
- **Performance**: Map lookups are O(1) and add negligible overhead per request.
