# Implementation Plan 009: Add Audit Logging for Successful Key Reads

**Story:** [Story 009: Add Audit Logging for Successful Key Reads](/home/meywd/zajel-ddos/docs/security/stories/story-009-key-read-audit-log.md)

**Priority:** THIS WEEK
**Severity:** MEDIUM
**Component:** packages/server (ServerRegistryDO)

---

## 1. Summary

The `getTrustedKeys` method in `ServerRegistryDO` currently logs failed authentication attempts (`trusted_keys_read_failed`) but does not log successful reads or decryption failures. This creates a blind spot in the security audit trail for access to trusted build signing keys, which are critical security assets.

This implementation plan adds two audit log entries:
1. **Success path**: Log when trusted keys are successfully read with `action: 'trusted_keys_read'`
2. **Decryption failure path**: Log when key decryption fails with `action: 'trusted_keys_decrypt_failed'`

The logging will be consistent with existing audit patterns in the codebase (e.g., `setTrustedKeys`, `server_register`, `server_unregister`).

---

## 2. Files to Modify

| File Path | Purpose |
|-----------|---------|
| `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | Add audit logging to `getTrustedKeys()` method (lines 986-1032) |
| `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` | Add unit tests to verify new logging behavior |

---

## 3. Implementation Steps

### Step 3.1: Add Audit Log for Successful Key Reads

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** Lines 1027-1031 (before the return statement)

**Before:**
```javascript
    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

**After:**
```javascript
    // Audit log: successful read
    this.logger.info('[audit] Trusted build keys read', {
      action: 'trusted_keys_read',
      keyCount: keys.length,
      updatedAt,
      ip: request.headers.get('CF-Connecting-IP'),
    });

    return new Response(
      JSON.stringify({ keys, updatedAt }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
```

**Rationale:**
- Follows the existing audit log pattern from `setTrustedKeys` (line 969-972)
- Includes `keyCount` to track how many keys were returned (useful for detecting empty key sets)
- Includes `updatedAt` timestamp to identify which key version was read
- Includes requester's IP address from `CF-Connecting-IP` header for forensic analysis
- Uses `this.logger.info()` consistent with other successful operations

---

### Step 3.2: Add Audit Log for Decryption Failures

**File:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**Location:** Lines 1015-1020 (catch block in decryption logic)

