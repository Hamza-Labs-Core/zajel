# Review 002: Flip Empty Trusted Keys Default to Deny

**Plan:** `docs/security/implementation-plans/plan-002-trusted-keys-deny-default.md`
**Story:** `docs/security/stories/story-002-trusted-keys-deny-default.md`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-03-03

---

## Verdict: NEEDS REVISION

The core logic fix (changing `trustedKeys.length === 0 ||` to `trustedKeys.length > 0 &&`) is correct and addresses the security vulnerability. However, the plan has a critical omission: it fails to account for at least **five additional existing tests** that will break after the change, and it preserves an existing bug in the heartbeat hash-change detection code that renders anomaly logging dead code.

---

## 1. Accuracy

### 1.1 File Paths -- PASS

All referenced source files exist at their stated paths:

| Path | Exists |
|------|--------|
| `packages/server/src/durable-objects/server-registry-do.js` | Yes |
| `packages/server/tests/unit/build-signing.test.js` | Yes |
| `packages/server/tests/e2e/integration.test.js` | Yes |

### 1.2 Line Numbers -- PASS WITH NOTES

The line numbers in both the plan and the story are accurate against the current source:

| Reference | Expected | Actual | Status |
|-----------|----------|--------|--------|
| `keyTrusted` in `registerServer()` | Line 586 | Line 586 | Match |
| `keyTrusted` in `heartbeat()` | Line 751 | Line 751 | Match |
| `loadTrustedKeys()` | Lines 214-233 | Lines 214-234 | Close (method ends at 234 with `},`) |
| `isTrustedKey()` | Lines 279-281 | Lines 279-281 | Match |
| `buildVerified` assignment | Line 588 | Line 588 | Match |
| `buildVerified` persisted | Line 610 | Line 610 | Match |
| `listServers` | Line 633 | Line 633 | Match |
| Test "should accept any valid signature..." | Lines 220-238 | Lines 220-238 | Match |
| "Heartbeat Build Re-verification" describe block | After line 328 | Line 264 (describe starts) / Line 329 (block ends) | Plan says "after line 328" which is correct for inserting after the last test in the block |

### 1.3 Code Snippets -- PASS

All "Before" code snippets in the plan match the actual source verbatim. The `registerServer()` block (lines 580-598), the `heartbeat()` block (lines 747-764), and the test at lines 220-238 all match exactly.

### 1.4 Story Line References -- PASS WITH NOTES

The story references line 750-751 for the heartbeat `keyTrusted`, while the plan references line 751. Actual code: `trustedKeys` load is on line 750, `keyTrusted` is on line 751. Both are acceptable, though the story is more precise by giving the range.

---

## 2. Completeness

### 2.1 CRITICAL: Missing Test Updates

The plan identifies only **one** existing test to update (lines 220-238, "should accept any valid signature when TRUSTED_BUILD_KEYS is not configured"). However, the deny-default change will break **at least five additional tests** that use `new ServerRegistryDO(mockState, {})` (empty env, no trusted keys) and assert `buildVerified: true`:

| Test | Line | File | Description |
|------|------|------|-------------|
| "should verify a valid build signature on registration" | 100-127 (assertion at 124) | `build-signing.test.js` | Uses `{}` env, expects `true` |
| "should re-verify build signature on heartbeat" | 265-294 (assertion at 293) | `build-signing.test.js` | Uses `{}` env, expects `true` |
| "should detect tampered signature in heartbeat" | 296-328 (assertion at 312) | `build-signing.test.js` | Uses `{}` env, initial registration expects `true` before tamper |
| "should include build info in anomalies response" | 331-364 (assertion at 361) | `build-signing.test.js` | Uses `{}` env, expects `true` in anomalies listing |

**Each of these tests must be updated** to either:
- (a) Change the expected value to `false`, or
- (b) Add `TRUSTED_BUILD_KEYS: keypair.publicKeyBase64` to the env object so the test continues to exercise the "valid + trusted" path.

Option (b) is strongly recommended for the tests at lines 100, 265, 296, and 331, because those tests exist to verify that valid signatures produce `buildVerified: true` -- they should continue testing that happy path with trusted keys configured. If they all flip to `false`, you lose test coverage for the positive case in `registerServer()` and `heartbeat()` without explicit `TRUSTED_BUILD_KEYS`.

### 2.2 Acceptance Criteria Coverage

| Acceptance Criterion (from story) | Covered by Plan? | Notes |
|------------------------------------|-----------------|-------|
| No trusted keys => `buildVerified: false` for all servers | Yes | Tests 4.1, 4.2 |
| Trusted keys configured => only matching key gets `true` | Pre-existing tests | Tests at lines 171-193 already cover this |
| Both `registerServer` and `heartbeat` use deny-default | Yes | Steps 1-2 + Tests 4.4 |
| Audit log warning when no trusted keys | Yes | Step 3-4 + Test 4.3 |
| Existing `buildVerified: true` servers flip on heartbeat | Yes | Test 4.5 |
| `loadTrustedKeys()` return value unchanged | Yes | No changes to that function |

### 2.3 Story Test Requirements vs. Plan Test Plan

| Story Test Requirement | Plan Coverage |
|------------------------|--------------|
| Unit: `buildVerified: false` when trustedKeys empty + valid sig | Tests 4.1, 4.2 |
| Unit: `buildVerified: true` when key in trusted set + valid sig | Pre-existing (line 171) but see 2.1 -- the first "happy path" test at line 100 will break |
| Unit: `buildVerified: false` when key NOT in trusted set | Pre-existing (line 195) |
| Unit: heartbeat denies when no trusted keys | Test 4.4 |
| Integration: register with self-signed, no keys => `false` | Test 4.6 |

