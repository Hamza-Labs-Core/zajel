# Story 014: Test Coverage for Replay, Rotation, and Race Conditions

## Priority: THIS SPRINT
## Severity: HIGH
## Component: packages/server

## Summary

The Cloudflare Worker server package (`packages/server/`) has **zero test files**. There are no unit tests, integration tests, or security-focused tests for any of the server's functionality -- including the rate limiter, server registry Durable Object, attestation registry Durable Object, cryptographic operations, build signature verification, anomaly detection, CORS handling, timing-safe comparison, or request validation. Critical security scenarios such as replay attacks, nonce reuse, key rotation, concurrent access races, HKDF edge cases, ciphertext tampering, and timing-safe comparison correctness have never been tested.

## Current Behavior

**Test file inventory** (`packages/server/`):
A recursive search for test files (`*.test.*`, `*.spec.*`) under `packages/server/` returns zero results. There is no `tests/`, `test/`, or `__tests__/` directory. No test framework configuration (vitest, jest, mocha, etc.) was found in the package.

This means:
- The `RateLimiter` class (`rate-limiter.js`) has no tests verifying window behavior, pruning, or boundary conditions.
- The `ServerRegistryDO` class (`server-registry-do.js`) has no tests for server registration, heartbeat, anomaly detection, build verification, or trusted key management.
- The `AttestationRegistryDO` class (`attestation-registry-do.js`) has no tests for device registration, challenge generation, HMAC verification, session token issuance, or version policy enforcement.
- The `timingSafeEqual` function (`timing-safe.js`) has no tests verifying constant-time behavior or correctness.
- The `parseJsonBody` function (`request-validation.js`) has no tests for size limit enforcement.
- The `BuildVerifier` object has no tests for Ed25519 signature verification, key encryption/decryption, or HKDF key derivation.
- The `AnomalyDetector` object has no tests for spike detection, drop detection, ghost server detection, or fleet outlier detection.
- The cryptographic attestation functions (`attestation.js`) have no tests for key import/export, nonce generation, HMAC computation, session token creation/verification, or version comparison.

## Expected Behavior

The server package should have comprehensive test coverage including:
1. **Unit tests** for every exported function and class
2. **Security-focused tests** for the specific attack vectors this server faces
3. **Edge case tests** for JavaScript-specific gotchas (NaN, prototype pollution, type coercion)
4. **Crypto correctness tests** with known test vectors

## Root Cause Analysis

The server was likely developed iteratively with manual testing via `wrangler dev` and curl commands, then deployed directly to Cloudflare Workers. The Durable Object pattern makes unit testing more complex than a standard Node.js application because:
1. Durable Objects have a specific lifecycle (`constructor(state, env)` + `fetch()` + `alarm()`) that requires mocking.
2. The `state.storage` API (`get`, `put`, `delete`, `list`) needs to be mocked or emulated.
3. Web Crypto API (`crypto.subtle`) is available in Workers but requires special handling in Node.js test environments.
4. The CORS, rate limiting, and routing in `index.js` depend on Worker-specific globals (`Request`, `Response`).

The `CLAUDE.md` mentions `npm run test --workspaces` but there is no test script defined for the `packages/server` workspace.

## Affected Code

All source files in `packages/server/src/` lack test coverage:

