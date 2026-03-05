# Story 013: NaN Input Validation Guards in Attestation

## Priority: THIS SPRINT
## Severity: HIGH
## Component: packages/server

## Summary

The attestation verification handler in `AttestationRegistryDO` performs bounds checking on `region_index` using comparison operators that silently pass for `NaN` values. In JavaScript, `NaN < 0` evaluates to `false` and `NaN >= n` also evaluates to `false`, meaning a `NaN` value bypasses both the lower and upper bounds checks. This allows an attacker to submit `region_index: NaN` (by sending a non-numeric value like `"abc"` or `undefined`) and potentially cause undefined behavior in downstream array access.

## Current Behavior

**Vulnerable bounds check** (`packages/server/src/durable-objects/attestation-registry-do.js`, lines 751-752):
```javascript
for (const response of responses) {
  const { region_index, hmac } = response;

  if (region_index < 0 || region_index >= challenge.regions.length) {
    console.error('[verify] Invalid region_index', { region_index });
    return this.jsonResponse(
      { valid: false, error: VERIFY_FAILED_MSG },
      200,
      corsHeaders
    );
  }

  const challengeRegion = challenge.regions[region_index];
  // ...
}
```

When `region_index` is `NaN`:
- `NaN < 0` evaluates to `false` -- lower bound check passes
- `NaN >= challenge.regions.length` evaluates to `false` -- upper bound check passes
- `challenge.regions[NaN]` evaluates to `undefined` -- the array access returns `undefined`
- On line 764, `refRegion` lookup via `.find()` will also fail since `challengeRegion` is `undefined`, causing `challengeRegion.offset` to throw a TypeError

This means the NaN bypass would result in a server-side TypeError crash at line 765 rather than a clean error response. While this doesn't lead to successful attestation bypass (the crash prevents the happy path), it does cause an unhandled exception that could:
1. Return a 500 Internal Server Error (leaking that the attestation system exists and its error structure)
2. Pollute error logs with attacker-controlled input
3. Potentially interact with the outer try-catch at line 179, masking the specific failure reason

**Other numeric inputs in the attestation flow**:

1. **`critical_regions` validation** (`attestation-registry-do.js`, lines 495-502):
   ```javascript
   for (const region of critical_regions) {
     if (typeof region.offset !== 'number' || typeof region.length !== 'number') {
       return this.jsonResponse(
         { error: 'Each critical_region must have numeric offset and length' },
         400,
         corsHeaders
       );
     }
   }
   ```
   This checks `typeof` but not `isNaN`. `typeof NaN === 'number'` is `true` in JavaScript, so `{ offset: NaN, length: NaN }` passes this validation. This poisoned data would be stored in DO storage and later cause `NaN` comparisons during challenge generation and verification.

2. **Connection metrics in server registry** (`server-registry-do.js`, lines 560-571):
   ```javascript
   const connections = typeof body.connections === 'number' && Number.isFinite(body.connections)
     ? Math.max(0, Math.floor(body.connections))
     : 0;
   ```
   This is correctly using `Number.isFinite()` which rejects `NaN`, `Infinity`, and `-Infinity`. This pattern should be applied consistently.

3. **Heartbeat metrics** (`server-registry-do.js`, lines 734-745):
   ```javascript
   if (typeof body.connections === 'number' && Number.isFinite(body.connections)) {
     server.connections = Math.max(0, Math.floor(body.connections));
   }
   ```
   Also correctly guarded with `Number.isFinite()`.

4. **`selectRandomRegions` count parameter** (`attestation-registry-do.js`, line 978):
   ```javascript
   selectRandomRegions(criticalRegions, count) {
     const selectCount = Math.min(count, criticalRegions.length);
   ```
   If `count` is `NaN`, then `Math.min(NaN, n)` returns `NaN`, and the `for` loop `for (let i = 0; i < NaN; i++)` never executes, returning an empty array. The calling code uses `MIN_CHALLENGE_REGIONS + Math.floor(Math.random() * ...)` which is always a valid number from `Math.random()`, so this is not directly exploitable. However, it is fragile.

5. **`MAX_NONCES_PER_DEVICE` comparison** (`attestation-registry-do.js`, line 608):
   ```javascript
   if (deviceNonceCount >= MAX_NONCES_PER_DEVICE) {
   ```
   `deviceNonceCount` is derived from a counter loop and is always a valid integer, so this is safe.

