# Review: Plan 019 - Durable Object Sharding

**Verdict: NEEDS REVISION**

The plan demonstrates a solid understanding of the problem space and proposes a reasonable sharding architecture. However, there are several inaccuracies in referenced code/line numbers, a critical routing bug, missing test helpers, an incomplete acceptance criterion, and multiple gaps that need to be addressed before implementation.

---

## 1. Accuracy

### 1.1 Line Number and Code Snippet Verification

**Story references (`packages/server/src/index.js`):**

| Claim | Actual | Status |
|-------|--------|--------|
| Lines 103-104: `idFromName('global')` for GET /servers | Lines 103-104 match | PASS |
| Lines 135-136: `idFromName('global')` for other /servers | Lines 135-136 match | PASS |
| Lines 149-150: `idFromName('global')` for /attest | Lines 149-150 match | PASS |
| TODO on line 101 | Line 101 matches | PASS |
| TODO on line 133 | Line 133 matches | PASS |
| TODO on line 148 | Actual TODO is on line 147; line 148 is the `const id = ...` line | MINOR INACCURACY |

**Plan references (`packages/server/src/index.js`):**

| Claim | Actual | Status |
|-------|--------|--------|
| Lines 99-106 for GET /servers block | Lines 99-106 match | PASS |
| Lines 131-142 for other /servers block | Actual block is lines 131-143 (the closing `}` is line 143) | MINOR INACCURACY |
| Lines 145-157 for /attest block | Lines 145-157 match | PASS |
| "after line 21" for imports | Line 21 is `import { rateLimiter } from './rate-limiter.js';` | PASS |

**Plan references (`packages/server/src/durable-objects/server-registry-do.js`):**

| Claim | Actual | Status |
|-------|--------|--------|
| Lines 769-841 for heartbeat anomaly block (story) | Lines 769-841 match | PASS |
| Lines 782-800 for fleet data gathering (plan Step 3) | Lines 782-800 match exactly | PASS |
| "after line 337" for migration helper | Line 337 is `setAlarm(...)` inside `alarm()`. The plan intends to insert after the `alarm()` method, which closes at line 337. This is reasonable but confusing -- the migration helper would be placed between `alarm()` and `verifyServerAuth()` at line 339. | PASS WITH NOTE |
| "line 303" for constructor modification | Line 303 is `// Schedule periodic cleanup alarm` comment. The `blockConcurrencyWhile` block is at lines 304-311. The plan proposes adding migration to the `blockConcurrencyWhile` callback. | PASS |
| Lines 100-116 for AnomalyDetector fleet-wide (Step 3 consequence) | Lines 100-116 match the `fleet_outlier` detection block | PASS |

**Plan references (`packages/server/src/durable-objects/attestation-registry-do.js`):**

| Claim | Actual | Status |
|-------|--------|--------|
| Lines 599-614 for handleChallenge nonce scan (story) | Lines 599-614 match the nonce rate-limiting block | PASS |

**Plan references (`wrangler.jsonc`):**

| Claim | Actual | Status |
|-------|--------|--------|
| Lines 23-42 for migrations array | Lines 23-42 match exactly | PASS |

### 1.2 File Path Verification

**Existing files referenced (all confirmed to exist):**

- `/home/meywd/zajel-ddos/packages/server/src/index.js` -- EXISTS
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` -- EXISTS
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/attestation-registry-do.js` -- EXISTS
- `/home/meywd/zajel-ddos/packages/server/wrangler.jsonc` -- EXISTS

**New files to create (confirmed do not yet exist):**

- `/home/meywd/zajel-ddos/packages/server/src/sharding/server-registry-sharding.js` -- Correct (directory does not exist yet)
- `/home/meywd/zajel-ddos/packages/server/src/sharding/attestation-sharding.js` -- Correct
- `/home/meywd/zajel-ddos/packages/server/src/sharding/admin-operations.js` -- Correct

**Test files referenced (confirmed do not yet exist):**

- `/home/meywd/zajel-ddos/packages/server/tests/unit/sharding.test.js` -- Correct
- `/home/meywd/zajel-ddos/packages/server/tests/e2e/sharding-integration.test.js` -- Correct
- `/home/meywd/zajel-ddos/packages/server/tests/e2e/migration.test.js` -- Correct