| File | Lines | Security-Relevant Functions |
|------|-------|---------------------------|
| `src/rate-limiter.js` | 57 | `check()`, `prune()` |
| `src/index.js` | 174 | Rate limit application, endpoint routing, response signing |
| `src/durable-objects/server-registry-do.js` | 1033 | `registerServer`, `heartbeat`, `setTrustedKeys`, `getTrustedKeys`, `AnomalyDetector.analyze`, `BuildVerifier.*` |
| `src/durable-objects/attestation-registry-do.js` | 1013 | `handleRegister`, `handleChallenge`, `handleVerify`, `selectRandomRegions`, `checkVersionPolicy` |
| `src/crypto/attestation.js` | 270 | `importVerifyKey`, `verifyBuildTokenSignature`, `computeHmac`, `createSessionToken`, `verifySessionToken`, `compareVersions` |
| `src/crypto/signing.js` | (not read, but referenced) | `importSigningKey`, `signPayload`, `hexToBytes` |
| `src/crypto/timing-safe.js` | 33 | `timingSafeEqual` |
| `src/utils/request-validation.js` | 49 | `parseJsonBody`, `BodyTooLargeError` |
| `src/cors.js` | 91 | `getCorsHeaders`, `isOriginAllowed` |
| `src/logger.js` | 138 | `redactPairingCode`, `createLogger` |

## Specific Security Test Gaps

### 1. Replay Attack Tests
- **Nonce reuse**: Verify that a nonce cannot be used twice in `POST /attest/verify`
- **Expired nonce**: Verify that nonces expire after `NONCE_TTL` (5 minutes)
- **Cross-device nonce**: Verify that device_id must match the nonce's owner
- **Build token replay**: Verify that the same build token can register a device again (intentional behavior), but token timestamp is checked

### 2. Key Rotation Tests
- **Trusted key replacement**: Verify that replacing keys via `{ keys: [...] }` invalidates old keys
- **Key addition/removal**: Verify `addKeys` and `removeKeys` operations are atomic
- **CI_UPLOAD_SECRET rotation**: Verify that changing the secret invalidates encrypted stored keys (graceful fallback to env var)
- **ATTESTATION_SIGNING_KEY rotation**: Verify that old session tokens are rejected after key change

### 3. Race Condition Tests
- **Concurrent heartbeats**: Two heartbeats for the same serverId arriving simultaneously (DO serialization should handle this, but untested)
- **Concurrent nonce creation**: Multiple challenge requests for the same device_id
- **Concurrent key updates**: Two `POST /servers/trusted-keys` requests arriving simultaneously
- **Alarm vs request**: Cleanup alarm running while a registration request is in flight

### 4. HKDF Edge Cases
- **Empty secret**: `BuildVerifier.deriveStorageKey('')` with empty string
- **Unicode secret**: Secret with multi-byte UTF-8 characters
- **Max-length secret**: Very long CI_UPLOAD_SECRET value

### 5. Ciphertext Tampering
- **Bit-flip in encrypted keys**: Modify a single byte of the encrypted trusted keys ciphertext, verify decryption fails gracefully
- **IV reuse detection**: Verify that each encryption uses a fresh random IV
- **Truncated ciphertext**: Shortened encrypted data should fail decryption, not crash

### 6. Timing-Safe Comparison
- **Correctness**: Verify `timingSafeEqual("abc", "abc")` returns `true` and `timingSafeEqual("abc", "abd")` returns `false`
- **Different lengths**: Verify `timingSafeEqual("ab", "abc")` returns `false` without leaking length via timing
- **Empty strings**: Verify `timingSafeEqual("", "")` returns `true`
- **Unicode**: Verify `timingSafeEqual` handles multi-byte characters correctly

### 7. Anomaly Detection
- **Metric spike**: History with stable connections, then 4x jump
- **Metric drop**: History with 100 connections, then drop to 10
- **Ghost server**: 11 consecutive zero-connection heartbeats
- **Fleet outlier**: Server reporting 1000 connections when fleet mean is 50
- **Score decay**: Verify exponential decay reduces score by 20% per heartbeat

### 8. Version Policy
- **Below minimum**: Version "0.9.0" when minimum is "1.0.0"
- **Blocked version**: Exact match in blocked list
- **Invalid semver**: Non-numeric version strings

## Proposed Test Framework Setup

### 1. Add vitest to packages/server

```json
// packages/server/package.json (add to devDependencies)
{
  "devDependencies": {
    "vitest": "^2.0.0"
  },
  "scripts": {
    "test": "vitest",
    "test:run": "vitest run"
  }
}
```

