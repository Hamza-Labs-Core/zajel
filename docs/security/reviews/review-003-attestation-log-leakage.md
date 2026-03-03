# Review: Plan 003 -- Fix console.error Information Leakage in Attestation Registry

**Verdict: PASS WITH NOTES**

**Reviewed:** 2026-03-03
**Plan:** `docs/security/implementation-plans/plan-003-attestation-log-leakage.md`
**Story:** `docs/security/stories/story-003-attestation-log-leakage.md`
**Reviewer:** Claude Opus 4.6

---

## 1. Accuracy

### 1.1 File Paths

| Referenced Path | Exists | Correct |
|---|---|---|
| `packages/server/src/durable-objects/attestation-registry-do.js` | Yes | Yes |
| `packages/server/src/logger.js` | Yes | Yes |
| `packages/server/tests/e2e/attestation.test.js` | Yes | Yes |
| `packages/server/tests/unit/attestation-logging.test.js` | No (new file) | N/A -- correctly noted as new |

### 1.2 Line Numbers and Code Snippets

All 8 `console.error` call sites verified against source. Every line number and code snippet in both the story and the plan matches the actual file content exactly:

| Plan Reference | Actual Line | Content Match |
|---|---|---|
| Line 690 | 690 | `console.error('[verify] Invalid or expired nonce', { device_id });` -- exact match |
| Line 701 | 701 | `console.error('[verify] Challenge expired', { device_id, nonce });` -- exact match |
| Line 711 | 711 | `console.error('[verify] Device ID mismatch', { device_id, expected: challenge.device_id });` -- exact match |
| Line 727 | 727 | `console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });` -- exact match |
| Line 741 | 741 | `console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });` -- exact match |
| Line 753 | 753 | `console.error('[verify] Invalid region_index', { region_index });` -- exact match |
| Line 769 | 769 | `console.error('[verify] Reference data not available for region', { region_index });` -- exact match |
| Line 782 | 782 | `console.error('[verify] HMAC mismatch', { region_index });` -- exact match |

Other line references verified:
- Line 63: `VERIFY_FAILED_MSG` constant -- correct
- Line 83: `this.logger = createLogger(env);` -- correct
- Line 671-821: `handleVerify()` method range -- correct
- Logger lines 186, 357, 371, 415, 456, 516, 587, 812, 850, 887: all `this.logger.*` calls verified at those exact lines
- `logger.js` lines 39-135, 41, 50-52, 115: all confirmed

### 1.3 Logger Behavior

The plan correctly identifies that `this.logger.warn()` delegates to `console.warn()` (logger.js line 98-105). The logger does NOT automatically redact metadata fields -- the `shouldRedact` property (line 50-52) is merely a flag available for callers. The plan's approach of omitting sensitive fields from metadata objects is the correct mitigation, not relying on any automatic redaction.

**Accuracy verdict: ACCURATE.** All references verified. No factual errors found.

---

## 2. Completeness

### 2.1 Proposed Fix Coverage

The plan covers all 8 `console.error()` calls within `handleVerify()`. The replacements are well-structured with consistent `action`/`reason` metadata patterns. The "before/after" pairs are clear and correct.

### 2.2 Acceptance Criteria Coverage

| Story AC | Plan Coverage | Test Coverage |
|---|---|---|
| All 8 console.error replaced | Steps 3.1-3.3 (all 8 covered) | Unit tests check logger.warn called |
| No device_id in prod logs | Metadata omits device_id | Unit test "should not leak sensitive data in any logger metadata fields" |
| No nonce in prod logs | Metadata omits nonce | Same unit test |
| No challenge.device_id in logs | Metadata omits expected field | Same unit test |
| Client responses unchanged | Plan explicitly preserves them | Unit test "should return generic error messages" |
| Debug logging available | Step 3.4 (optional) | Not explicitly tested |
| Zero remaining console.error | 8 replacements cover all console.error calls | E2E test checks no `[verify]` prefix in console.error |

### 2.3 Test Plan Coverage

The test plan is solid with three layers: unit tests, E2E additions, and manual testing. The unit tests cover the critical paths well:
- Invalid nonce path
- Expired challenge path
- Device ID mismatch path
- Reference binary not found path
- Metadata field audit (no device_id, nonce, expected)
- Client response consistency

### 2.4 Gaps Identified

**GAP 1 (Minor): Missing unit tests for lines 741, 753, 769, 782.**
The unit test suite in Section 4.1 only explicitly tests 4 of the 8 error paths (lines 690, 701, 711, 727). The remaining 4 paths (wrong response count, invalid region_index, reference data missing, HMAC mismatch) are not individually tested. These are lower sensitivity but the story AC says "all 8 error paths" should have test coverage. Section 8.1 also states "100% test coverage for all 8 modified error paths."