## Expected Behavior

1. All numeric inputs from request bodies should be validated with `Number.isFinite()` before being used in comparisons, arithmetic, or array indexing.
2. `region_index` should be explicitly validated as a non-negative integer before the bounds check.
3. `critical_regions[].offset` and `critical_regions[].length` should be validated with `Number.isFinite()` and non-negative integer checks.
4. All validation failures should return a clean 400 error, not rely on downstream crashes.

## Root Cause Analysis

The vulnerability stems from JavaScript's IEEE 754 floating-point semantics where `NaN` is not equal to, less than, or greater than any value (including itself). The bounds check pattern `if (x < 0 || x >= n)` is a common idiom in many languages but is subtly broken in JavaScript when `x` can be `NaN`.

The server registry's connection metrics correctly use `Number.isFinite()` (lines 560-571), indicating the developers are aware of this class of issue. However, this guard was not applied consistently to the attestation verification path, likely because the `region_index` was assumed to always be a number from the JSON parse.

In JSON, `NaN` is not a valid value, so `JSON.parse` cannot produce it directly. However, the destructured `region_index` can be `NaN` if:
- The response object lacks a `region_index` field (destructures to `undefined`, which is not `NaN` but would also bypass the check since `undefined < 0` is `false`)
- The field is a string like `"abc"` and then implicitly coerced to number in comparisons
- The field is `null` (which coerces to `0` in numeric comparisons -- this would pass the bounds check and index array at position 0)

The `typeof undefined < 0` case and `null` coercion are actually separate issues from `NaN`, but they share the same root cause: insufficient input validation before numeric operations.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `packages/server/src/durable-objects/attestation-registry-do.js` | 751-752 | `region_index` bounds check (NaN bypass) |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 761 | `challenge.regions[region_index]` array access |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 495-502 | `critical_regions` offset/length type check (NaN passes typeof) |
| `packages/server/src/durable-objects/attestation-registry-do.js` | 740 | `responses.length !== challenge.regions.length` count check |

## Reproduction Steps

1. **NaN region_index bypass**:
   ```bash
   # First, register a device and get a challenge
   # Then submit a verify request with NaN-inducing region_index:
   curl -X POST https://bootstrap.example.com/attest/verify \
     -H "Content-Type: application/json" \
     -d '{
       "device_id": "test-device",
       "nonce": "<valid-nonce>",
       "responses": [
         {"region_index": "not-a-number", "hmac": "deadbeef"},
         {"region_index": "also-not-a-number", "hmac": "deadbeef"},
         {"region_index": "still-not-a-number", "hmac": "deadbeef"}
       ]
     }'
   ```
   Expected: Clean 400 error with "Invalid region_index"
   Actual: 500 Internal Server Error (TypeError from undefined property access)

2. **null region_index coercion**:
   ```bash
   curl -X POST https://bootstrap.example.com/attest/verify \
     -H "Content-Type: application/json" \
     -d '{
       "device_id": "test-device",
       "nonce": "<valid-nonce>",
       "responses": [
         {"region_index": null, "hmac": "deadbeef"}
       ]
     }'
   ```
   `null` coerces to `0`, so this accesses `challenge.regions[0]` -- passing the bounds check.

3. **NaN in critical_regions upload**:
   ```bash
   curl -X POST https://bootstrap.example.com/attest/upload-reference \
     -H "Authorization: Bearer $CI_SECRET" \
     -H "Content-Type: application/json" \
     -d '{
       "version": "1.0.0",
       "platform": "android",
       "build_hash": "abc123",
       "critical_regions": [
         {"offset": "NaN", "length": 100, "data_hex": "deadbeef"}
       ]
     }'
   ```
   `typeof "NaN" !== 'number'` so this is actually caught. But `{ offset: null, length: 100 }` would pass since `typeof null !== 'number'` is also caught. However, if the JSON contains literal `NaN` via a non-standard parser, it would pass `typeof NaN === 'number'`.

## Impact Assessment