**Test helper referenced but does not exist:**

- `/home/meywd/zajel-ddos/packages/server/tests/helpers/mock-do.js` -- DOES NOT EXIST. The E2E integration tests import `MockStorage`, `MockState`, and `createMockEnv` from this file, but it needs to be created. This is not mentioned in the plan's file creation list.

**Documentation files referenced (none exist):**

- `/home/meywd/zajel-ddos/docs/architecture/bootstrap-server.md` -- DOES NOT EXIST
- `/home/meywd/zajel-ddos/docs/architecture/durable-objects.md` -- DOES NOT EXIST
- `/home/meywd/zajel-ddos/docs/operations/monitoring.md` -- DOES NOT EXIST
- `/home/meywd/zajel-ddos/docs/operations/troubleshooting.md` -- DOES NOT EXIST
- `/home/meywd/zajel-ddos/docs/api/bootstrap-api.md` -- DOES NOT EXIST
- `/home/meywd/zajel-ddos/packages/server/README.md` -- DOES NOT EXIST

These are listed in section 8 ("Documentation Updates") as files to update, but they do not currently exist. They would need to be created, not updated.

---

## 2. Completeness

### 2.1 Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Tests | Status |
|---------------------|-----------------|------------------|--------|
| Server registry sharded by region (5+ regional shards + 1 default) | Step 1: 6 regions + 1 default = 7 shards | Unit test verifies KNOWN_REGIONS >= 6 | PASS |
| Attestation registry sharded by device_id prefix (256 shards) | Step 1: attestation-sharding.js | Unit test verifies 256 shards distribution | PASS |
| GET /servers aggregates from all regional shards | Step 2: aggregateServerList fan-out | E2E test: "should aggregate servers from all shards" | PASS |
| Trusted key management uses admin shard | Step 2: /servers/trusted-keys routes to admin | No dedicated test for admin shard isolation | MISSING TEST |
| Version policy served from read-through cache | NOT IMPLEMENTED | No test | MISSING |
| Regional outage only affects that region | Step 2: partial failure handling | E2E test: "should handle partial shard failures gracefully" | PASS |
| Heartbeat latency at P99 does not degrade | Step 3: fleet analysis changes | Not testable in unit/E2E (requires load test) | ACCEPTABLE |
| Backward compatible: existing storage migrated to default shard | Step 5: migrateFromGlobalIfNeeded | Migration test exists but is weak (see below) | PARTIAL |
| Fan-out handles partial failures | Step 1: Promise.allSettled | E2E test covers this | PASS |

**Critical gap -- Version policy read-through cache:** Acceptance criterion 5 states "Version policy is served from a read-through cache in the Worker (not per-request DO fetch)." The plan does not implement this at all. There is no Worker-level caching for version policy. Every `GET /attest/versions` still hits the DO directly. This acceptance criterion is completely unaddressed.

**Missing test -- Admin shard isolation:** Story test requirement 5 ("Admin shard isolation test: Key update on admin shard doesn't block server registration on regional shards") has no corresponding test in the plan.

### 2.2 Test Plan Gaps

1. **Missing test helper file:** The E2E tests import from `../helpers/mock-do.js` which does not exist. The plan needs to either create this file or reference existing test infrastructure. The existing tests in `tests/e2e/bootstrap.test.js` may have useful patterns to borrow from.

2. **Placeholder attestation shard test:** The attestation device sharding E2E test (section 4.2) ends with `expect(true).toBe(true); // Placeholder`. This is not a real test.

3. **Weak migration test:** The migration test in section 4.3 checks that `_legacy_global_shard` is set, but this marker is only set by `migrateFromGlobalIfNeeded()`. The test creates a new DO and registers data, but `migrateFromGlobalIfNeeded()` is called in the constructor's `blockConcurrencyWhile` callback. Since `MockState` likely does not implement `blockConcurrencyWhile`, the migration helper would never run, making the first test case fail.

4. **No test for `extractDeviceIdFromRequest`:** This function is critical for attestation routing but has no unit test.

5. **No test for `shouldMigrateFromGlobal`:** This function is defined but never used in the implementation code (it is only in the sharding utility).

---

