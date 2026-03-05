# Review 001: Fix Federation Reconnect Bug

**Plan**: `/home/meywd/zajel-ddos/docs/security/implementation-plans/plan-001-federation-reconnect-bug.md`
**Story**: `/home/meywd/zajel-ddos/docs/security/stories/story-001-federation-reconnect-bug.md`
**Reviewer**: Claude (AI Assistant)
**Date**: 2026-03-03

---

## Summary Verdict: NEEDS REVISION

The plan correctly identifies the bug and the proposed one-line fix (removing the contradictory outer guard on line 486) is accurate and will resolve the immediate issue. However, the fix is incomplete: `scheduleReconnect()` does not chain further retry attempts on failure, so "infinite retries" will not actually work as described. The plan also contains several inaccuracies in the test code that would cause compilation or runtime errors. Details below.

---

## 1. Accuracy

### 1.1 Bug Identification -- ACCURATE

All referenced file paths exist and line numbers match the actual source code exactly:

| Reference | Verified |
|-----------|----------|
| `server-connection.ts` line 26: `maxReconnectAttempts: number; // 0 = infinite` | Yes, exact match |
| `server-connection.ts` lines 486-493: contradictory conditional | Yes, exact match |
| `server-connection.ts` lines 499-513: `scheduleReconnect()` | Yes, exact match |
| `index.ts` line 217: `maxReconnectAttempts: 0, // Infinite` | Yes, exact match |
| `bootstrap-client.ts` line 404 reference (heartbeat mitigation) | Line 404 is in `index.ts`, not `bootstrap-client.ts`, but the `startHeartbeat()` call is correctly at line 404 of `index.ts` |

The code snippets in the story (Section "Current Behavior") are verbatim copies of the actual source. The root cause analysis is correct: the outer guard `!== 0` and inner guard `=== 0` are semantically contradictory.

### 1.2 Proposed Fix -- ACCURATE (for the one-line change)

Removing `&& this.config.maxReconnectAttempts !== 0` from line 486 is the correct minimal fix. The inner conditional on lines 487-489 already handles both infinite (`=== 0`) and bounded (`< maxReconnectAttempts`) cases correctly.

### 1.3 Test Code -- INACCURATE (multiple issues)

**Issue 1: Missing `ephemeralId` in mock `ServerIdentity`**

The test creates a mock identity (plan Step 4, line 175-180) as:
```typescript
identity = {
  serverId: 'server-001',
  nodeId: 'node-001',
  publicKey: new Uint8Array(32),
  privateKey: new Uint8Array(64),
};
```

The actual `ServerIdentity` interface (`/home/meywd/zajel-ddos/packages/server-vps/src/types.ts`, line 6-12) requires `ephemeralId: string`. This field is not optional. The test will fail TypeScript compilation.

**Issue 2: Wrong constructor arity in test**

The test instantiates `ServerConnectionManager` with 3 arguments:
```typescript
manager = new ServerConnectionManager(identity, 'ws://127.0.0.1:9000', config);
```

This is technically valid since the 4th parameter (`metadata`) has a default value of `{}`. However, it will still fail because the `identity` object is missing `ephemeralId` (see Issue 1).

**Issue 3: Wrong import path for types in unit tests**

The test imports:
```typescript
import type { ServerIdentity, MembershipEntry } from '../../src/types.js';
```

But the actual `server-connection.ts` source imports these from `../../types.js` (relative to `src/federation/transport/`). A test in `tests/unit/` would need `../../src/types.js`. This part is actually correct for the test location -- no issue here.

**Issue 4: `MembershipEntry` mock missing correct `status` type**

The mock uses `status: 'alive'` which is valid (it matches the `ServerStatus` union type), but this is fine.

**Issue 5: Integration test references non-existent API**

The integration test (plan Step 5) references:
- `server1.federation.getConnectedServers()` -- This method does NOT exist on `FederationManager`. `getConnectedServers()` is a method on `ServerConnectionManager` (the transport layer), not on `FederationManager`. The test would need to access `(server1.federation as any).transport.getConnectedServers()`.
- `server1.identity` -- The `ZajelServer` interface does expose `identity`, so this is valid.