**GAP 2 (Minor): Debug-level logging (AC item 6) is marked optional with no test.**
The story's AC requires "Debug-level logging gated behind `this.logger.debug()` is available for development troubleshooting with full details." The plan marks this as optional (Step 3.4) and provides no test for it. If the implementer skips Step 3.4, this AC will not be met.

**GAP 3 (Minor): E2E test references `setupFullFlow()` helper without defining it.**
Section 4.2 references `const challenge = await setupFullFlow();` but does not define this helper. The existing `attestation.test.js` does not appear to export such a function. The implementer would need to either define it or adapt the test.

---

## 3. Risks

### 3.1 Inconsistent device_id Logging Across the File (MEDIUM)

The plan fixes `console.error` leakage in `handleVerify()`, but `device_id` is still logged via `this.logger.info()` and `this.logger.warn()` in multiple other locations in the same file:

- **Line 359**: `this.logger.warn('[audit] Web client rate limited', { device_id, ip: ... })`
- **Line 373**: `this.logger.info('[audit] Web device registered', { device_id, version, ip: ... })`
- **Line 417**: `this.logger.info('[audit] Device registered', { device_id, version, platform })`
- **Line 588**: `this.logger.warn('Behavioral anomaly: rapid attestation', { device_id, recentCount, ... })`
- **Line 814**: `this.logger.info('[audit] Attestation verified', { device_id })`

The success path at line 814 is particularly notable -- it logs `device_id` via the structured logger in the same method (`handleVerify`) that the plan is fixing. An implementer might reasonably question why `device_id` is being stripped from failure logs but retained in the success log.

This is technically outside the story's scope (the story focuses on `console.error` calls), but it creates an inconsistency: the threat model says `device_id` in logs enables tracking, yet the fix only addresses it in error paths. The story and plan should at minimum acknowledge this as a known limitation.

### 3.2 Logger Does Not Auto-Redact (LOW)

The `shouldRedact` flag on the logger is never used by the `warn()` or `info()` methods themselves. Redaction is entirely caller-responsibility. This means any future code that calls `this.logger.warn('...', { device_id })` will still leak the value. The plan does not propose any structural safeguard (e.g., a sanitization middleware in the logger).

This is acceptable for the scope of this story but should be noted as a pattern risk for future development.

### 3.3 No Runtime Verification of Log Output (LOW)

The tests verify that `logger.warn` is called with the correct arguments, but they do not verify what actually reaches `console.warn`. Since `logger.warn` passes metadata straight through to `console.warn`, the tests are a valid proxy. However, if the logger implementation changes (e.g., adds interpolation), the tests would not catch regressions at the console output level.

---

## 4. Recommended Changes

### Required Before Implementation

1. **Add unit tests for all 8 error paths.** The plan's test suite in Section 4.1 only covers 4 of 8 paths. Add explicit test cases for wrong response count (line 741), invalid region_index (line 753), reference data missing (line 769), and HMAC mismatch (line 782). These require setting up a valid challenge with reference data and submitting crafted responses, which is more complex but necessary to meet the plan's own "100% test coverage for all 8 modified error paths" metric.

2. **Define or reference the `setupFullFlow()` helper** in the E2E test additions (Section 4.2). Either include its implementation in the plan or reference an existing helper from the test file.

### Recommended (Non-Blocking)

3. **Decide on debug logging (Step 3.4).** Either commit to implementing it and add a test, or explicitly mark story AC item 6 as deferred. Currently the plan says "optional" but the story AC lists it as required.

4. **Add a note about existing `device_id` logging in success/audit paths.** Acknowledge that lines 359, 373, 417, 588, and 814 also log `device_id` via the structured logger. Either scope them into this story, create a follow-up story, or document why they are acceptable (e.g., audit logs for successful operations have a legitimate purpose and are controlled via the logger infrastructure).

5. **Consider a comment in the codebase** (e.g., near line 812 success log) noting that `device_id` is intentionally logged for audit purposes in success paths, to prevent a future contributor from either (a) adding it back to error paths or (b) removing it from the success path without understanding the distinction.

---

## 5. Summary

The plan is well-written, thorough, and technically correct. All file paths, line numbers, and code snippets have been verified against the actual source and are accurate. The proposed replacements correctly remove sensitive data from log output while preserving client-facing error responses and operational metadata.

The primary gaps are: (1) incomplete test coverage for the lower-sensitivity error paths (4 of 8 paths untested), (2) an undefined test helper in the E2E section, and (3) ambiguity around whether debug-level logging is required or optional. These are addressable without redesign.

The most significant risk is the inconsistent treatment of `device_id` logging -- the same field is stripped from error paths but retained in success/audit paths elsewhere in the same file. This does not invalidate the plan but should be documented as a known limitation with a follow-up story.

**Overall: PASS WITH NOTES.** Proceed with implementation after addressing the required changes (items 1 and 2 above).