## 3. Risks

### 3.1 Critical: Server Region Routing Bug

The `getServerRegistryShardId` function validates region with:
```javascript
const normalizedRegion = typeof region === 'string' &&
                         region.length > 0 &&
                         region.length <= 64 &&
                         /^[a-zA-Z0-9._-]+$/.test(region)
  ? region
  : 'default';
```

This does NOT map regions to known shard names. A server registering with `region: "us-east"` will go to `region:us-east`, but a server with `region: "us-east-2"` or `region: "brazil"` will ALSO be accepted and create a new shard named `region:us-east-2` or `region:brazil`. These shards will NEVER be queried by `aggregateServerList` because it only iterates over `KNOWN_REGIONS`. Servers in unlisted regions become invisible to `GET /servers`.

The unit test "should route unknown regions to default shard" claims `unknown-region` maps to `default`, but by the actual code, `unknown-region` matches the regex and will map to `region:unknown-region`, NOT `region:default`. **This unit test will fail.**

The region validation regex accepts any alphanumeric string with dots, hyphens, and underscores. It does NOT enforce membership in `KNOWN_REGIONS`. The only inputs that route to `default` are `null`, empty strings, or strings containing special characters like spaces and exclamation marks.

**Fix required:** Either (a) validate that the region is in `KNOWN_REGIONS` and fall back to `default` for unknown regions, or (b) add all dynamically-discovered regions to the fan-out list.

### 3.2 Critical: Heartbeat Routing Sends All Heartbeats to Default Shard

In Step 2's `/servers/*` routing logic, heartbeat requests are hardcoded to `region: 'default'`:
```javascript
if (url.pathname === '/servers/heartbeat' && body.serverId) {
  region = 'default';
}
```

This means ALL heartbeats go to the `default` shard regardless of where the server was originally registered. The heartbeat handler looks up `server:{serverId}` in storage, but the server entry will be in its regional shard (e.g., `region:us-east`), not `default`. The heartbeat will always return 404 ("Server not registered") for any server NOT in the default shard.

**Fix required:** Either (a) require the region field in heartbeat requests, (b) fan-out to find the server, or (c) maintain a server-to-region mapping in KV or a dedicated shard.

### 3.3 Critical: DELETE Routing Sends All Deletes to Default Shard

Same issue as heartbeat: DELETE requests are hardcoded to `region: 'default'`:
```javascript
if (request.method === 'DELETE') {
  // ...
  region = 'default';
}
```

This will fail to delete servers registered in non-default shards. The plan acknowledges this with `// Look up server region - for now use default` but does not flag it as a breaking change.

### 3.4 High: Request Body Consumed Before DO Fetch

In the updated `/servers/*` routing (Step 2), POST request bodies are parsed with `await clonedRequest.json()` to extract the region. However, the original `request` is then forwarded to the DO via `stub.fetch(request)`. Since the original request's body stream has NOT been consumed (the clone was consumed), this should work. However, this creates a subtle dependency on `request.clone()` behavior that should be documented and tested.

For attestation routing, `extractDeviceIdFromRequest` clones the request, but the original request is forwarded to the DO. This is correct but the DO will re-parse the body, resulting in double JSON parsing. For large request bodies this adds latency.

### 3.5 Medium: wrangler.jsonc v5 Migration Is a No-Op

The plan adds a `v5` migration with `"renamed_classes": []`. While the comment explains this is intentional (sharding is via naming, not class changes), a truly empty migration may cause issues:
- Wrangler may reject an empty `renamed_classes` array
- Other environments (QA) also need this migration but only the top-level migrations array is updated; the QA environment does not have its own migrations section, so this should be fine as CF propagates migrations globally

However, looking at the actual wrangler.jsonc, there are already v4 migrations that created `AttestationRegistryDO`, and the QA env in lines 56-74 does not have a separate migrations array. This likely means the v5 migration would apply to both environments. But the empty `renamed_classes` should be verified against the Wrangler documentation.

### 3.6 Medium: Duplicate `getAttestationAdminShard` Function

The function `getAttestationAdminShard` is defined in BOTH:
- `/home/meywd/zajel-ddos/packages/server/src/sharding/attestation-sharding.js` (lines 254-257 of the plan)
- `/home/meywd/zajel-ddos/packages/server/src/sharding/admin-operations.js` (lines 319-322 of the plan)

