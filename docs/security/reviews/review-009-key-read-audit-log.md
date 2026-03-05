# Review: Plan 009 - Add Audit Logging for Successful Key Reads

**Verdict: PASS WITH NOTES**

The plan is well-structured, technically sound, and the proposed changes are correct. The code modifications are minimal, additive, and follow existing patterns. A few minor inaccuracies in file references and one functional consideration are documented below.

---

## Accuracy

### File Paths: PASS

Both referenced files exist at the expected locations:
- `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`
- `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`
- `/home/meywd/zajel-ddos/packages/server/src/logger.js`

### Line Number References: PASS WITH NOTES

| Reference | Claimed | Actual | Status |
|-----------|---------|--------|--------|
| `getTrustedKeys` method | lines 986-1032 | lines 986-1032 | Correct |
| Failed auth logging | lines 994-998 (story) / 995-998 (story text) | lines 994-998 | Correct (story header says 995-998 but body says 994-998; actual is 994-998) |
| Decryption catch block | lines 1015-1020 | lines 1015-1020 | Correct |
| Success return statement | lines 1027-1031 | lines 1028-1031 | Off by one -- line 1027 is blank; the `return` starts at line 1028 |
| `setTrustedKeys` success audit log | lines 969-972 | lines 969-972 | Correct |
| `setTrustedKeys` failure audit log | lines 906-909 | lines 906-909 | Correct |
| `server_register` audit log | lines 619-625 | lines 619-625 | Correct |
| `server_unregister` audit log | lines 695-698 | lines 695-698 | Correct |
| `build_verify` audit log | lines 590-598 | lines 590-598 | Correct |
| `build_hash_changed` audit log | lines 758-764 | lines 758-764 | Correct |
| `anomaly_detected` audit log | lines 828-836 | lines 828-836 | Correct |
| Existing test describe block | `describe('GET /servers/trusted-keys')` after line 572 | line 524-572 | Correct |

### Code Snippets: PASS

The "Before" snippets in both Step 3.1 and Step 3.2 match the actual source code exactly. The proposed "After" snippets are syntactically correct and consistent with the existing codebase style.

### Test Describe Block Name: MINOR INACCURACY

The plan (Section 4.3) references `describe('Encryption/Decryption')` at line 678. The actual describe block is named `describe('Encrypted Storage')` at line 643. The plan should reference the correct block name. Furthermore, line 678 falls inside a test case within that block, not at the boundary of the describe block -- the block ends at line 763. New tests should be added before line 763 (the closing `});` of `describe('Encrypted Storage')`).

### Logger Compatibility: PASS

The logger's `error(message, error)` method accepts an object as the second argument (it is passed directly to `console.error`). The plan's proposed call with an object `{ action, ip, error }` is compatible. The `info(message, meta)` and `warn(message, meta)` methods also accept objects. Logger mocking via `registry.logger = mockLogger` is valid because `this.logger` is a plain instance property set in the constructor at line 299.

---

## Completeness

### Acceptance Criteria Coverage: PASS

| Acceptance Criterion (from Story) | Covered in Plan | Test Coverage |
|-----------------------------------|-----------------|---------------|
| Successful GET logged with `trusted_keys_read` | Step 3.1 | Test 4.1 |
| Log includes `keyCount` | Step 3.1 | Tests 4.1, 4.2 |
| Log includes `CF-Connecting-IP` | Step 3.1 | Tests 4.1, 4.2 |
| Log includes `updatedAt` | Step 3.1 | Test 4.1 |
| Decryption failure logged with `trusted_keys_decrypt_failed` | Step 3.2 | Test 4.3 |
| Existing `trusted_keys_read_failed` unaffected | No code change | Test 4.4 |
| Log format consistent with other audit logs | Verified in rationale | Pattern check |

### Test Plan Coverage: PASS

All five unit test requirements from the story are covered:
1. Successful read with correct `keyCount` -- Test 4.1
2. Decryption failure logging -- Test 4.3
3. IP from `CF-Connecting-IP` -- Tests 4.1, 4.3, 4.4
4. Failed auth regression -- Test 4.4
5. Empty key set with `keyCount: 0` -- Test 4.2

### Missing Test Case: NOTE

There is no test for the legacy plaintext (unencrypted) path where `raw.encrypted` is falsy but `raw` exists. The success audit log should still fire in this case. Adding a test that stores plaintext keys directly in `mockState.storage` and verifies the audit log would increase coverage of the legacy migration path. This is a "nice to have" rather than a gap, since the audit log fires unconditionally before the return regardless of the encryption path.

---

## Risks

### Risk Level: LOW (Agrees with Plan)

1. **No behavioral change**: The plan only adds `console.log`/`console.error` calls via the logger. These are non-blocking and cannot throw exceptions that would alter the request/response flow.

2. **No data leakage**: The log entries contain only metadata (`keyCount`, `updatedAt`, `ip`, `action`). The actual key values are not logged.

3. **Logger `error` parameter naming**: The `logger.error` method's second parameter is named `error` (suggesting an `Error` object), but the plan passes a plain object `{ action, ip, error }`. This works correctly because `console.error` accepts any value. However, if the logger implementation is ever refactored to extract `.message` or `.stack` from the second argument, this call would need updating. This is a very minor concern given that the existing codebase already passes objects to `logger.info` and `logger.warn` in the same way.

4. **`vi.useFakeTimers()` interaction**: The existing test setup uses `vi.useFakeTimers()` in `beforeEach`. The `updatedAt` value in Test 4.1 will be `0` (the faked time) unless `vi.setSystemTime()` is called or the test accounts for this. The test uses `expect.any(Number)` which will pass regardless, so this is not a functional issue, but the reviewer should be aware that `updatedAt` will not reflect a realistic timestamp in tests.

5. **Shared `mockState` across test instances**: Test 4.3 creates two `ServerRegistryDO` instances (`registry1`, `registry2`) sharing the same `mockState`. This is intentional and correct -- it simulates secret rotation where the encrypted data persists across instances. The test logic is sound.

---

## Recommended Changes

1. **Fix describe block name reference**: In Section 4.3, change `describe('Encryption/Decryption')` to `describe('Encrypted Storage')` and update the line reference from "after line 678" to "before line 763" (the closing of the describe block).

2. **Fix line reference in Step 3.1**: The plan says "Lines 1027-1031 (before the return statement)" but the `return` starts at line 1028. Line 1027 is a blank line. This is cosmetic but should be corrected for precision.

3. **Consider adding a legacy plaintext path test**: Add a test that stores keys in unencrypted format directly in storage, reads them via GET, and verifies the audit log fires with the correct `keyCount` and `updatedAt`. This covers the `else` branch at lines 1021-1025.

4. **Clarify mock logger completeness**: The `createLogger()` function returns an object with additional methods beyond `info`/`warn`/`error` (it also has `debug`, `pairingEvent`, `pairingCode`, and a `shouldRedact` getter). The mock loggers in the tests only include `info`, `warn`, and `error`. If any code path called during the test invokes `this.logger.debug()` (e.g., from routing logic), it would throw. Consider adding `debug: vi.fn()` to the mock logger objects for safety. This is unlikely to cause issues for these specific tests since the `getTrustedKeys` path does not call `debug`, but it is good defensive practice.

---

## Summary

The implementation plan is accurate, complete, and low-risk. The proposed code changes correctly add audit logging to both the success and decryption-failure paths of `getTrustedKeys`, following the established patterns in the codebase. The test plan covers all acceptance criteria from the story. The issues identified are minor (wrong describe block name, off-by-one line reference) and do not affect the correctness of the implementation. The plan is ready for implementation with the minor corrections noted above.