**Before:**
```javascript
        } catch {
          return new Response(
            JSON.stringify({ error: 'Failed to decrypt stored keys' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**After:**
```javascript
        } catch (err) {
          // Audit log: decryption failure (possible secret rotation or compromise)
          this.logger.error('[audit] Failed to decrypt trusted build keys', {
            action: 'trusted_keys_decrypt_failed',
            ip: request.headers.get('CF-Connecting-IP'),
            error: err?.message || 'unknown',
          });
          return new Response(
            JSON.stringify({ error: 'Failed to decrypt stored keys' }),
            { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
```

**Rationale:**
- Decryption failure is a critical security event (may indicate `CI_UPLOAD_SECRET` was rotated or compromised)
- Uses `this.logger.error()` appropriate for 500-level errors
- Captures error message for debugging (e.g., distinguishing crypto errors from data corruption)
- Includes IP address to identify the requester
- Uses `err?.message` to safely extract error details

---

## 4. Test Plan

### 4.1: Add Unit Test for Successful Key Read Audit Log

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** Add new test case in `describe('GET /servers/trusted-keys')` block (after line 572)

**Test Code:**
```javascript
it('should log successful key read with audit trail', async () => {
  // Mock the logger to capture log calls
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  // Replace logger with mock
  registry.logger = mockLogger;

  const authHeaders = {
    Authorization: 'Bearer ci-secret-123',
    'CF-Connecting-IP': '203.0.113.45',
  };

  // Upload keys
  await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [keypair.publicKeyBase64, 'another-key-base64'],
  }, authHeaders));

  // Clear previous log calls
  mockLogger.info.mockClear();

  // Read keys
  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
  const data = await response.json();

  expect(response.status).toBe(200);
  expect(data.keys).toHaveLength(2);

  // Verify audit log was called
  expect(mockLogger.info).toHaveBeenCalledWith(
    '[audit] Trusted build keys read',
    expect.objectContaining({
      action: 'trusted_keys_read',
      keyCount: 2,
      ip: '203.0.113.45',
      updatedAt: expect.any(Number),
    })
  );
});
```

**Expected Result:** Test passes, verifying that successful reads are logged with correct metadata.

---

### 4.2: Add Unit Test for Empty Key Set Read

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** Add new test case after the previous test

**Test Code:**
```javascript
it('should log keyCount: 0 when no keys are stored', async () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  registry.logger = mockLogger;

  const authHeaders = {
    Authorization: 'Bearer ci-secret-123',
    'CF-Connecting-IP': '203.0.113.45',
  };

  // Read keys without uploading any
  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
  const data = await response.json();

  expect(response.status).toBe(200);
  expect(data.keys).toHaveLength(0);

  // Verify audit log shows keyCount: 0
  expect(mockLogger.info).toHaveBeenCalledWith(
    '[audit] Trusted build keys read',
    expect.objectContaining({
      action: 'trusted_keys_read',
      keyCount: 0,
      ip: '203.0.113.45',
    })
  );
});
```

**Expected Result:** Test passes, confirming that reading an empty key set is logged correctly.

---

### 4.3: Add Unit Test for Decryption Failure Audit Log

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** Add new test case in `describe('Encryption/Decryption')` block (after line 678)

**Test Code:**
```javascript
it('should log decryption failure when wrong secret is used', async () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const registry1 = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'original-secret-123',
  });

  // Upload encrypted keys with original secret
  await registry1.fetch(createRequest('POST', '/servers/trusted-keys', {
    keys: [keypair.publicKeyBase64],
  }, {
    Authorization: 'Bearer original-secret-123',
  }));

  // Create new registry instance with DIFFERENT secret (simulating secret rotation)
  const registry2 = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'new-secret-456', // Different secret
  });

  registry2.logger = mockLogger;

  // Try to read keys with new secret (should fail to decrypt)
  const response = await registry2.fetch(createRequest('GET', '/servers/trusted-keys', null, {
    Authorization: 'Bearer new-secret-456',
    'CF-Connecting-IP': '203.0.113.45',
  }));

  expect(response.status).toBe(500);
  const data = await response.json();
  expect(data.error).toBe('Failed to decrypt stored keys');

  // Verify decryption failure was logged
  expect(mockLogger.error).toHaveBeenCalledWith(
    '[audit] Failed to decrypt trusted build keys',
    expect.objectContaining({
      action: 'trusted_keys_decrypt_failed',
      ip: '203.0.113.45',
      error: expect.any(String),
    })
  );
});
```

**Expected Result:** Test passes, verifying that decryption failures are logged with error details.

---

### 4.4: Regression Test for Failed Authentication Log

**File:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js`

**Location:** Add new test case after existing "should return 401 with wrong secret" test

**Test Code:**
```javascript
it('should still log failed authentication attempts (regression test)', async () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const registry = new ServerRegistryDO(mockState, {
    CI_UPLOAD_SECRET: 'ci-secret-123',
  });

  registry.logger = mockLogger;

  // Try to read keys without auth
  const response = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, {
    Authorization: 'Bearer wrong-secret',
    'CF-Connecting-IP': '198.51.100.77',
  }));

  expect(response.status).toBe(401);

  // Verify failed auth was logged (existing behavior)
  expect(mockLogger.warn).toHaveBeenCalledWith(
    '[audit] Unauthorized trusted-keys read attempt',
    expect.objectContaining({
      action: 'trusted_keys_read_failed',
      ip: '198.51.100.77',
    })
  );

  // Verify success log was NOT called
  expect(mockLogger.info).not.toHaveBeenCalledWith(
    '[audit] Trusted build keys read',
    expect.anything()
  );
});
```

**Expected Result:** Test passes, confirming that existing failure logging is not affected by the changes.

---

### 4.5: Manual Testing Checklist

After implementing and passing unit tests, perform manual testing:

1. **Deploy to QA environment** with `CI_UPLOAD_SECRET` configured
2. **Upload trusted keys** via `POST /servers/trusted-keys` with valid auth
3. **Read keys successfully** via `GET /servers/trusted-keys` with valid auth
4. **Check logs** for `[audit] Trusted build keys read` entry with:
   - `action: 'trusted_keys_read'`
   - Correct `keyCount`
   - Valid `updatedAt` timestamp
   - Requester's IP address
5. **Rotate the secret** (change `CI_UPLOAD_SECRET` in environment)
6. **Attempt to read keys** with the new secret
7. **Check logs** for `[audit] Failed to decrypt trusted build keys` entry with:
   - `action: 'trusted_keys_decrypt_failed'`
   - Error message
   - Requester's IP address
8. **Attempt unauthorized read** (wrong Bearer token)
9. **Check logs** for `[audit] Unauthorized trusted-keys read attempt` (existing behavior should remain unchanged)

---

## 5. Rollback Risk

**Risk Level:** LOW

