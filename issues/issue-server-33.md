# [MEDIUM] Attestation verify returns different errors for different failure modes

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:400-494
**Type**: Security

**Description**: The attestation verification handler provides granular error messages that differ based on the failure mode:
- "Invalid or expired nonce" (line 404)
- "Challenge expired" (line 414)
- "Device ID mismatch" (line 423)
- "Reference binary no longer available" (line 439)
- "Wrong number of responses" (line 452)
- "Invalid region_index: {N}" (line 463)
- "Reference data not available for region" (line 478)
- "HMAC mismatch" (line 489)

Each distinct error message reveals to an attacker exactly where in the verification pipeline their request failed.

**Impact**: An attacker gains detailed information about the server's internal state and verification logic. This helps enumerate valid device IDs, discover which build versions have reference data, and understand the exact structure expected. For a security-critical attestation flow, all failure modes should return the same generic error.

**Fix**: Return a single generic error for all verification failures:
```js
// After deleting the nonce, return the same error for all failure cases:
return this.jsonResponse({ valid: false, error: 'Verification failed' }, 200, corsHeaders);
```
Log the specific failure reason server-side for debugging.
