# Review: Plan 020 - IP Reputation Scoring and Cluster-Aware Rate Limiting

**Verdict: PASS WITH NOTES**

The plan is well-structured, phased for incremental delivery, and addresses a real gap in the current infrastructure. However, there are several accuracy issues with line number references, an API mismatch in the gossip integration, a missing `ip` field on the client data model, and a privacy acceptance criterion from the story that the plan does not address.

---

## Accuracy

### File Path Verification

All referenced **existing** files are confirmed present:

| File | Exists |
|------|--------|
| `packages/server/src/index.js` | Yes |
| `packages/server/src/rate-limiter.js` | Yes |
| `packages/server-vps/src/index.ts` | Yes |
| `packages/server-vps/src/client/handler.ts` | Yes |
| `packages/server-vps/src/storage/sqlite.ts` | Yes |
| `packages/server-vps/src/storage/interface.ts` | Yes |
| `packages/server-vps/src/federation/federation-manager.ts` | Yes |
| `packages/server-vps/src/federation/gossip/protocol.ts` | Yes |
| `packages/server-vps/src/federation/bootstrap-client.ts` | Yes |
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/server-vps/src/client/signaling-handler.ts` | Yes |
| `packages/server-vps/src/constants.ts` | Yes |

New file paths reference valid parent directories (e.g., `packages/server-vps/src/reputation/` does not yet exist and would need to be created; `migrations/003_ip_reputation.sql` follows the existing `001`/`002` naming convention).

### Line Number Verification

| Reference | Claimed | Actual | Status |
|-----------|---------|--------|--------|
| `rate-limiter.js` lines 1-57 (story) | `RateLimiter` class | Lines 1-57, with singleton export at line 57 (actual file is 58 lines total, but the singleton `export const` is line 57) | CORRECT |
| `rate-limiter.js` lines 9-57 (story snippet) | Class definition starts at line 9 | Line 9 is `export class RateLimiter {` | CORRECT |
| `index.js` lines 32-44 (plan "Before" block) | Rate limiting block | Actual: lines 32-44 match exactly (comment, IP extraction, `rateLimiter.check`, 429 response, prune logic) | CORRECT |
| `index.js` lines 26-44 (plan Section 1.2 "Before" header) | Starting from `export default` | Line 26 is `export default {` | CORRECT |
| `index.ts` lines 313-332 (story + plan) | `ipConnectionCounts` and `wss.on('connection', ...)` | Actual: line 313 is `const ipConnectionCounts = new Map<string, number>();`, line 316 starts `wss.on('connection', ...)`, line 332 is `ipConnectionCounts.set(clientIp, ipCount + 1);` | CORRECT |
| `constants.ts` lines 30-38 (story) | `RATE_LIMIT` object | Actual: lines 30-39 (the `as const` is line 39) | MINOR OFF-BY-ONE |
| `handler.ts` lines 262-313 (plan) | `checkRateLimit` method plus adjacent code | Actual: `checkRateLimit` is lines 262-285; lines 290-313 are `checkPairRequestRateLimit` | MOSTLY CORRECT (the range includes both methods) |
| `handler.ts` lines 262-285 (story) | Not referenced directly, but the plan's "lines 262-313" region | `checkRateLimit` ends at line 285; the plan proposes replacing through line 313 which would overwrite `checkPairRequestRateLimit` | ISSUE - see Risks section |
| `handler.ts` line 135 (plan: "Add reputation manager to constructor after line 135") | Constructor parameter list | Actual: line 135 is `federation?: FederationManager` (the last parameter). Correct insertion point. | CORRECT |
| `federation-manager.ts` lines 1-539 (story) | Entire file | Actual file is exactly 539 lines | CORRECT |
| `federation-manager.ts` line 20 (plan: "Add import after line 20") | Import block | Actual: line 20 is `import { logger } from '../utils/logger.js';` (last import). Correct insertion point. | CORRECT |
| `federation-manager.ts` line 56 (plan: "Add to class after line 56") | Class member declarations | Actual: line 56 is `private ring: HashRing;`. Next members are `routingTable`, `bootstrapAttempts`, etc. at lines 57-60 | CORRECT |
| `index.ts` line 27 (plan: "Add import after line 27") | Import statements | Actual: line 27 is `import { loadBuildManifest } from './identity/build-manifest.js';` (last import before blank line) | CORRECT |
| `index.ts` line 65 (plan: "Add after line 65") | After identity loading | Actual: line 65 is `logger.info(...)` for Node ID. The plan says to add reputation manager init here, which is a sensible location. | CORRECT |
| `index.ts` line 393 (plan: "After federation starts, after line 393") | `await federation.start(federationWss)` | Actual: line 393 is exactly `await federation.start(federationWss);` | CORRECT |
| `signaling-handler.ts` lines 132-215 (story) | Pairing code registration | Actual: lines 132-215 contain `handlePairingCodeRegister` method | CORRECT |

### Code Snippet Verification

1. **Story snippet for `RateLimiter`** (lines 9-57): The simplified snippet omits implementation detail but accurately represents the structure. The actual `check()` method uses a `{count, resetAt}` entry pattern rather than the simplified comment. Acceptable for a story-level description.

2. **Story snippet for VPS connection tracking** (lines 313-332): Matches the actual code nearly verbatim. The actual code uses `(ws: WebSocket, req: IncomingMessage)` type annotations, which the story includes. CORRECT.

3. **Story snippet for `RATE_LIMIT` constants** (lines 30-38): Matches actual code. CORRECT.

4. **Plan "Before" block for `index.js` (Step 1.2)**: Matches actual code at lines 26-44. The plan correctly captures the existing rate limiting logic. CORRECT.

5. **Plan "Before" block for `index.ts` connection handler (Step 2.5)**: Matches actual code at lines 316-332. CORRECT.

---

## Completeness

### Acceptance Criteria Coverage

| Story Acceptance Criterion | Plan Coverage | Test Coverage |
|---------------------------|---------------|---------------|
| CF Worker reputation in Cache API (survives eviction) | Phase 1, Step 1.1 | Unit test 4.1 (score accumulation, decay, limits, Cache API persistence) + Integration test + Manual test |
| Score increases on rate limit hits, invalid requests, rejections | Phase 1 Steps 1.2-1.3, Phase 2 Steps 2.5-2.6 | Unit tests for score accumulation |
| Score decreases on good behavior | Phase 1 Step 1.3 (successful attestation) | Unit test for successful attestation credit |
| Progressive rate limits (50%, 10%, blocked) | Phase 1 Step 1.1 `getRateLimit()` | Unit test 4.1 "Progressive rate limits" |
| VPS persists in SQLite | Phase 2 Steps 2.1-2.3 | Unit test 4.1 "SQLite persistence" |
| Gossip-based blocklist sharing | Phase 3 Steps 3.1-3.4 | Unit tests 4.1 "Threat payload generation", "Incoming threat processing" |
| CF Worker aggregates from heartbeats | Phase 4 Steps 4.1-4.5 | Unit test 4.1 "Threat data aggregation" |
| Score decay (halve every 24h) | Phase 1 Step 1.1 `_applyDecay()` | Unit test 4.1 "Time-based decay" |
| Blocked IP propagates across federation | Phase 3 | Integration test 4.2 "Cross-VPS reputation sharing" |
| **Admin endpoint for view/override** | **NOT IMPLEMENTED** - mentioned in monitoring (Section 7.3) but no code provided | **NOT TESTED** |
| **IP addresses hashed in stored logs** | **NOT IMPLEMENTED** - story says "IP addresses are hashed in stored logs" but plan stores raw IPs | **NOT TESTED** |

### Missing Items

1. **Admin override endpoint**: The story AC says "Admin endpoint to view and override reputation scores." The plan mentions it in Section 7.3 (dashboard) but provides no implementation code or route handler. This is a gap.

2. **IP hashing in stored logs**: The story AC says "Reputation data has privacy controls (IP addresses are hashed in stored logs)." The plan's SQLite schema stores raw `ip_address TEXT` values in both `ip_reputation` and `ip_reputation_events` tables. The plan needs to either implement IP hashing or explicitly defer this with a rationale.

3. **Test requirement 7 from story**: "False positive recovery: Manually reset reputation score via admin endpoint." No implementation or test is provided for this.

---

## Risks

### 1. `ClientInfo` Missing `ip` Field (BLOCKING for Phase 2)

The plan's Step 2.6 modifies `checkRateLimit()` to look up `client.ip`:

```typescript
const client = this.clients.get(clientId);
if (client?.ip) {
  const score = await this.reputationManager.getScore(client.ip);
```

However, the actual `ClientInfo` interface (in `/home/meywd/zajel-ddos/packages/server-vps/src/client/types.ts`) is:

```typescript
export interface ClientInfo {
  peerId: string;
  ws: WebSocket;
  connectedAt: number;
  lastSeen: number;
  isRelay: boolean;
}
```

There is **no `ip` field** on `ClientInfo`. The plan needs to:
- Add `ip: string` to the `ClientInfo` interface
- Populate it during `handleConnection()` (the IP is available from the connection handler in `index.ts` but is not currently passed to `ClientHandler`)

### 2. `checkRateLimit` Signature Change: Sync to Async (MEDIUM)

The plan changes `checkRateLimit` from synchronous (`returns boolean`) to asynchronous (`returns Promise<boolean>`). All callers of `checkRateLimit` in `handler.ts` must be updated to `await` the result. The plan does not show these call-site changes.

### 3. `getAliveMembers` Does Not Exist (BLOCKING for Phase 3)

The plan's Step 3.3 calls `this.gossip.getAliveMembers()`:

```typescript
const members = this.gossip.getAliveMembers();
```

This method does not exist on `GossipProtocol`. The actual API uses `this.gossip.getMembership().getAlive()` (via the `Membership` class). This must be corrected.

### 4. `transport.getConnection()` Does Not Exist (BLOCKING for Phase 3)

The plan's Step 3.3 uses:

```typescript
const connection = await this.transport.getConnection(member.endpoint);
connection.send({ ... });
```

The actual `ServerConnectionManager` uses `this.transport.send(serverId, message)` (not `getConnection`). The correct API is:

```typescript
await this.transport.send(member.serverId, message);
```

### 5. `GossipMessage` Type Mismatch (MEDIUM for Phase 3)

The plan proposes a `ThreatIntelMessage` with `type: 'gossip'` and `subtype: 'threat_intel'`. However, the existing `GossipMessage` type definition in `types.ts` restricts `subtype` to the `GossipMessageType` union:

```typescript
export type GossipMessageType =
  | 'ping' | 'ping_ack' | 'ping_req'
  | 'join' | 'leave' | 'suspect' | 'confirm' | 'state_sync';
```

Adding `'threat_intel'` would require extending the `GossipMessageType` union in `types.ts`. The plan mentions modifying `gossip/protocol.ts` but does not mention updating `types.ts`.

Additionally, the existing `GossipMessage` has required fields (`senderId`, `sequenceNumber`, `timestamp`, `signature`) that the `ThreatIntelMessage` in the plan does not include. Threat intel messages would either need to conform to the full `GossipMessage` structure (with signing) or use a separate message type.

### 6. `checkPairRequestRateLimit` Overwrite Risk (LOW)

The plan's Step 2.6 header says "Modify checkRateLimit method (lines 262-285)" but the replacement code block (Step 2.6) only replaces `checkRateLimit`. If implemented as a range replacement from 262-313, the adjacent `checkPairRequestRateLimit` method (lines 290-313) would be overwritten. The plan should clarify that only lines 262-285 are being replaced.

### 7. `ThreatAggregator` Self-Reference Bug (LOW)

In Step 4.4, the heartbeat handler does:

```javascript
const aggregator = new ThreatAggregator(this.state.id.stub);
```

`this.state.id` is a `DurableObjectId`, and `this.state.id.stub` is not a valid property. The correct approach would be to use the DO's own `this.state.storage` directly rather than creating a `ThreatAggregator` that calls back into itself via `fetch()`. Alternatively, use `env.SERVER_REGISTRY.get(this.state.id)` but calling a DO stub from within the same DO is circular.

### 8. Cache API `max-age` Semantic Mismatch (MEDIUM)

The plan uses `Cache-Control: max-age=604800` (7 days) to set TTL on reputation entries. The CF Cache API respects `max-age` for automatic eviction, but `max-age` counts from the time the response was **stored**, not from the last access. This means that if a score is updated every hour, the original 7-day TTL still counts from the first `cache.put()`. The plan's `incrementScore` calls `cache.put` with a fresh `max-age` on each update, which resets the TTL correctly. No actual bug, but this subtlety should be documented.

### 9. 50% Rate Limit Tier Can Produce Zero (LOW)

In `getRateLimit()`, when `score >= 5`:
```javascript
limit: Math.floor(baseTier.limit * 0.5)
```

If `baseTier.limit` is 1, this produces `Math.floor(0.5) = 0`, which would block the IP entirely at the "reduced" tier rather than at the "blocked" tier. The 10% tier has `Math.max(1, ...)` but the 50% tier does not. This should be `Math.max(1, Math.floor(baseTier.limit * 0.5))` for consistency.

### 10. Bootstrap Client Constructor Signature Change (MEDIUM)

The plan (Step 4.2) proposes changing `createBootstrapClient` to accept a `deps` object. However, the current code already calls it with 4 positional arguments in `index.ts` line 76:

```typescript
const bootstrap = createBootstrapClient(config, identity, () => ({...}), buildManifest);
```

The plan then shows passing `{ reputationManager }` as a 5th argument. But the proposed `createBootstrapClient` signature uses `deps?: BootstrapClientDeps` as the 5th parameter, while the actual function signature is:

```typescript
export function createBootstrapClient(
  config: ServerConfig,
  identity: ServerIdentity,
  getMetrics?: () => BootstrapMetrics,
  buildManifest?: BuildManifest | null,
): BootstrapClient {
```

The plan also references `BootstrapClientImpl` which does not exist -- the current implementation uses a closure-based pattern (not a class). The plan needs to be adjusted to match the actual factory function pattern.

---

## Recommended Changes

### Must Fix (before implementation)

1. **Add `ip` field to `ClientInfo` interface** and populate it during connection setup. Without this, Phase 2 reputation lookups in the client handler will fail.

2. **Fix `getAliveMembers()` call** to use `this.gossip.getMembership().getAlive()` in the threat intel broadcast loop (Step 3.3).

3. **Fix `transport.getConnection().send()` pattern** to use `this.transport.send(member.serverId, message)` (Step 3.3).

4. **Update `GossipMessageType` in `types.ts`** to include `'threat_intel'`, or redesign threat intel messages to use a separate transport channel (not piggybacked on the gossip protocol's signed message format).

5. **Fix `ThreatAggregator` self-referencing DO stub** in Step 4.4. Process threat data directly in the DO's `fetch` handler rather than creating a `ThreatAggregator` that calls itself.

6. **Fix `createBootstrapClient` signature change** to match the actual closure-based factory function pattern rather than referencing a non-existent `BootstrapClientImpl` class.

### Should Fix

7. **Add `Math.max(1, ...)` guard** to the 50% rate limit tier to prevent accidental zero-limit blocking.

8. **Address IP hashing** in the SQLite event log table (`ip_reputation_events`) to satisfy the story's privacy acceptance criterion, or explicitly note it as a separate follow-up task.

9. **Provide admin override endpoint implementation** with route handler code and test, as required by the story's acceptance criteria.

10. **Document all callers of `checkRateLimit`** that need to be updated from sync to async invocation.

### Nice to Have

11. Add a note about the `max-age` semantics in CF Cache API reputation storage to prevent future confusion.

12. Consider making the threat intel broadcast interval configurable (currently hardcoded to 5 minutes) via `ServerConfig`.

13. The event log table will grow unbounded between cleanup cycles. Consider adding a `MAX_EVENTS_PER_IP` limit to the `incrementReputation` method to prevent a single abusive IP from generating millions of event rows before the 30-day cleanup runs.
