# Review: Plan 017 - Transparency Log for Key Changes

**Verdict: PASS WITH NOTES**

The plan is well-structured, the code is implementable, and it addresses the core security gap identified in the story. However, there are several accuracy issues, a pagination bug, a missing acceptance criterion, and a missing error-handling pattern that the rollback section itself calls out but the implementation omits.

---

## Accuracy

### Line Number and Code Snippet Verification

All referenced line numbers and "Before" code snippets were verified against the actual source at `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`:

| Reference | Claimed Lines | Actual Match | Status |
|-----------|--------------|--------------|--------|
| Imports | 11-14 | Lines 11-14 | MATCH |
| `BuildVerifier` definition | 143 | Line 143 | MATCH |
| Route handlers (GET trusted-keys) | 443-448 | Lines 443-448 | MATCH |
| Build verification logging | 590-598 | Lines 590-598 | MATCH |
| Server registration logging | 619-625 | Lines 619-625 | MATCH |
| `setTrustedKeys` auth check | 905-913 | Lines 905-913 | MATCH |
| `setTrustedKeys` store+response | 964-977 | Lines 964-977 | MATCH |
| `getTrustedKeys` auth check | 994-1002 | Lines 994-1002 | MATCH |
| `getTrustedKeys` end | 1026-1032 | Lines 1028-1033 | OFFSET BY 2 |
| Class closing brace | 1032 | Line 1033 | OFFSET BY 1 |

The story (`story-017`) references lines 969-972 for the key change logging; actual lines are 969-972. Match confirmed.

The logger file (`packages/server/src/logger.js`) is described as lines 39-135 for `createLogger`; actual is lines 39-135 (line 138 for the module). Match confirmed.

### File Path Verification

| Path | Exists | Notes |
|------|--------|-------|
| `packages/server/src/durable-objects/server-registry-do.js` | Yes | Source to modify |
| `packages/server/src/logger.js` | Yes | Referenced in story |
| `packages/server/src/utils/` | Yes | Contains `request-validation.js` |
| `packages/server/src/utils/transparency-log.js` | No | New file (expected) |
| `packages/server/tests/unit/build-signing.test.js` | Yes | Existing test file to extend |
| `packages/server/tests/unit/transparency-log.test.js` | No | New file (expected) |

### Route Ordering

The plan inserts the `/servers/trusted-keys/audit-log` route **after** the `/servers/trusted-keys` GET route (Step 6). Because the routing uses exact `url.pathname ===` matching (not prefix matching), this ordering is correct -- a request for `/servers/trusted-keys/audit-log` will not match `/servers/trusted-keys`. No issue here.

---

## Completeness

### Acceptance Criteria Coverage

| AC (from story) | Covered in Plan | Notes |
|-----------------|----------------|-------|
| Every key management op creates append-only log entry | Yes | Steps 4-5 |
| Entry includes: sequence, timestamp, action, actor IP, prev hash, key delta | Yes | Step 4 |
| Hash-chained entries | Yes | TransparencyLog.append() |
| GET audit-log endpoint (authenticated) | Yes | Step 6 |
| Verification endpoint/field | Yes | `?verify=true` param |
| Entries survive DO hibernation | Yes | Stored in DO storage |
| Failed auth attempts logged | Yes | Steps 4-5 |
| **Build verification outcomes logged** | **NO** | **Not addressed** |
| Log retention at least 1 year | Partial | No cleanup = indefinite retention, but no policy mechanism |

**Missing AC: Build verification outcomes.** The story explicitly requires: "Build verification outcomes (pass/fail) for each server registration are logged." The plan does not add transparency log entries for build signature verification at lines 590-598. This is a gap -- a rogue key could be used for build verification without that event appearing in the transparency log. The plan's post-implementation validation section (line 978) acknowledges this by noting "covered by existing logging at line 590-598" -- but existing logging is the ephemeral `console.log` that the entire story is meant to replace.

### Test Plan Coverage

| Test Requirement (from story) | Covered | Notes |
|------------------------------|---------|-------|
| Append test (3 entries, correct sequence) | Yes | Unit + integration tests |
| Hash chain test | Yes | Unit `verify` tests |
| Tamper detection | Yes | Unit tests (previousHash + content tamper) |
| Read pagination | Partial | Tests `from` param but not large-scale 200-entry test |
| Failed auth logging | Yes | Integration test |
| Concurrent append | No | Manual checklist only, not automated |
| Key delta accuracy | Yes | Integration test for addKeys |

### Missing Test: Remove mode delta

The integration tests cover `add` mode deltas but do not test `remove` mode or `replace` mode deltas in the audit log. A test that replaces keys A,B with B,C and verifies `addedKeys=[C], removedKeys=[A]` would strengthen coverage.

---

## Risks

### 1. Pagination Bug in `getEntries()` (HIGH)

The `getEntries()` method has a significant bug when `fromSequence > 0`:

```javascript
const results = await this.storage.list({
  prefix: `${this.prefix}:`,
  limit: limit + 1, // +1 to account for potential meta key
});
```