### 2.4 Integration Test Has a Variable Shadowing Bug

In Section 4.6, the integration test code declares `const data` on line 512 (`const data = new TextEncoder().encode(buildHash);`) and then again on line 540 (`const data = await listResponse.json();`). This would cause a syntax error in strict mode or a linting failure. The inner `data` needs a different name (e.g., `const listData`).

### 2.5 Audit Logging for Heartbeat -- Missing Same Addition to Step 4

The plan's Step 4 "After" code correctly adds the audit warning block in the heartbeat path. However, the plan does NOT mention adding audit logging to the heartbeat's existing `this.logger.info('[audit] ...')` call that parallels the registration path. The heartbeat code path has no existing info-level build verify audit log (unlike `registerServer()` which has one at line 590). This is acceptable as-is since the warn-level log provides the needed visibility, but worth noting for consistency.

---

## 3. Risks

### 3.1 LOW RISK: Pre-existing Bug in Heartbeat Hash-Change Detection (Preserved by Plan)

In the heartbeat code at lines 752-757, the plan preserves this sequence:

```javascript
server.buildHash = body.buildHash;        // line 753: overwrite FIRST

const prevHash = server.buildHash;         // line 756: read AFTER overwrite
if (prevHash && prevHash !== body.buildHash) {  // always false
```

Because `server.buildHash` is set to `body.buildHash` on line 753 BEFORE `prevHash` is captured on line 756, `prevHash` will always equal `body.buildHash`, making the hash-change anomaly detection dead code. This is a pre-existing bug not introduced by this plan, but the plan should at minimum note it. Ideally, the plan would fix it by moving `const prevHash = server.buildHash;` to BEFORE `server.buildHash = body.buildHash;`. This is a separate issue but worth flagging since the plan touches these exact lines.

### 3.2 LOW RISK: Test 4.3 Logger Mock Injection

Test 4.3 sets `registry.logger = mockLogger;` after constructing the `ServerRegistryDO`. This depends on the logger being a simple assignable property. Looking at the source (line 299: `this.logger = createLogger(env);`), this is indeed a direct property assignment, so overwriting it works. However, if the logger initialization changes to be non-configurable in the future, this test will silently stop verifying the logging behavior. A more robust approach would be to inject the logger via the env or constructor.

### 3.3 NO RISK: Storage Format / API Compatibility

The plan correctly identifies that no storage format or API response changes are needed. The `buildVerified` field already exists in responses. This is confirmed by inspection of the source.

### 3.4 LOW RISK: Rollback

The rollback assessment is accurate. The change is a 2-character edit in two locations, easily revertible.

---

## 4. Recommended Changes

### 4.1 REQUIRED: Update All Broken Tests

Update the following tests to use `TRUSTED_BUILD_KEYS: keypair.publicKeyBase64` in their env, so they continue testing the positive verification path:

1. **Line 101** (`build-signing.test.js`): Change `new ServerRegistryDO(mockState, {})` to `new ServerRegistryDO(mockState, { TRUSTED_BUILD_KEYS: keypair.publicKeyBase64 })`.

2. **Line 266** (`build-signing.test.js`): Same change -- add `TRUSTED_BUILD_KEYS` to env for heartbeat re-verification test.

3. **Line 297** (`build-signing.test.js`): Same change for tamper detection test. The initial registration should still succeed with `buildVerified: true` (now requiring trusted keys), and the tampered heartbeat should flip it to `false`.

4. **Line 333** (`build-signing.test.js`): Same change for build-info-in-anomalies test.

Without these changes, running `npm run test --workspace=packages/server -- tests/unit/build-signing.test.js` after the source fix will produce at least 4 unexpected failures.

### 4.2 REQUIRED: Fix Variable Shadowing in Integration Test (Section 4.6)

Change line 540 of the plan's integration test from:
```javascript
const data = await listResponse.json();
```
to:
```javascript
const listData = await listResponse.json();
```
And update the subsequent references from `data.servers` to `listData.servers`.

### 4.3 RECOMMENDED: Note the Hash-Change Detection Bug

Add a note to the plan's Section 9 (Notes and Caveats) documenting the pre-existing bug at lines 753-757 where `server.buildHash` is overwritten before `prevHash` is captured, making hash-change anomaly detection ineffective. This should be tracked as a separate follow-up fix, or fixed in this same change since the plan already modifies those lines.

### 4.4 OPTIONAL: Update Plan Test Name for Clarity

Test 4.2 is titled "should deny build verification when no trusted keys and valid signature provided" but is functionally identical to Test 4.1 (both test the same scenario). Consider merging them or differentiating (e.g., Test 4.2 could test with an unsigned build to ensure it remains `false`).

---

## Summary of Issues

| # | Severity | Issue |
|---|----------|-------|
| 1 | CRITICAL | Plan does not update 4 additional tests that will break (lines 124, 293, 312, 361) |
| 2 | MODERATE | Integration test (Section 4.6) has variable shadowing (`const data` declared twice) |
| 3 | LOW | Pre-existing hash-change detection bug preserved without comment (lines 753-757) |
| 4 | LOW | Test 4.2 duplicates Test 4.1 scenario |
| 5 | INFO | Story says line 750-751 for heartbeat; plan says line 751 -- both acceptable |

The plan must address issue #1 before implementation. Issues #2-4 should be addressed but are not blockers.
