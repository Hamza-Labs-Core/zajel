# Review: Plan 005 / Story 005 -- Heartbeat Replay Protection

**Reviewer**: Claude Opus 4.6
**Date**: 2026-03-03
**Verdict**: **NEEDS REVISION**

---

## Summary

The plan is well-structured and addresses a real vulnerability (heartbeat replay attacks against the federation bootstrap registry). The three-layer defense (timestamp, nonce, sequence number) is sound in design. However, the plan contains several inaccuracies in source code references, a direct contradiction between the story and the plan on blocking dependencies, a failure to account for existing test breakage, and a nonce storage ordering bug that can cause spurious nonce consumption. These issues must be resolved before implementation.

---

## Accuracy

### File paths -- PASS
All four referenced file paths exist in the codebase:
- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
- `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts`
- `/home/meywd/zajel-ddos/packages/server-vps/src/types.ts`

### Line numbers -- PASS WITH NOTES
Most line numbers are accurate. Verified matches:
- `server-registry-do.js` line 16: `MAX_SERVER_ENTRIES` constant -- correct
- `server-registry-do.js` line 295: `export class ServerRegistryDO` -- correct
- `server-registry-do.js` line 317: `async alarm()` -- correct
- `server-registry-do.js` line 464: `async registerServer()` -- correct
- `server-registry-do.js` line 706: `async heartbeat()` -- correct
- `bootstrap-client.ts` line 36: `createBootstrapClient` function -- correct
- `bootstrap-client.ts` line 126: `async function heartbeat()` -- correct
- `types.ts` line 252: `bootstrap: {` -- correct

### Code snippets -- FAIL (1 issue)

**config.ts Step 6 "Before" block field order is wrong.** The plan shows:

```typescript
bootstrap: {
  serverUrl: envString('ZAJEL_BOOTSTRAP_URL', 'https://signal.zajel.hamzalabs.dev'),
  nodes: envString('ZAJEL_BOOTSTRAP_NODES', '').split(',').filter(Boolean),
  retryInterval: envNumber('ZAJEL_BOOTSTRAP_RETRY_INTERVAL', 10000),
  maxRetries: envNumber('ZAJEL_BOOTSTRAP_MAX_RETRIES', 5),
  heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000),
},
```

Actual source (`config.ts` lines 49-58):

```typescript
bootstrap: {
  serverUrl: envString('ZAJEL_BOOTSTRAP_URL', 'https://signal.zajel.hamzalabs.dev'),
  heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000),
  nodes: envArray('ZAJEL_BOOTSTRAP_NODES', []),
  retryInterval: envNumber('ZAJEL_BOOTSTRAP_RETRY_INTERVAL', 5000),
  maxRetries: envNumber('ZAJEL_BOOTSTRAP_MAX_RETRIES', 10),
},
```

Differences:
1. Field order: `heartbeatInterval` comes before `nodes` in actual code, not after `maxRetries`.
2. `nodes` uses `envArray()` not `envString(...).split(',').filter(Boolean)`.
3. `retryInterval` default is `5000` not `10000`.
4. `maxRetries` default is `10` not `5`.

The plan's "After" block (Step 6) inserts `registrySecret` between `serverUrl` and `nodes`, but since `heartbeatInterval` actually comes between them, the diff will not apply cleanly.

### Story line number references -- PASS WITH NOTES

The story references the following, which are all verified accurate:
- `bootstrap-client.ts` lines 126-168 for heartbeat function
- `server-registry-do.js` line 733 for `server.lastSeen = Date.now()`
- `server-registry-do.js` lines 706-842 for heartbeat handler
- Auth check pattern at lines 417-423 (actual: 417-423 in `fetch()` routing)

---

## Completeness

### Existing tests will break -- FAIL (not addressed)

The existing test files send heartbeats and registrations WITHOUT the new required fields (`timestamp`, `nonce`, `sequenceNumber`). After this change, every heartbeat and registration test in both test files will fail with HTTP 400:

- `/home/meywd/zajel-ddos/packages/server/tests/e2e/bootstrap.test.js` -- 20+ tests send heartbeats/registrations without replay protection fields.
- `/home/meywd/zajel-ddos/packages/server-vps/tests/integration/bootstrap-client.test.ts` -- The mock bootstrap server does not validate or expect these fields, but the real VPS client tests will send them.