`storage.list()` returns at most `limit + 1` entries from storage, sorted lexicographically by key. If `fromSequence` is 50 and `limit` is 100, the storage call returns entries 1 through ~101 (the first `limit+1` keys). Then the `fromSequence` filter discards entries 1-49, leaving only entries 50-101 (52 entries instead of the expected 100).

**Fix:** Use the `start` option of `storage.list()` to skip directly to the desired range:

```javascript
const startKey = `${this.prefix}:${String(fromSequence).padStart(8, '0')}`;
const results = await this.storage.list({
  start: startKey,
  prefix: `${this.prefix}:`,
  limit: limit + 1,
});
```

This also avoids scanning entries that will be discarded.

### 2. Missing try-catch Around `auditLog.append()` (MEDIUM)

The rollback section explicitly recommends: "Wrap `auditLog.append()` calls in try-catch to prevent audit failures from blocking key operations." However, none of the implementation steps actually wrap `append()` in try-catch. If DO storage is full or `crypto.subtle.digest` fails, the key update operation itself will fail with a 500, even though the key data was already successfully stored. This makes audit logging a hard dependency on key operations, contradicting the "purely additive" rollback claim.

**Fix:** Wrap each `auditLog.append()` call:
```javascript
try {
  const auditLog = new TransparencyLog(this.state.storage, 'key-audit');
  await auditLog.append({ ... });
} catch (err) {
  this.logger.error('[audit] Failed to write transparency log', err);
}
```

### 3. Non-Atomic Storage Writes in `append()` (LOW)

The `append()` method performs two sequential `storage.put()` calls (entry + metadata). If the Worker crashes between them, the entry is stored but the metadata is not updated, leaving the sequence counter behind. The next `append()` would overwrite the stored entry with a new one at the same sequence number.

**Mitigation:** Use `storage.put()` with a map to write both in a single call, or use `storage.transaction()` if available. In practice, DO single-threaded execution makes this unlikely, but for a tamper-evident log the guarantee should be stronger.

### 4. `computeKeySetHash` Called with Empty Array (LOW)

When keys are first set (no previous keys), `computeKeySetHash(currentKeys)` is called with `currentKeys = []` (the default from `loadTrustedKeys` when no keys exist). This works correctly (produces a deterministic hash of `[]`), but it's worth noting that the hash of an empty array is a valid sentinel value that should be documented.

### 5. MockStorage `list()` Method Mismatch (LOW)

The existing `MockStorage` in `build-signing.test.js` (line 57) accepts `{ prefix }` but the `TransparencyLog.getEntries()` passes `{ prefix, limit }`. The mock's destructuring silently ignores `limit`, which means tests won't catch limit-related bugs. The unit test's `MockStorage` correctly handles `limit`, but the integration tests in `build-signing.test.js` reuse the existing mock that lacks limit support.

**Fix:** Update the existing `MockStorage.list()` in `build-signing.test.js` to accept and enforce `limit`:
```javascript
async list({ prefix, limit }) {
  const results = new Map();
  for (const [key, value] of this.data) {
    if (key.startsWith(prefix) && results.size < (limit || Infinity)) {
      results.set(key, value);
    }
  }
  return results;
}
```

### 6. `hasMore` Field Inaccuracy (LOW)

In the audit log endpoint, `hasMore: entries.length === limit` is used to indicate whether more entries exist. This is unreliable because the actual count of remaining entries might be zero even when `entries.length === limit`. This is a common pattern and not a serious issue, but worth noting.

---

## Recommended Changes

### Required (before implementation)

1. **Fix the `getEntries()` pagination bug.** Use `storage.list({ start, prefix, limit })` instead of relying on post-filtering. This is a correctness issue that will cause silent data loss on paginated reads.

2. **Add try-catch around all `auditLog.append()` calls** in `server-registry-do.js`. The plan's own rollback section identifies this as necessary but the implementation code omits it.

3. **Add build verification outcome logging** (story AC #8). Insert a transparency log entry at lines 590-598 where build signatures are checked, recording `serverId`, `buildVerified`, `signatureValid`, `keyTrusted`, and `buildHash`. Without this, the rogue-key attack scenario in the story's reproduction steps is only partially mitigated.

4. **Update MockStorage in `build-signing.test.js`** to support the `limit` parameter in `list()`, matching the new `MockStorage` in `transparency-log.test.js`.

### Recommended (quality improvements)

5. **Use atomic writes in `append()`.** Replace the two `storage.put()` calls with a single call using a `Map`:
   ```javascript
   await this.storage.put(new Map([[key, logEntry], [seqKey, { sequence, lastHash: entryHash }]]));
   ```

6. **Add a `remove` mode delta test** to the integration tests. The current tests cover `add` mode but not `remove` or `replace` deltas.

7. **Correct the line offset in Step 5/6.** The plan references "lines 1026-1032" for the end of `getTrustedKeys`, but the actual lines are 1028-1033 (off by 2). Minor but worth fixing for implementer accuracy.

8. **Consider adding a test for the pagination bug** (large entry count, `from` > 0), since the manual checklist item (#4: "Create 200 entries") is not present in the automated tests.