### 2. Create mock helpers for Durable Objects

```javascript
// tests/helpers/mock-do.js
export function createMockStorage() {
  const data = new Map();
  return {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => data.set(key, value),
    delete: async (keyOrKeys) => {
      if (Array.isArray(keyOrKeys)) {
        keyOrKeys.forEach(k => data.delete(k));
      } else {
        data.delete(keyOrKeys);
      }
    },
    list: async ({ prefix, limit } = {}) => {
      const result = new Map();
      for (const [key, value] of data) {
        if (!prefix || key.startsWith(prefix)) {
          result.set(key, value);
          if (limit && result.size >= limit) break;
        }
      }
      return result;
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
}

export function createMockState() {
  return {
    storage: createMockStorage(),
    blockConcurrencyWhile: (fn) => fn(),
  };
}

export function createMockEnv(overrides = {}) {
  return {
    SERVER_REGISTRY_SECRET: 'test-secret',
    CI_UPLOAD_SECRET: 'test-ci-secret',
    ATTESTATION_SIGNING_KEY: null,
    TRUSTED_BUILD_KEYS: '',
    DEV_MODE: 'false',
    ...overrides,
  };
}
```

### 3. Minimum test file list

```
tests/
  unit/
    rate-limiter.test.js
    timing-safe.test.js
    request-validation.test.js
    cors.test.js
    logger.test.js
    crypto/
      attestation.test.js
      signing.test.js
  security/
    replay-attack.test.js
    nan-validation.test.js
    key-rotation.test.js
    ciphertext-tampering.test.js
    anomaly-detection.test.js
    version-policy.test.js
  integration/
    server-registry-do.test.js
    attestation-registry-do.test.js
    build-verifier.test.js
```

## Acceptance Criteria

- [ ] Test framework (vitest) is configured in `packages/server/package.json`
- [ ] `npm run test --workspace=@zajel/server` (or equivalent) runs all tests
- [ ] Unit tests exist for every exported function in `rate-limiter.js`, `timing-safe.js`, `request-validation.js`, `cors.js`, `logger.js`
- [ ] Unit tests exist for `AnomalyDetector.analyze()` with at least 5 scenarios (spike, drop, ghost, outlier, no anomaly)
- [ ] Unit tests exist for `BuildVerifier.verifySignature()`, `encryptKeys()`, `decryptKeys()`, `loadTrustedKeys()`
- [ ] Unit tests exist for all crypto functions in `attestation.js`: `compareVersions`, `computeHmac`, `createSessionToken`, `verifySessionToken`
- [ ] Security test for nonce replay: verify a used nonce is rejected
- [ ] Security test for nonce expiry: verify an expired nonce is rejected
- [ ] Security test for cross-device nonce: verify device_id mismatch is rejected
- [ ] Security test for NaN region_index: verify clean error response
- [ ] Security test for ciphertext tampering: verify modified ciphertext fails decryption gracefully
- [ ] Security test for empty trusted keys: verify `buildVerified` behavior
- [ ] Integration tests for `ServerRegistryDO` covering register, heartbeat, list, unregister, and trusted keys CRUD
- [ ] Integration tests for `AttestationRegistryDO` covering register, challenge, verify, and version policy
- [ ] Code coverage report shows > 80% line coverage for all source files
- [ ] CI pipeline runs server tests as part of `npm run test --workspaces`

## Test Requirements

This story IS the test requirements. See the "Specific Security Test Gaps" section above for the detailed list of 30+ test cases that must be implemented.

## Dependencies

- Depends on: Story 013 (NaN Input Validation) -- some NaN tests will verify the fix from Story 013
- Depends on: Story 012 (Key Expiry) -- key rotation tests will verify the fix from Story 012
- Related: Story 011 (Per-Endpoint Rate Limiting) -- rate limiter tests should cover the new per-endpoint logic