**The plan must include a step to update all existing tests** to include `timestamp`, `nonce`, and (for heartbeats) `sequenceNumber` in request bodies. Without this, "No regression in existing bootstrap tests" (Success Criteria) is unachievable.

### Migration / grace period test -- MISSING

Story acceptance criteria #8 states: "Existing VPS servers continue to function during rollout (server should accept heartbeats without replay fields during a brief migration window, with a deprecation warning log)."

Story test requirements explicitly list: "Migration test: Verify that heartbeats without the new fields are handled gracefully during the migration window."

The plan mentions grace period as an optional rollback mechanism but does not include it as a required implementation step or test. Either the acceptance criterion should be removed from the story, or the plan must include the grace period as a required (not optional) step with corresponding tests.

### Dependency contradiction -- FAIL

- **Story 005** says: "No blocking dependencies on other stories."
- **Plan 005** says: "Story 004: SERVER_REGISTRY_SECRET Auth Bypass When Unset" is a **blocking dependency** that "must be implemented BEFORE this story."

This is a direct contradiction. The plan's reasoning is sound -- without fixing the fail-open auth pattern (`if (this.env.SERVER_REGISTRY_SECRET && ...)` at lines 376, 392, 418), replay protection is meaningless since an attacker can forge fresh requests. The story should be updated to reflect this dependency, or the plan should explain why it can proceed without Story 004.

### Test plan coverage vs acceptance criteria

| Acceptance Criterion | Covered by Test Plan? |
|---|---|
| Heartbeat includes timestamp, nonce, sequenceNumber | Yes (unit + integration) |
| Server rejects timestamps > 2 min old | Yes (test case 1) |
| Server rejects timestamps > 30s future | Yes (test case 2) |
| Server rejects duplicate nonces (409) | Yes (test cases 3, 4) |
| Server rejects stale sequence numbers | Yes (test cases 5, 6) |
| Nonces pruned after 5 min by alarm | Yes (integration test) |
| Registration includes timestamp and nonce | Yes (test case 11) |
| Client sends Authorization header | Yes (integration test) |
| Grace period / migration window | **NO -- missing** |

---

## Risks

### 1. Nonce consumed before server existence check (Bug)

In Step 5 (heartbeat handler), the nonce is stored in DO storage **before** checking whether the server exists:

```javascript
// Store nonce with timestamp for expiry tracking
await this.state.storage.put(nonceKey, { timestamp: now });   // <-- stored here

const server = await this.state.storage.get(`server:${serverId}`);

if (!server) {
  return new Response(
    JSON.stringify({ error: 'Server not registered' }),
    { status: 404, ... }
  );
}
```

If a heartbeat arrives for a non-existent serverId, the nonce is permanently consumed (until alarm cleanup). A legitimate client that receives a 404, re-registers, and retries the heartbeat with the same nonce will get a 409 "duplicate nonce" error. While `crypto.randomUUID()` makes collisions astronomically unlikely (the client would generate a new nonce on retry), this is still a storage leak: attackers can spray nonce entries for non-existent servers to fill DO storage.

**Fix**: Move the nonce storage to AFTER the server existence check, or delete the nonce on 404.

### 2. Sequence number reset after server restart

The plan's Note 2 acknowledges that `heartbeatSeq` resets to 0 on VPS restart. However, if the server restarts WITHOUT re-registering (e.g., the heartbeat loop starts before registration completes due to a race), the DO still has the old `server.lastSequenceNumber`. Heartbeats with `sequenceNumber: 1` would be rejected because `1 <= oldHighValue`.

The plan's sequence number validation is optional (`if (typeof sequenceNumber === 'number'`), which mitigates this somewhat -- the client could omit it. But the plan adds `sequenceNumber` unconditionally to the client heartbeat. This needs either:
- A mechanism to reset the sequence on re-registration (clear `lastSequenceNumber` in `registerServer`).
- Or documentation that the client should re-register before starting heartbeats after a restart.

### 3. Nonce storage growth under attack

