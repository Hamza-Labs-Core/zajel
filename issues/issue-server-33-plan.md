# Plan: Attestation verify returns different errors for different failure modes

**Issue**: issue-server-33.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

In `packages/server/src/durable-objects/attestation-registry-do.js`, the `handleVerify` method (lines 388-522) returns distinct error messages for each failure mode:

- Line 404: `'Invalid or expired nonce'`
- Line 414: `'Challenge expired'`
- Line 423: `'Device ID mismatch'`
- Line 439: `'Reference binary no longer available'` (status 404)
- Line 452: `'Wrong number of responses'`
- Line 462: `'Invalid region_index: ${region_index}'`
- Line 477: `'Reference data not available for region'`
- Line 489: `'HMAC mismatch'`

Each distinct error message reveals to an attacker exactly where in the verification pipeline their request failed. This is an information leak that helps with targeted attacks against the attestation flow.

## Fix Steps

1. **Define a generic error message** as a constant near the top of the file (after line 36):

```js
/** Generic error message for all attestation verification failures */
const VERIFY_FAILED_MSG = 'Verification failed';
```

2. **Replace specific error messages with the generic one** in `handleVerify`. For each failure case, keep the specific reason in a server-side log but return the generic message to the client.

   Replace lines 400-493 with a pattern like:

```js
// Look up the challenge
const challenge = await this.state.storage.get(`nonce:${nonce}`);
if (!challenge) {
  console.error('[verify] Invalid or expired nonce', { device_id });
  return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
}

// Verify nonce hasn't expired
if (Date.now() - challenge.created_at > NONCE_TTL) {
  await this.state.storage.delete(`nonce:${nonce}`);
  console.error('[verify] Challenge expired', { device_id, nonce });
  return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
}

// Verify device_id matches
if (challenge.device_id !== device_id) {
  console.error('[verify] Device ID mismatch', { device_id, expected: challenge.device_id });
  return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
}

// Delete the nonce to prevent replay
await this.state.storage.delete(`nonce:${nonce}`);

// Look up reference binary
const reference = await this.state.storage.get(
  `reference:${challenge.build_version}:${challenge.platform}`
);
if (!reference) {
  console.error('[verify] Reference binary not found', { version: challenge.build_version, platform: challenge.platform });
  return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
}

// Verify response count
if (responses.length !== challenge.regions.length) {
  console.error('[verify] Wrong response count', { expected: challenge.regions.length, got: responses.length });
  return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
}

// Verify each response HMAC
for (const response of responses) {
  const { region_index, hmac } = response;
  if (region_index < 0 || region_index >= challenge.regions.length) {
    console.error('[verify] Invalid region_index', { region_index });
    return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
  }
  // ... rest of HMAC verification
  if (hmac !== expectedHmac) {
    console.error('[verify] HMAC mismatch', { region_index });
    return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
  }
}
```

3. **Keep consistent HTTP status**: Currently most failures return status 200 with `valid: false`, but lines 404 and 414 return 403, and line 439 returns 404. Normalize all verification failures to status 200 with `valid: false` to avoid leaking information through HTTP status codes. The initial input validation (missing fields) on line 393 can remain as 400.

## Testing

- Test that a valid verification request returns `{ valid: true, session_token: ... }`.
- Test each failure mode and verify they all return `{ valid: false, error: 'Verification failed' }` with status 200.
- Verify that server-side logs contain the specific failure reason for debugging.
- Ensure that the initial input validation (missing fields) still returns a 400 with a descriptive error.

## Risk Assessment

- **Low risk**: The change only affects error messages returned to clients. The internal verification logic is unchanged.
- **Debugging impact**: Without specific error messages, client-side debugging becomes harder. Mitigate this with clear server-side logging that includes request identifiers for correlation.
- **Status code normalization**: Changing 403 and 404 responses to 200 for verification failures may require client-side code updates if clients currently check for these specific status codes.
