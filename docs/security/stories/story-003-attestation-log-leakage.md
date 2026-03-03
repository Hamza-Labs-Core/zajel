# Story 003: Fix console.error Information Leakage in Attestation Registry

## Priority: IMMEDIATE
## Severity: HIGH
## Component: packages/server (CF Workers)

## Summary

The `handleVerify()` method in `AttestationRegistryDO` uses raw `console.error()` calls that leak sensitive device identifiers (`device_id`), nonce values, and internal challenge state into Cloudflare Worker logs. These logs are accessible via the Cloudflare dashboard, `wrangler tail`, and any log drain integrations. An attacker with access to logs (insider threat, compromised Cloudflare account, or misconfigured log drain) could harvest device identifiers for tracking, replay nonce values if combined with timing attacks, or enumerate valid device IDs by correlating "Device ID mismatch" errors.

## Current Behavior

In `packages/server/src/durable-objects/attestation-registry-do.js`, the `handleVerify()` method (lines 671-821) contains 8 `console.error()` calls that directly log sensitive data. The Durable Object also has `this.logger` available (initialized on line 83 via `createLogger(env)`) which supports structured, level-aware logging -- but these specific error paths bypass it entirely and use raw `console.error()`:

**Line 690** -- Leaks `device_id`:
```javascript
console.error('[verify] Invalid or expired nonce', { device_id });
```

**Line 701** -- Leaks `device_id` AND `nonce`:
```javascript
console.error('[verify] Challenge expired', { device_id, nonce });
```

**Line 711** -- Leaks `device_id` AND the expected (valid) `device_id` from the challenge:
```javascript
console.error('[verify] Device ID mismatch', { device_id, expected: challenge.device_id });
```

**Line 727** -- Leaks `build_version` and `platform` (low sensitivity but still operational data):
```javascript
console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });
```

**Line 741** -- Leaks response counts (low sensitivity):
```javascript
console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });
```

**Line 753** -- Leaks `region_index` (low sensitivity):
```javascript
console.error('[verify] Invalid region_index', { region_index });
```

**Line 769** -- Leaks `region_index` (low sensitivity):
```javascript
console.error('[verify] Reference data not available for region', { region_index });
```

**Line 782** -- Leaks `region_index` (low sensitivity):
```javascript
console.error('[verify] HMAC mismatch', { region_index });
```

The most critical leaks are lines 690, 701, and 711, which expose:
- **`device_id`**: A persistent device identifier used throughout the attestation system for device tracking, challenge binding, and session token issuance.
- **`nonce`**: A one-time challenge value. While the nonce is deleted after use (line 720), logging it creates a secondary record that persists in log storage.
- **`challenge.device_id`**: Reveals which device_id was expected for a given nonce, enabling an attacker to correlate nonces with specific devices.

## Expected Behavior

All error logging should use `this.logger.warn()` or `this.logger.error()` from the structured logger (`packages/server/src/logger.js`). Sensitive identifiers should be redacted or omitted from log output. The logger's `shouldRedact` property (which checks `isProduction(env)`) should gate whether identifiers are included.

Error responses to clients already use generic messages (e.g., `VERIFY_FAILED_MSG = 'Verification failed'` defined on line 63), which is correct. The problem is purely in the server-side logging.

## Root Cause Analysis

The `handleVerify()` function was likely written before the structured logger was fully integrated. The rest of the file uses `this.logger.info()` and `this.logger.warn()` for audit events (e.g., lines 357, 371, 415, 456, 516, 812, 887), but the verification error paths use raw `console.error()`. This inconsistency suggests the verify handler was either written earlier or by a different contributor who did not follow the logging pattern established elsewhere in the same file.

The `createLogger()` function in `packages/server/src/logger.js` (lines 39-135) provides:
- Environment-aware log levels (line 41)
- A `shouldRedact` flag for production (line 50-52)
- Structured metadata support (`info(message, meta)` pattern)

None of these protections apply to raw `console.error()` calls.

Cloudflare Worker logs are retained and accessible via:
1. `wrangler tail` (real-time streaming to developer machines)
2. Cloudflare dashboard (Workers > Logs)
3. Log drain integrations (Datadog, Splunk, etc.)

Any of these surfaces could expose the leaked data.

## Affected Code

| File | Lines | Leaked Data | Sensitivity |
|------|-------|------------|-------------|
| `packages/server/src/durable-objects/attestation-registry-do.js` | 690 | `device_id` | HIGH |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 701 | `device_id`, `nonce` | HIGH |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 711 | `device_id`, `challenge.device_id` | HIGH |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 727 | `build_version`, `platform` | LOW |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 741 | response counts | LOW |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 753 | `region_index` | LOW |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 769 | `region_index` | LOW |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 782 | `region_index` | LOW |