**Issue 6: Exponential backoff test jitter assumption**

The backoff cap test (plan Step 4, line 465) expects the delay to be `<= 6000` for attempt 10 with `reconnectMaxInterval: 5000`. In practice, `Math.min(512000 + jitter, 5000)` always returns exactly `5000` because the first argument always exceeds the cap. The assertion passes but is imprecise -- a better assertion would be `expect(delays[0]).toBe(5000)`. More importantly, this reveals that jitter is lost at the cap, which could cause thundering-herd reconnections. This is a design concern, not a test bug.

### 1.4 Production Config Reference -- ACCURATE

The story correctly identifies `index.ts` line 217 as setting `maxReconnectAttempts: 0`. Verified against actual source at `/home/meywd/zajel-ddos/packages/server-vps/src/index.ts`, lines 212-218.

---

## 2. Completeness

### 2.1 Critical Missing Piece: Reconnect Chain Does Not Retry on Failure

This is the most significant issue with the plan. The fix enables the first reconnect attempt, but if that attempt fails, no further attempts are made.

Here is the execution flow after the fix:

1. `handleDisconnect()` calls `scheduleReconnect(entry, 1)`
2. `scheduleReconnect()` sets a `setTimeout` that calls `this.connect(entry)`
3. `connect()` calls `initiateConnection(entry)` which opens a WebSocket
4. If the WebSocket connection fails (peer is still down), `initiateConnection` rejects
5. The rejection is caught by `scheduleReconnect`'s catch block, which **only logs the error**
6. No further `scheduleReconnect()` call is made -- the retry chain is broken

Source evidence (`/home/meywd/zajel-ddos/packages/server-vps/src/federation/transport/server-connection.ts`, lines 506-512):
```typescript
setTimeout(async () => {
  try {
    await this.connect(entry);
  } catch (error) {
    logger.error(`[Transport] Reconnect to ${logger.serverId(entry.serverId)} failed`, error);
    // <-- No further scheduleReconnect() call here
  }
}, delay);
```

For "infinite retries" to actually work, the catch block should call `this.scheduleReconnect(entry, attempt + 1)` (or equivalent) to chain the next attempt. Without this, the system only retries once per disconnect event.

The bootstrap heartbeat provides partial mitigation (it periodically rediscovers peers and calls `addDiscoveredPeer()`), but this has a much longer interval than the intended exponential backoff and depends on the bootstrap server being reachable.

**Recommendation**: The plan must include a follow-up fix to `scheduleReconnect()` that chains retries on failure:

```typescript
private scheduleReconnect(entry: MembershipEntry, attempt: number): void {
  const delay = Math.min(
    this.config.reconnectInterval * Math.pow(2, attempt - 1) + Math.random() * 1000,
    this.config.reconnectMaxInterval
  );

  setTimeout(async () => {
    try {
      await this.connect(entry);
    } catch (error) {
      logger.error(`[Transport] Reconnect to ${logger.serverId(entry.serverId)} failed`, error);
      // Chain the next retry if allowed
      if (
        this.config.maxReconnectAttempts === 0 ||
        attempt < this.config.maxReconnectAttempts
      ) {
        this.scheduleReconnect(entry, attempt + 1);
      }
    }
  }, delay);
}
```

### 2.2 Test Coverage vs. Acceptance Criteria

| Acceptance Criterion | Covered by Tests? |
|---------------------|-------------------|
| `maxReconnectAttempts = 0` retries indefinitely | Unit test verifies `scheduleReconnect` is called, but does NOT verify retry chaining on failure |
| `maxReconnectAttempts = N` retries exactly N times | Unit test verifies `scheduleReconnect` is called N times, but only for the initial disconnect, not for failure-driven retries |
| Surviving server reconnects after transient disconnect | Integration test attempts this, but uses non-existent `federation.getConnectedServers()` API |
| Reconnection attempts logged at info level | Covered by Step 2 (logging addition) |
| Interface documentation accurate | Verified in Step 3, no change needed |

### 2.3 Missing Vitest Timeout Configuration