- **Information leak**: The 500 error from a NaN `region_index` reveals the server's internal error handling structure, confirming the attestation endpoint exists and processing logic.
- **Log pollution**: Attacker-controlled input ends up in error logs at `console.error('[verify] Invalid region_index', { region_index })` with crafted values.
- **Nonce consumption**: The nonce is deleted at line 720 (`await this.state.storage.delete(\`nonce:${nonce}\`)`) BEFORE the region_index validation on line 752. This means a NaN attack consumes the valid nonce, forcing the legitimate device to request a new challenge. This is a denial-of-service against the attestation flow: an attacker who knows a device's nonce can invalidate it by submitting a crafted response.
- **Poisoned reference data**: If `NaN` offset/length values are stored in reference data (via `upload-reference` with a non-standard JSON parser), all subsequent challenge verifications against that reference will produce incorrect HMAC computations.

## Proposed Fix

### 1. Add integer validation helper

```javascript
/**
 * Validate that a value is a non-negative integer.
 * Rejects NaN, Infinity, negative, fractional, and non-number types.
 */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}
```

### 2. Fix region_index validation

```javascript
for (const response of responses) {
  const { region_index, hmac } = response;

  if (!isNonNegativeInteger(region_index) || region_index >= challenge.regions.length) {
    console.error('[verify] Invalid region_index', { region_index });
    return this.jsonResponse(
      { valid: false, error: VERIFY_FAILED_MSG },
      200,
      corsHeaders
    );
  }
  // ...
}
```

### 3. Fix critical_regions validation

```javascript
for (const region of critical_regions) {
  if (!isNonNegativeInteger(region.offset) || !isNonNegativeInteger(region.length)) {
    return this.jsonResponse(
      { error: 'Each critical_region must have non-negative integer offset and length' },
      400,
      corsHeaders
    );
  }
  if (region.length === 0) {
    return this.jsonResponse(
      { error: 'critical_region length must be greater than 0' },
      400,
      corsHeaders
    );
  }
}
```

### 4. Move nonce deletion after all validation

```javascript
// Validate ALL responses before deleting the nonce
for (const response of responses) {
  if (!isNonNegativeInteger(response.region_index) || response.region_index >= challenge.regions.length) {
    return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
  }
  if (typeof response.hmac !== 'string' || response.hmac.length === 0) {
    return this.jsonResponse({ valid: false, error: VERIFY_FAILED_MSG }, 200, corsHeaders);
  }
}

// Delete nonce AFTER input validation passes (prevent DoS via nonce consumption)
await this.state.storage.delete(`nonce:${nonce}`);

// Now perform the actual HMAC verification
for (const response of responses) {
  // ...
}
```

## Acceptance Criteria

- [ ] `region_index` is validated as a non-negative integer using `Number.isFinite()` and `Number.isInteger()`
- [ ] `critical_regions[].offset` and `critical_regions[].length` are validated with `Number.isFinite()` and `Number.isInteger()`
- [ ] NaN, Infinity, -Infinity, null, undefined, and string values for `region_index` return a clean error response (not 500)
- [ ] Nonce deletion is moved after input validation to prevent nonce consumption DoS
- [ ] All numeric field validations in both DOs use the same `isNonNegativeInteger` helper for consistency
- [ ] The `isNonNegativeInteger` helper is extracted to a shared utility module

## Test Requirements

1. **NaN region_index**:
   - Submit `region_index: NaN` (via string field in JSON), verify clean error response
   - Submit `region_index: undefined` (missing field), verify clean error response
   - Submit `region_index: null`, verify clean error response (not silent coercion to 0)
   - Submit `region_index: -1`, verify clean error response
   - Submit `region_index: 1.5`, verify clean error response
   - Submit `region_index: Infinity`, verify clean error response

2. **Nonce preservation on invalid input**:
   - Submit an invalid response with a valid nonce
   - Verify the nonce is NOT consumed (can be reused for a valid submission)

3. **critical_regions validation**:
   - Upload reference with `offset: NaN`, verify 400
   - Upload reference with `length: 0`, verify 400
   - Upload reference with `offset: -1`, verify 400

4. **Valid inputs still work**:
   - Submit valid `region_index: 0`, `region_index: 1`, etc., verify they work correctly

## Dependencies

- Related: Story 014 (Security Test Coverage) -- NaN validation is a specific gap identified in the test coverage audit
- Blocks: None