Also note that `packages/server/src/logger.js` line 115 passes errors directly to `console.error`:
```javascript
error(message, error) {
  if (currentLevel <= 3) {
    console.error(`[ERROR] ${message}`, error || '');
  }
}
```
This means even `this.logger.error()` will still write to `console.error`, but the key difference is that callers should sanitize what they pass as metadata, and the structured pattern makes it clear what is being logged.

## Reproduction Steps

1. Deploy the CF Workers server to Cloudflare.
2. Register a device via `POST /attest/register`.
3. Request a challenge via `POST /attest/challenge`.
4. Submit an intentionally invalid verification via `POST /attest/verify` with a wrong nonce, wrong device_id, or wrong HMAC responses.
5. Monitor logs via `wrangler tail` or the Cloudflare dashboard.
6. Observe that `device_id`, `nonce`, and other sensitive values appear in plaintext in the log output.

## Impact Assessment

- **Device tracking**: Leaked `device_id` values in logs enable correlation of devices across verification attempts, potentially revealing usage patterns.
- **Nonce leakage**: Although nonces are single-use and deleted from storage after verification, their appearance in logs creates a secondary persistence layer. If an attacker can read logs in near-real-time (e.g., compromised log drain), they could potentially observe nonces before they are consumed.
- **Enumeration**: The "Device ID mismatch" error on line 711 logs BOTH the attacker-supplied `device_id` AND the legitimate `challenge.device_id`, enabling an attacker who can read logs to enumerate valid device IDs by submitting verification requests with guessed nonces.
- **Compliance risk**: Depending on jurisdiction, `device_id` may be considered personal data (e.g., under GDPR if it can be linked to a person). Logging it without purpose limitation or retention controls could be a compliance issue.

## Proposed Fix

Replace all `console.error()` calls in `handleVerify()` with `this.logger.warn()`, using the structured audit logging pattern already established in the rest of the file. Redact or omit sensitive identifiers:

```javascript
// Line 690 -- replace:
// console.error('[verify] Invalid or expired nonce', { device_id });
this.logger.warn('[audit] Verification failed: invalid or expired nonce', {
  action: 'attest_verify_failed',
  reason: 'invalid_nonce',
});

// Line 701 -- replace:
// console.error('[verify] Challenge expired', { device_id, nonce });
this.logger.warn('[audit] Verification failed: challenge expired', {
  action: 'attest_verify_failed',
  reason: 'challenge_expired',
});

// Line 711 -- replace:
// console.error('[verify] Device ID mismatch', { device_id, expected: challenge.device_id });
this.logger.warn('[audit] Verification failed: device ID mismatch', {
  action: 'attest_verify_failed',
  reason: 'device_mismatch',
});

// Line 727 -- replace:
// console.error('[verify] Reference binary not found', { version: ..., platform: ... });
this.logger.warn('[audit] Verification failed: reference binary not found', {
  action: 'attest_verify_failed',
  reason: 'reference_not_found',
});

// Lines 741, 753, 769, 782 -- similar pattern:
this.logger.warn('[audit] Verification failed: response validation error', {
  action: 'attest_verify_failed',
  reason: 'validation_error',
});
```

If debugging is needed in development, use `this.logger.debug()` with full details (it is suppressed in production where `LOG_LEVEL` defaults to `'info'`).

## Acceptance Criteria

- [ ] All 8 `console.error()` calls in `handleVerify()` are replaced with `this.logger.warn()` or `this.logger.error()`.
- [ ] No `device_id` values appear in log output for verification failures in production.
- [ ] No `nonce` values appear in log output for verification failures in production.
- [ ] No `challenge.device_id` (expected device ID) appears in log output.
- [ ] Error responses to clients remain unchanged (still use generic error messages).
- [ ] Debug-level logging (gated behind `this.logger.debug()`) is available for development troubleshooting with full details.
- [ ] Zero remaining `console.error` calls in `attestation-registry-do.js` -- all logging goes through `this.logger`.

## Test Requirements

- **Unit test**: Mock the logger and verify that `handleVerify()` calls `this.logger.warn()` (not `console.error`) for each failure path.
- **Unit test**: Verify that the log metadata for each failure path does NOT contain `device_id`, `nonce`, or `challenge.device_id` fields.
- **Unit test**: Verify that client-facing error responses remain unchanged after the logging fix.
- **Code review**: Audit all other files in `packages/server/src/durable-objects/` for raw `console.error()` calls that may leak sensitive data (ensure consistent use of `this.logger`).

## Dependencies

- None. This is a self-contained logging fix.