The plan estimates 5000 nonces for 1000 servers at worst case. However, an attacker with valid auth can send heartbeats for arbitrary serverIds (they will get 404, but the nonce is still stored per risk #1). With rapid requests, the attacker could store millions of nonces before the 5-minute alarm cleanup. The DO storage limit is 128MB, but alarm cleanup every 5 minutes means the window for abuse is significant.

### 4. `Number.isFinite()` already handles NaN and Infinity

The plan lists Story 013 (NaN Input Validation) as a nice-to-have dependency, claiming `Number.isFinite()` "should also validate that timestamps are not NaN, Infinity, or negative." This is incorrect: `Number.isFinite()` already returns `false` for `NaN`, `Infinity`, `-Infinity`, and non-number types. However, negative timestamps ARE finite and would pass the check. A timestamp of `-1` would have an `age` of `Date.now() + 1`, which is roughly 1.7 trillion ms and would be rejected by the `age > HEARTBEAT_MAX_AGE_MS` check. So negative timestamps are handled correctly. The dependency note is misleading.

### 5. Heartbeat re-registration loop could fail

In `bootstrap-client.ts` line 153-157, when heartbeat gets a 404, it calls `register()` then `getServers()`. After this change, `register()` will include a nonce. But if the original heartbeat's nonce was already consumed (per risk #1), the re-registration will use a new nonce and succeed. This flow is actually fine, but only because `crypto.randomUUID()` generates a fresh nonce each call. Worth documenting explicitly.

---

## Recommended Changes

### Must Fix (blocking)

1. **Fix config.ts "Before" snippet in Step 6** to match actual field order, function calls (`envArray` not `envString().split()`), and default values (5000 not 10000, 10 not 5).

2. **Add a step to update existing test files.** Both `/home/meywd/zajel-ddos/packages/server/tests/e2e/bootstrap.test.js` and the mock bootstrap server in `/home/meywd/zajel-ddos/packages/server-vps/tests/integration/bootstrap-client.test.ts` must include `timestamp`, `nonce`, and `sequenceNumber` in test request bodies. The `createRequest` helper or individual test cases need updating.

3. **Move nonce storage after server existence check in heartbeat handler** (Step 5). The nonce should only be stored if the server exists, to prevent storage pollution from requests targeting non-existent serverIds.

4. **Resolve the dependency contradiction.** Either update the story to list Story 004 as a blocking dependency, or justify in the plan why replay protection is still valuable without it. Given that the current auth pattern fails open when `SERVER_REGISTRY_SECRET` is unset, the plan's position (Story 004 must come first) is the correct one.

5. **Clear `lastSequenceNumber` on re-registration.** Add to the `registerServer()` handler: when a server re-registers, reset `lastSequenceNumber` to `undefined` (or `0`). This prevents heartbeat rejection after VPS restart. Add this to the Step 4 changes.

### Should Fix (recommended)

6. **Include migration/grace period as a required step, not optional.** The story's acceptance criteria demand it. Either implement the grace period as described in the plan's rollback section, or negotiate removing the acceptance criterion from the story.

7. **Add a migration test** as required by the story's test requirements section.

8. **Add nonce-per-serverId prefix** (e.g., `nonce:${serverId}:${nonce}`) instead of global `nonce:${nonce}`. This scopes nonce dedup per server and prevents cross-server nonce collision (theoretical, given UUID entropy, but cleaner). It also enables per-server nonce cleanup when a server is unregistered.

### Nice to Have

9. **Remove the misleading note about Story 013 (NaN Input Validation).** `Number.isFinite()` already handles NaN/Infinity. Negative timestamps are caught by the age check. The dependency note adds confusion.

10. **Document the heartbeat 404 -> re-register flow** in the context of replay protection, confirming that a fresh nonce is generated on each call and the flow is safe.

---

## Files Referenced

- `/home/meywd/zajel-ddos/docs/security/implementation-plans/plan-005-heartbeat-replay-protection.md`
- `/home/meywd/zajel-ddos/docs/security/stories/story-005-heartbeat-replay-protection.md`
- `/home/meywd/zajel-ddos/packages/server-vps/src/federation/bootstrap-client.ts`
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
- `/home/meywd/zajel-ddos/packages/server-vps/src/config.ts`
- `/home/meywd/zajel-ddos/packages/server-vps/src/types.ts`
- `/home/meywd/zajel-ddos/packages/server/tests/e2e/bootstrap.test.js`
- `/home/meywd/zajel-ddos/packages/server-vps/tests/integration/bootstrap-client.test.ts`
- `/home/meywd/zajel-ddos/docs/security/stories/story-004-registry-secret-bypass.md`