The integration tests specify 30-second timeouts per test (`}, 30000`), but the vitest config at `/home/meywd/zajel-ddos/packages/server-vps/vitest.config.ts` sets `testTimeout: 10000` (10 seconds). The per-test timeout in the `it()` call should override the global setting, so this is acceptable, but worth noting.

---

## 3. Risks

### 3.1 Reconnect-on-Failure Chain (HIGH)

As described in Section 2.1, without fixing `scheduleReconnect` to chain retries on failure, the "infinite retries" acceptance criterion is not met. After the fix, the system will attempt exactly one reconnect per disconnect event, which is better than zero, but not the intended behavior.

### 3.2 Jitter Loss at Max Backoff (LOW)

When the backoff delay exceeds `reconnectMaxInterval`, the `Math.min` clamp eliminates jitter. If multiple servers disconnect simultaneously and hit the max interval, they will all retry at exactly the same delay, potentially causing a thundering-herd effect. This is a pre-existing design issue, not introduced by this fix.

### 3.3 No Reconnect Attempt Counter Propagation (LOW)

`scheduleReconnect()` receives the attempt count but `connect()` -> `setupConnection()` always creates `PeerConnection` with `reconnectAttempts: 0`. If a reconnect succeeds and the peer disconnects again shortly after, the attempt counter resets. For bounded retries this means the server gets N fresh attempts per successful connection, which may or may not be intended. For infinite retries this is irrelevant.

### 3.4 Double Close Handler Registration (LOW)

In `setupConnection()` (line 462), a new `close` handler is registered that calls `handleDisconnect`. But `handleIncomingConnection` (line 405) also registers a `close` handler that calls `handleDisconnect`. If an incoming connection completes the handshake, both handlers are active on the same WebSocket. The first call to `handleDisconnect` will process normally, and the second will exit early (line 478: `if (!conn) return`) because the connection was already deleted. This is safe but wasteful. Not introduced by this fix.

---

## 4. Recommended Changes

### Required (for PASS verdict)

1. **Fix `scheduleReconnect` to chain retries on failure.** Add a recursive `scheduleReconnect` call in the catch block, guarded by the same `maxReconnectAttempts` check. Without this, acceptance criterion #1 ("retries indefinitely") is not met.

2. **Fix the `ServerIdentity` mock in unit tests.** Add `ephemeralId: 'srv-test-001'` to the mock identity object so it matches the actual interface.

3. **Fix `federation.getConnectedServers()` in integration tests.** This method does not exist on `FederationManager`. Either:
   - Expose it via a new public method on `FederationManager`, or
   - Use `(server.federation as any).transport.getConnectedServers()` in the test.

### Recommended (non-blocking)

4. **Add jitter after clamping in `scheduleReconnect`.** Change the formula to apply jitter after `Math.min` to prevent thundering-herd at max backoff:
   ```typescript
   const baseDelay = Math.min(
     this.config.reconnectInterval * Math.pow(2, attempt - 1),
     this.config.reconnectMaxInterval
   );
   const delay = baseDelay + Math.random() * 1000;
   ```

5. **Tighten the backoff cap assertion in the unit test.** Use `expect(delays[0]).toBe(5000)` instead of `toBeLessThanOrEqual(6000)` to reflect the actual behavior where jitter is lost at the cap (or update both the code and the test if jitter-after-clamp is adopted per recommendation #4).

6. **Add a unit test for the failure-retry chain.** Once recommendation #1 is implemented, add a test that verifies `scheduleReconnect` is called again when `connect()` throws, and that the attempt counter increments correctly.

---

## Appendix: File Path Verification

| Referenced Path | Exists |
|----------------|--------|
| `packages/server-vps/src/federation/transport/server-connection.ts` | Yes |
| `packages/server-vps/src/index.ts` | Yes |
| `packages/server-vps/src/federation/bootstrap-client.ts` | Yes |
| `packages/server-vps/tests/unit/server-connection-reconnect.test.ts` | No (NEW, to be created) |
| `packages/server-vps/tests/integration/federation-reconnect.test.ts` | No (NEW, to be created) |
| `packages/server-vps/tests/integration/federation.test.ts` | Yes (for regression testing) |
