# Review: Plan 011 -- Per-Endpoint and Per-ServerId Rate Limiting

**Verdict: PASS WITH NOTES**

The plan is well-structured, technically sound in its core design, and covers the acceptance criteria from the story. However, there are several inaccuracies in file/method references, a critical gap around existing test breakage, and a logic bug in the story's proposed fix (which the plan itself corrects). The issues identified are fixable without redesign.

---

## 1. Accuracy

### 1.1 File Paths -- All Verified

| Referenced Path | Exists |
|-----------------|--------|
| `packages/server/src/rate-limiter.js` | Yes |
| `packages/server/src/index.js` | Yes |
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/server/src/constants.js` | No (plan correctly notes "may not exist") |
| `packages/server/tests/unit/rate-limiter.test.js` | No (new file, correctly labeled) |
| `packages/server/tests/e2e/rate-limiting.test.js` | No (new file, correctly labeled) |
| `packages/server/tests/e2e/server-registry.test.js` | No (plan says "add to existing file" but this file does not exist; heartbeat tests live in `tests/e2e/bootstrap.test.js`) |

### 1.2 Line Numbers and Code Snippets

**rate-limiter.js**: All line references are accurate.
- Line 11: `this.counters = new Map()` -- confirmed.
- Line 23: `check(ip, limit, windowMs)` -- confirmed.
- Lines 27-30, 33-39, 42-53: All match exactly.
- Line 57: Singleton export -- confirmed.
- The "Before" code blocks in Steps 3.1 and 3.2 match the actual source verbatim.

**index.js**: All line references are accurate.
- Lines 1-24: JSDoc and imports match exactly.
- Lines 32-34: Rate limit check matches (`|| 'unknown'` fallback confirmed at line 33).
- Lines 42-44: Probabilistic pruning matches (`Math.random() < 0.01`).
- Lines 48-50: CORS preflight handling matches.
- Lines 99-129: `GET /servers` with signing -- confirmed (actual code spans lines 99-129).
- Lines 131-143: Other `/servers/*` routes -- confirmed.
- Lines 145-157: `/attest/*` routes -- confirmed.

**server-registry-do.js**: Minor inaccuracies.
- Lines 706-842 for `heartbeat()` -- **actual range is 706-842** (the story says 706-841, off by one; the plan's Section 2.3 says 706-842 which is correct).
- Lines 710-722 for serverId validation -- confirmed (lines 710-722).
- Lines 724-731 for server lookup -- confirmed (lines 724-731).
- Lines 733-765 for metric updates -- partially correct. Metrics update starts at 733 but also includes build verification (lines 747-765). The plan's "Before" code block in Step 3.6 accurately represents lines 724-767.

### 1.3 Method Name Error

**Step 3.7 references `cleanupExpiredServers()` -- this method does not exist.** The cleanup logic is implemented directly inside the `alarm()` method at lines 317-337 of `server-registry-do.js`. The plan's "Before" code block in Step 3.7 does not match the actual `alarm()` implementation:

- Actual code uses `deleteKeys` (not `deletions`).
- Actual code uses `server.serverId` to build anomaly keys (not `key.replace('server:', ...)`).
- Actual code has chunked deletion (128 per batch).

The conceptual change (adding `heartbeat-rl:${serverId}` to the delete list) is correct, but the code snippet must be rewritten to match the actual `alarm()` method.

### 1.4 Story Proposed Fix Bug

The story's `getEndpointTier` function (lines 130-135) has incorrect ordering:
```javascript
if (pathname.startsWith('/attest')) return 'attest';
if (pathname === '/servers/trusted-keys' || pathname === '/attest/versions') return 'admin';
```
This means `POST /attest/versions` and `POST /attest/upload-reference` would be classified as `attest` tier instead of `admin`. The implementation plan (Step 3.3) corrects this by checking admin paths first. This is noted because the story and plan disagree, and implementers should follow the plan, not the story.

---

## 2. Completeness

### 2.1 Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests |
|----------------------|-----------------|------------------|
| Composite key (IP + tier) | Step 3.1 | Test 4.1.1, 4.1.2 |
| 4 rate limit tiers | Step 3.3 | Test 4.2.4 |
| Independent limit/windowMs per tier | Step 3.3 | Test 4.2.4 |
| Per-serverId heartbeat limit (2/min) in DO | Step 3.6 | Test 4.3.1, 4.3.2, 4.3.3 |
| Reject missing CF-Connecting-IP with 400 | Step 3.4 | Test 4.4 |
| Retry-After header on 429 | Step 3.4 | Test 4.2.2 |
| X-RateLimit-Remaining header on 429 | Step 3.4 | Test 4.2.2 |
| Deterministic pruning (every 100th request) | Step 3.1 | Test 4.1.5 |
| Existing tests continue to pass | Not addressed | Not addressed |
| New unit tests cover all tiers | Steps 4.1-4.4 | Yes |

### 2.2 Critical Gap: Existing Tests Will Break

**The plan does not address that rejecting missing `CF-Connecting-IP` (Step 3.4) will break every existing test that calls `worker.fetch()`.** Verified by inspection:

- `tests/e2e/bootstrap.test.js` -- `createRequest()` does not set `CF-Connecting-IP` (line 109-119). Tests at lines 141, 152, 161, 654, 666, 675 call `worker.fetch()` and will receive 400 instead of expected responses.
- `tests/e2e/attestation.test.js` -- `createRequest()` does not set `CF-Connecting-IP` (line 92-102). Tests at lines 1154, 1174, 1199 call `worker.fetch()`.
- `tests/e2e/integration.test.js` -- `createRequest()` does not set `CF-Connecting-IP` (line 109-119). Tests at lines 555, 578, 586 call `worker.fetch()`.
- `tests/unit/signing.test.js` -- Creates `Request` objects without `CF-Connecting-IP` (lines 184, 193, 203, 213, 228, 248, 273).

The plan must include a step to update all existing `createRequest()` helpers and raw `Request` constructors to include `'CF-Connecting-IP': '127.0.0.1'` (or similar test IP). Without this, acceptance criterion "Existing tests continue to pass" is violated.

### 2.3 Missing: RateLimiter Singleton Reset Between Tests

The `rateLimiter` in `rate-limiter.js` is a module-level singleton (line 57). Integration tests in section 4.2 that exhaust tier budgets (e.g., 200 requests to read tier) will leave state in the singleton that bleeds into subsequent tests. The plan should specify either:
- Importing `rateLimiter` and calling `rateLimiter.counters.clear()` in `beforeEach`, or
- Constructing a fresh `RateLimiter` per test (for unit tests), or
- Using unique IPs per test case to avoid counter collisions.

### 2.4 Missing: Test File Location Error

Section 4.3 says to add per-serverId heartbeat tests to `tests/e2e/server-registry.test.js`. This file does not exist. The heartbeat tests currently live in `tests/e2e/bootstrap.test.js`. The plan should either create a new file (and say so explicitly) or add the tests to `bootstrap.test.js`.

### 2.5 Covered Adequately

- Core `RateLimiter` refactoring (Steps 3.1-3.2) is thorough and correct.
- Tier definition and `getEndpointTier` logic (Step 3.3) is correct with proper ordering.
- Per-serverId DO-backed rate limiting (Step 3.6) is well-designed.
- Cleanup of `heartbeat-rl:*` entries (Step 3.7) is conceptually correct despite wrong method name.
- Test plan covers all tiers, window expiry, cross-tier independence, and header validation.

---

## 3. Risks

### 3.1 Heartbeat Rate Limit of 2/min May Be Too Restrictive (MEDIUM)

VPS servers currently heartbeat every 30 seconds (implied by the 5-minute TTL with expected regular heartbeats). At 2 per minute, a server that heartbeats every 30 seconds would be rate-limited every other heartbeat. The plan acknowledges this in Section 5.2.3 ("Medium" likelihood) but does not analyze actual heartbeat frequency. Recommend checking server-side heartbeat interval configuration before deploying.

If the VPS heartbeat interval is 30 seconds, the limit should be at least 3/min (or better, match the expected heartbeat frequency plus a small margin, e.g., 4/min).

### 3.2 CORS Preflight Consuming Rate Limit Budget (LOW)

The plan classifies `OPTIONS` requests as `read` tier (200/min). In practice, browsers send CORS preflight for every cross-origin POST/DELETE. A legitimate web client calling `POST /attest/verify` would first send `OPTIONS /attest/verify` (consuming from read budget) then `POST /attest/verify` (consuming from attest budget). This is acceptable since the read tier has high limits (200/min), but worth noting.

However, the current code (lines 47-50 of `index.js`) handles CORS preflight AFTER the rate limit check. This means OPTIONS requests are rate-limited, which is the existing behavior. No change in risk profile.

### 3.3 `addRateLimitHeaders` Helper Not Fully Applied (LOW)

Step 3.5 defines an `addRateLimitHeaders()` helper for success responses but explicitly notes it is optional and shows only the CORS preflight example. In practice, applying `X-RateLimit-Remaining` to success responses is useful for clients to self-throttle. However, the plan correctly identifies that only the 429 response is critical. The helper definition without usage may cause confusion during implementation.

### 3.4 Rate Limiter State Not Shared Across CF Edge Locations (NOTED)

The plan correctly identifies (Section 8.1) that the in-memory `RateLimiter` is per-isolate and wiped on eviction. An attacker can target different Cloudflare edge locations to get fresh budgets. This is an inherent limitation of the architecture and is outside the scope of this story. The per-serverId DO-backed rate limit (Step 3.6) does survive eviction, which is the right prioritization.

### 3.5 DO Storage Write Latency on Every Heartbeat (LOW)

Step 3.6 adds two DO storage operations per heartbeat (one `get` and one `put` for `heartbeat-rl:*`) before the existing heartbeat logic. This increases the minimum heartbeat latency by ~2 storage operations. For a DO within Cloudflare's network, this is typically <5ms total, which is acceptable.

---

## 4. Recommended Changes

### Must Fix (before implementation)

1. **Update all existing test `createRequest()` helpers to include `CF-Connecting-IP` header.** Affected files:
   - `/home/meywd/zajel-ddos/packages/server/tests/e2e/bootstrap.test.js` (line 109)
   - `/home/meywd/zajel-ddos/packages/server/tests/e2e/attestation.test.js` (line 92)
   - `/home/meywd/zajel-ddos/packages/server/tests/e2e/integration.test.js` (line 109)
   - `/home/meywd/zajel-ddos/packages/server/tests/unit/anomaly-detection.test.js` (line 76)
   - `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` (line 74)
   - `/home/meywd/zajel-ddos/packages/server/tests/unit/signing.test.js` (raw `new Request()` calls at lines 184, 193, 203, 213, 228, 248, 273)

2. **Fix Step 3.7 to reference the `alarm()` method** (lines 317-337 of `server-registry-do.js`) instead of the non-existent `cleanupExpiredServers()`. Rewrite the code snippet to match the actual alarm logic, including:
   - Using `server.serverId` (not `key.replace(...)`) to build cleanup keys.
   - Preserving the chunked deletion pattern (128 per batch).

3. **Fix test file reference in Section 4.3** -- change from `tests/e2e/server-registry.test.js` (does not exist) to either `tests/e2e/bootstrap.test.js` (existing) or explicitly state it as a new file.

### Should Fix

4. **Add rate limiter reset to test setup.** Import `rateLimiter` from `rate-limiter.js` and call `rateLimiter.counters.clear()` in `beforeEach` for integration tests (Section 4.2) that go through `worker.fetch()`. Alternatively, use unique test IPs per test case.

5. **Review heartbeat rate limit value.** Verify the VPS server heartbeat interval. If it is 30 seconds, increase the per-serverId limit from 2/min to at least 3/min (or 4/min for safety margin).

6. **Clarify `addRateLimitHeaders` usage.** Either fully apply the helper to all response paths in `index.js` or remove the helper definition from Step 3.5 to avoid dead code.

### Nice to Have

7. **Export `getEndpointTier` for direct unit testing.** The function is currently defined inside `index.js` as a module-level function. Exporting it (or moving to `constants.js`) would allow direct unit tests of tier assignment without full HTTP round-trips. Test 4.2.4 describes testing tier assignment through full requests, which is more expensive than necessary.

8. **Consider adding `X-RateLimit-Limit` header** (showing the tier's max limit) alongside `X-RateLimit-Remaining` for better client self-regulation. This is a minor enhancement not in the acceptance criteria.