The import in `index.js` imports `getAttestationAdminShard` from `admin-operations.js`, but the attestation sharding file also exports it. This creates confusion about which module is authoritative. Either remove the duplicate from `attestation-sharding.js` or consolidate all admin shard functions into one module.

### 3.7 Medium: Peers List Broken by Sharding

The heartbeat response currently returns `peers` -- a list of other active servers in the DO. After sharding, the heartbeat handler only sees peers within the same regional shard. The plan's primary approach (Step 3) removes fleet analysis entirely and passes `[]` to `AnomalyDetector.analyze`. But the `peers` array returned in the heartbeat response (line 839: `JSON.stringify({ success: true, peers })`) is still referenced. With the primary approach, the `peers` variable is no longer defined in scope, which will cause a `ReferenceError` at runtime.

The alternative approach preserves `peers` from the regional shard, but the primary approach breaks the heartbeat response entirely.

### 3.8 Low: `shouldMigrateFromGlobal` Is Defined But Never Called

The function `shouldMigrateFromGlobal` in `server-registry-sharding.js` is defined but never referenced in any of the implementation steps or called from `index.js`. It appears to be dead code.

---

## 4. Recommended Changes

### Must Fix (Blocking)

1. **Fix region routing validation:** Change `getServerRegistryShardId` to validate regions against `KNOWN_REGIONS` and fall back to `default` for any region not in the list. This ensures all servers are discoverable via fan-out.

2. **Fix heartbeat and DELETE routing:** Either require `region` in heartbeat/delete request bodies, or implement a lightweight server-to-region lookup. The current approach of routing everything to `default` breaks the entire heartbeat and unregister flow for regional shards.

3. **Fix the `peers` variable in the primary approach (Step 3):** The primary approach removes the code that defines `peers`, but the heartbeat response still references it. Either define `peers = []` or keep the regional fleet iteration.

4. **Fix unit test for unknown regions:** The test expects `unknown-region` to map to `region:default`, but the code accepts any alphanumeric region string. Either fix the code or fix the test expectation.

5. **Create the test helper file `tests/helpers/mock-do.js`** or reference existing test infrastructure. Without it, all E2E tests will fail to import.

6. **Implement version policy read-through cache** or remove the acceptance criterion from the story. It is listed as an AC but completely absent from the plan.

### Should Fix (Important)

7. **Remove duplicate `getAttestationAdminShard`** from `attestation-sharding.js`. Keep it only in `admin-operations.js`.

8. **Replace the placeholder attestation E2E test** with an actual test that verifies device routing to correct shards.

9. **Add unit tests for `extractDeviceIdFromRequest`**, covering JSON parse failure, missing device_id, non-JSON content type, and valid device_id extraction.

10. **Strengthen migration tests** to account for the fact that `MockState.blockConcurrencyWhile` may not be implemented, or explicitly implement it in the mock.

11. **Remove dead code:** Either use `shouldMigrateFromGlobal` somewhere in the routing logic or remove it from the sharding utility.

### Nice to Have

12. **Document that documentation files need to be created**, not updated. Section 8 lists files that do not exist.

13. **Add a timeout to the fan-out** in `aggregateServerList`. If one shard is slow, the entire `GET /servers` response is delayed until `Promise.allSettled` resolves. Consider wrapping each shard fetch in a `Promise.race` with a timeout (e.g., 3 seconds).

14. **Consider POST /servers registration routing:** When a server registers with `region: "us-east"`, the body is parsed to extract the region, and the request is forwarded to `region:us-east`. But the request body has already been consumed by the clone -- verify the original `request` object's body stream is still readable by the DO.

---

## 5. Summary

The plan provides a comprehensive architectural approach to sharding with good consideration of backward compatibility, rollback, and performance. However, three critical routing bugs (region validation, heartbeat routing, delete routing) would cause production breakage if implemented as written. The missing test helper, a dead-code function, a duplicate export, and an unaddressed acceptance criterion (version policy caching) further weaken the plan. These issues are fixable with moderate effort, but the plan should not be implemented in its current state without addressing items 1-6 above.