**Justification:**
- This is a **purely additive change** — only adding log statements, not modifying existing logic
- No changes to request/response behavior
- No changes to authentication or authorization logic
- No changes to data storage or retrieval
- The logger calls are **non-blocking** and will not throw exceptions that affect the request flow

**Rollback Plan:**
If unexpected issues arise (e.g., excessive log volume, performance degradation):
1. Revert the two commits (code changes + tests)
2. Redeploy previous version
3. No data migration or state cleanup required

**Monitoring After Deployment:**
- Check log volume to ensure no unexpected increase
- Verify log entries are properly formatted and contain expected fields
- Monitor for any errors related to logger calls (unlikely but verify)

---

## 6. Dependencies on Other Stories

**No blocking dependencies.**

This story is **self-contained** and can be implemented independently. However, it complements:

- **Story 010** (if exists): Any future story related to key rotation monitoring would benefit from having these logs
- **Story 011** (if exists): Any audit log aggregation or alerting system would consume these new log entries

**Recommended Order:**
Implement this story early in the security sprint, as it provides foundational audit trail infrastructure that other security features may rely on.

---

## 7. Acceptance Criteria Checklist

- [ ] Successful `GET /servers/trusted-keys` requests are logged with action `trusted_keys_read`
- [ ] The log entry includes the number of keys returned (`keyCount`)
- [ ] The log entry includes the requester's IP address from `CF-Connecting-IP` header
- [ ] The log entry includes the `updatedAt` timestamp of the keys
- [ ] Decryption failures are logged with action `trusted_keys_decrypt_failed` including the error message and IP
- [ ] Existing failure logging (`trusted_keys_read_failed`) is not affected
- [ ] Log format is consistent with other audit log entries (using `this.logger.info('[audit] ...')` pattern)
- [ ] Unit tests pass for all new logging behavior
- [ ] Unit tests verify logger is called with correct parameters
- [ ] Regression test confirms existing auth failure logging still works
- [ ] Manual testing confirms logs appear correctly in QA environment

---

## 8. Implementation Timeline

**Estimated Effort:** 2-3 hours

- **Code Changes:** 30 minutes
  - Add 2 log statements in `server-registry-do.js`
- **Unit Tests:** 90 minutes
  - Write 4 new test cases with logger mocking
- **Manual Testing:** 30 minutes
  - Deploy to QA and verify log entries
- **Code Review:** 30 minutes

**Suggested Sprint:** Current sprint (THIS WEEK)

---

## 9. Security Impact

**Positive Security Impact:**
- **Audit completeness**: Closes gap in security audit trail for trusted key access
- **Incident response**: Provides forensic data for investigating key compromise scenarios
- **Compliance**: Meets typical security logging requirements for cryptographic key access
- **Operational visibility**: Enables detection of abnormal read patterns (e.g., frequent reads from unusual IPs)

**No Negative Security Impact:**
- No sensitive data is logged (keys themselves are not logged, only metadata)
- IP addresses are already logged for failed auth attempts
- No changes to authentication or authorization mechanisms

---

## 10. Related Documentation

- **Security Story:** [Story 009: Add Audit Logging for Successful Key Reads](/home/meywd/zajel-ddos/docs/security/stories/story-009-key-read-audit-log.md)
- **Source Code:** `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` (lines 986-1032)
- **Existing Tests:** `/home/meywd/zajel-ddos/packages/server/tests/unit/build-signing.test.js` (lines 524-572)
- **Logger Implementation:** `/home/meywd/zajel-ddos/packages/server/src/logger.js`

---

## 11. Implementation Notes

### Logger Mocking Pattern
The tests use Vitest's `vi.fn()` to mock logger methods. This pattern allows verification of log calls without actually writing to console:

```javascript
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
registry.logger = mockLogger;
```

### Error Handling Best Practice
The catch block captures the error object to log its message:

```javascript
} catch (err) {
  // Use err?.message with optional chaining for safety
  this.logger.error('[audit] ...', {
    error: err?.message || 'unknown',
  });
}
```

### CF-Connecting-IP Header
This header is automatically set by Cloudflare for all requests passing through their network. It contains the original client IP address (even behind proxies). This is the correct header to use for audit logging in Cloudflare Workers.

### Consistency with Existing Patterns
The new log entries follow the exact format used in `setTrustedKeys`:
- `'[audit]'` prefix for security-relevant events
- `action` field with snake_case action name
- Additional context fields (`keyCount`, `ip`, `updatedAt`)
- Use of `this.logger.info()` for successful operations
- Use of `this.logger.error()` for error conditions

---

**End of Implementation Plan**
